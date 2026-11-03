import { initializeVerification, latestVerification } from './verification-store.ts'
import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import type { CatalogEntry, CatalogPage, CatalogQuery, CatalogRefresh } from './contracts.ts'
import type { ManagedConnection } from './management-types.ts'
import { ManagementError } from './management-types.ts'
import { ConnectionManager } from './connection-manager.ts'
import { modelRouteKey } from './route-identity.ts'
import { connectionAdapter } from './connection-adapters.ts'

export type RefreshStatus = CatalogRefresh & { modelsSeen: number; nextAttemptAt: number; failures: number; leaseExpiresAt: number }
type Row = { data: string }
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export class CatalogStore {
  #db: DatabaseSync
  constructor(manager: ConnectionManager) {
    this.#db = manager.openCatalogDatabase()
    try {
      this.#db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;')
      const version = this.#db.prepare('PRAGMA user_version').get() as { user_version: number }
      if (version.user_version > 1) throw new Error('unsupported catalog')
      initializeVerification(this.#db)
      this.#db.exec(`CREATE TABLE IF NOT EXISTS meta (id INTEGER PRIMARY KEY, epoch INTEGER NOT NULL);
        INSERT OR IGNORE INTO meta VALUES (1, 0);
        CREATE TABLE IF NOT EXISTS routes (id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, provider_id TEXT NOT NULL, native_id TEXT NOT NULL, name TEXT NOT NULL, data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS routes_connection ON routes(connection_id);
        CREATE INDEX IF NOT EXISTS routes_provider ON routes(provider_id);
        CREATE TABLE IF NOT EXISTS refreshes (id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS refresh_connection ON refreshes(connection_id);
        CREATE TABLE IF NOT EXISTS active (connection_id TEXT PRIMARY KEY, refresh_id TEXT NOT NULL, expires INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS staging (refresh_id TEXT NOT NULL, route_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(refresh_id, route_id));
        PRAGMA user_version=1;`)
    } catch { this.#db.close(); throw new ManagementError('STORE_FAILED') }
  }
  close() { this.#db.close() }
  #transaction<T>(callback: () => T): T {
    try {
      this.#db.exec('BEGIN IMMEDIATE')
      try { const result = callback(); this.#db.exec('COMMIT'); return result } catch (error) { this.#db.exec('ROLLBACK'); throw error }
    } catch (error) { throw error instanceof ManagementError ? error : new ManagementError('STORE_FAILED') }
  }
  #epoch() { this.#db.exec('UPDATE meta SET epoch=epoch+1 WHERE id=1') }
  #save(status: RefreshStatus) { this.#db.prepare('UPDATE refreshes SET data=? WHERE id=?').run(JSON.stringify(status), status.id) }
  statuses(): RefreshStatus[] {
    return (this.#db.prepare('SELECT r.data FROM refreshes r WHERE rowid=(SELECT max(rowid) FROM refreshes WHERE connection_id=r.connection_id) ORDER BY r.rowid').all() as Row[]).map(row => JSON.parse(row.data))
  }
  begin(connection: ManagedConnection, now = Date.now()): RefreshStatus {
    return this.#transaction(() => {
      const active = this.#db.prepare('SELECT refresh_id, expires FROM active WHERE connection_id=?').get(connection.id) as { refresh_id: string; expires: number } | undefined
      if (active) {
        if (active.expires > now) throw new ManagementError('CATALOG_BUSY')
        const old = JSON.parse((this.#db.prepare('SELECT data FROM refreshes WHERE id=?').get(active.refresh_id) as Row).data) as RefreshStatus
        old.state = old.modelsSeen ? 'partial' : 'failed'; old.errorCode = 'REFRESH_INTERRUPTED'; old.completedAt = new Date(now).toISOString()
        this.#save(old); this.#db.prepare('DELETE FROM staging WHERE refresh_id=?').run(old.id)
        this.#db.prepare('DELETE FROM active WHERE connection_id=?').run(connection.id); this.#epoch()
      }
      const previous = this.statuses().find(status => status.connectionId === connection.id)
      const status: RefreshStatus = { id: randomUUID(), connectionId: connection.id, connectionRevision: connection.revision, state: 'running', cursor: null, startedAt: new Date(now).toISOString(), completedAt: null, errorCode: previous?.errorCode ?? null, modelsSeen: 0, nextAttemptAt: 0, failures: previous?.failures ?? 0, leaseExpiresAt: now + 60000 }
      this.#db.prepare('INSERT INTO refreshes (id, connection_id, data) VALUES (?, ?, ?)').run(status.id, connection.id, JSON.stringify(status))
      this.#db.prepare('INSERT INTO active VALUES (?, ?, ?)').run(connection.id, status.id, now + 60000)
      return status
    })
  }
  #owned(status: RefreshStatus) {
    const active = this.#db.prepare('SELECT refresh_id FROM active WHERE connection_id=?').get(status.connectionId) as { refresh_id: string } | undefined
    if (active?.refresh_id !== status.id) throw new ManagementError('CONFLICT')
  }
  stage(status: RefreshStatus, entries: CatalogEntry[], cursor: string | null): number {
    return this.#transaction(() => {
      this.#owned(status)
      const before = Number((this.#db.prepare('SELECT count(*) AS n FROM staging WHERE refresh_id=?').get(status.id) as { n: number }).n)
      const insert = this.#db.prepare('INSERT INTO staging VALUES (?, ?, ?) ON CONFLICT(refresh_id, route_id) DO UPDATE SET data=excluded.data')
      for (const entry of entries) insert.run(status.id, entry.route.id, JSON.stringify(entry))
      status.modelsSeen = Number((this.#db.prepare('SELECT count(*) AS n FROM staging WHERE refresh_id=?').get(status.id) as { n: number }).n)
      status.cursor = cursor; status.leaseExpiresAt = Date.now() + 60000; this.#save(status)
      this.#db.prepare('UPDATE active SET expires=? WHERE connection_id=?').run(Date.now() + 60000, status.connectionId)
      return status.modelsSeen - before
    })
  }
  finish(status: RefreshStatus, errorCode: string | null, intervalMs: number): RefreshStatus {
    return this.#transaction(() => {
      this.#owned(status)
      const now = Date.now()
      status.completedAt = new Date(now).toISOString(); status.errorCode = errorCode; status.leaseExpiresAt = 0
      status.state = errorCode ? errorCode === 'DISCOVERY_UNSUPPORTED' ? 'unsupported' : status.modelsSeen ? 'partial' : 'failed' : 'complete'
      status.failures = errorCode ? status.failures + 1 : 0
      status.nextAttemptAt = now + (errorCode ? Math.min(3600000, 60000 * 2 ** Math.min(status.failures - 1, 6)) : intervalMs)
      if (!errorCode) {
        // Only an exhaustive, successful refresh may retire unseen routes.
        const existing = this.#db.prepare('SELECT id, data FROM routes WHERE connection_id=?').all(status.connectionId) as { id: string; data: string }[]
        for (const row of existing) {
          if (this.#db.prepare('SELECT 1 FROM staging WHERE refresh_id=? AND route_id=?').get(status.id, row.id)) continue
          const entry = JSON.parse(row.data) as CatalogEntry
          if (entry.route.model.evidence.source === 'operator') continue
          entry.route.lifecycle = 'removed'; entry.route.access = { state: 'unavailable', evidence: { source: 'provider-api', observedAt: status.completedAt, reference: 'complete-catalog-refresh' } }
          this.#db.prepare('UPDATE routes SET data=? WHERE id=?').run(JSON.stringify(entry), row.id)
        }
        const staged = this.#db.prepare('SELECT data FROM staging WHERE refresh_id=?').iterate(status.id)
        const upsert = this.#db.prepare('INSERT INTO routes VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET provider_id=excluded.provider_id, native_id=excluded.native_id, name=excluded.name, data=excluded.data')
        for (const row of staged) {
          const entry = JSON.parse(String(row.data)) as CatalogEntry
          const previous = this.#db.prepare('SELECT data FROM routes WHERE id=?').get(entry.route.id) as Row | undefined
          if (previous) entry.firstSeenAt = (JSON.parse(previous.data) as CatalogEntry).firstSeenAt
          upsert.run(entry.route.id, status.connectionId, entry.route.providerId, entry.route.ref.nativeModelId, entry.route.model.displayName, JSON.stringify(entry))
        }
      }
      this.#save(status); this.#db.prepare('DELETE FROM staging WHERE refresh_id=?').run(status.id)
      this.#db.prepare('DELETE FROM active WHERE connection_id=?').run(status.connectionId); this.#epoch()
      return status
    })
  }
  addManual(connection: ManagedConnection, nativeId: string, displayName: string): CatalogEntry {
    if (!nativeId.trim() || nativeId.length > 500 || /[\x00-\x1f\x7f]/.test(nativeId) || !displayName.trim() || displayName.length > 200 || /[\x00-\x1f\x7f]/.test(displayName)) throw new ManagementError('INVALID_INPUT')
    const now = new Date().toISOString(), ref = { connectionId: connection.id, nativeModelId: nativeId.trim(), upstreamEndpointId: null }
    const id = modelRouteKey(ref)
    return this.#transaction(() => {
      const existing = this.#db.prepare('SELECT data FROM routes WHERE id=?').get(id) as Row | undefined
      const evidence = { source: 'operator' as const, observedAt: now, reference: connection.id }
      if (existing) {
        const entry = JSON.parse(existing.data) as CatalogEntry
        if (entry.route.connectionRevision === connection.revision && entry.route.lifecycle === 'active') return entry
        entry.route.connectionRevision = connection.revision
        entry.route.model.displayName = displayName.trim()
        entry.route.model.evidence = evidence
        entry.route.access = { state: 'listed', evidence }
        entry.route.lifecycle = 'active'
        entry.lastSeenAt = now
        this.#db.prepare('UPDATE routes SET name=?, data=? WHERE id=?').run(entry.route.model.displayName, JSON.stringify(entry), id)
        this.#epoch()
        return entry
      }
      const entry: CatalogEntry = { route: { id, ref, providerId: connection.providerId, protocol: connectionAdapter(connection.providerId).protocol, connectionRevision: connection.revision,
        model: { displayName: displayName.trim(), capabilities: { input: null, output: null, tools: 'unknown', streaming: 'unknown', structuredOutput: 'unknown', systemInstructions: 'unknown' }, contextTokens: null, maxOutputTokens: null, evidence, extensions: {} },
        access: { state: 'listed', evidence }, lifecycle: 'active' }, pricing: { components: [], completeness: 'unknown', evidence: null, freeAccess: { kind: 'unknown', eligibility: 'unknown', conditions: [], evidence: null } }, limits: [], firstSeenAt: now, lastSeenAt: now }
      this.#db.prepare('INSERT INTO routes VALUES (?, ?, ?, ?, ?, ?)').run(id, connection.id, connection.providerId, ref.nativeModelId, entry.route.model.displayName, JSON.stringify(entry))
      this.#epoch()
      return entry
    })
  }
  #decorate(entry: CatalogEntry, connections: ManagedConnection[], statuses: RefreshStatus[]): CatalogEntry {
    const connection = connections.find(item => item.id === entry.route.ref.connectionId)
    const status = statuses.find(item => item.connectionId === entry.route.ref.connectionId)
    const manual = entry.route.model.evidence.source === 'operator'
    if (!connection || !connection.enabled || connection.revision !== entry.route.connectionRevision || (!manual && status?.errorCode)) {
      entry.route.access = { state: 'unavailable', evidence: null }
      if (!connection) entry.route.lifecycle = 'removed'
    }
    const verification = latestVerification(this.#db, entry.route.id)
    entry.verification = verification
    if (connection?.enabled && connection.revision === entry.route.connectionRevision && (manual || !status?.errorCode) && entry.route.lifecycle !== 'removed' && verification?.connectionRevision === connection.revision && verification.state !== 'untested') {
      entry.route.access = { state: verification.state === 'verified' ? 'verified' : 'unavailable', evidence: { source: verification.state === 'verified' ? 'inference-response' : 'operator', observedAt: verification.checkedAt, reference: verification.id } }
    }
    return entry
  }
  get(id: string, connections: ManagedConnection[]): CatalogEntry | null { return this.#transaction(() => this.#get(id, connections)) }
  #get(id: string, connections: ManagedConnection[]): CatalogEntry | null {
    const row = this.#db.prepare('SELECT data FROM routes WHERE id=?').get(id) as Row | undefined
    return row ? this.#decorate(JSON.parse(row.data), connections, this.statuses()) : null
  }
  search(query: CatalogQuery, connections: ManagedConnection[]): CatalogPage { return this.#transaction(() => this.#search(query, connections)) }
  #search(query: CatalogQuery, connections: ManagedConnection[]): CatalogPage {
    if (!query || typeof query !== 'object' || Array.isArray(query)) throw new ManagementError('INVALID_INPUT')
    const allowed = ['search', 'connectionIds', 'providerIds', 'outputModality', 'freeAccessKinds', 'cursor', 'pageSize']
    if (Object.keys(query).some(key => !allowed.includes(key))) throw new ManagementError('INVALID_INPUT')
    const size = query.pageSize ?? 100
    if (!Number.isInteger(size) || size < 1 || size > 1000 || (query.search !== undefined && (typeof query.search !== 'string' || query.search.length > 2000)) || (query.outputModality !== undefined && typeof query.outputModality !== 'string')) throw new ManagementError('INVALID_INPUT')
    for (const list of [query.connectionIds, query.providerIds, query.freeAccessKinds]) if (list !== undefined && (!Array.isArray(list) || list.some(item => typeof item !== 'string'))) throw new ManagementError('INVALID_INPUT')
    const { cursor: _cursor, ...filters } = query
    const epoch = (this.#db.prepare('SELECT epoch FROM meta WHERE id=1').get() as { epoch: number }).epoch
    const verificationEpoch = (this.#db.prepare('SELECT coalesce(max(sequence), 0) AS n FROM model_verifications').get() as { n: number }).n
    const snapshotId = digest([epoch, verificationEpoch, connections.map(c => [c.id, c.revision, c.enabled]).sort(), filters])
    let after = ''
    if (query.cursor !== undefined) {
      try {
        if (typeof query.cursor !== 'string' || query.cursor.length > 200000) throw new Error('cursor')
        const decoded = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'))
        if (decoded.snapshotId !== snapshotId) throw new ManagementError('CATALOG_CHANGED')
        if (typeof decoded.after !== 'string') throw new Error('cursor')
        after = decoded.after
      } catch (error) { throw error instanceof ManagementError ? error : new ManagementError('INVALID_INPUT') }
    }
    const conditions: string[] = [], params: SQLInputValue[] = []
    if (query.search) {
      const term = '%' + query.search.replace(/[\\%_]/g, '\\$&') + '%'
      conditions.push("(native_id LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\')"); params.push(term, term)
    }
    for (const [list, column] of [[query.connectionIds, 'connection_id'], [query.providerIds, 'provider_id']] as const) if (list) {
      if (!list.length) conditions.push('0')
      else { conditions.push(column + ' IN (' + list.map(() => '?').join(',') + ')'); params.push(...list) }
    }
    if (query.outputModality) { conditions.push("EXISTS (SELECT 1 FROM json_each(json_extract(data, '$.route.model.capabilities.output')) WHERE value=?)"); params.push(query.outputModality) }
    if (query.freeAccessKinds) {
      if (!query.freeAccessKinds.length) conditions.push('0')
      else { conditions.push("json_extract(data, '$.pricing.freeAccess.kind') IN (" + query.freeAccessKinds.map(() => '?').join(',') + ')'); params.push(...query.freeAccessKinds) }
    }
    const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : ''
    const total = Number((this.#db.prepare('SELECT count(*) AS n FROM routes' + where).get(...params) as { n: number }).n)
    const rows = this.#db.prepare('SELECT data FROM routes' + where + (where ? ' AND ' : ' WHERE ') + 'id>? ORDER BY id LIMIT ?').all(...params, after, size + 1) as Row[]
    const more = rows.length > size, statuses = this.statuses()
    const entries = rows.slice(0, size).map(row => this.#decorate(JSON.parse(row.data), connections, statuses))
    return { entries, total, snapshotId, nextCursor: more ? Buffer.from(JSON.stringify({ snapshotId, after: entries.at(-1)!.route.id })).toString('base64url') : null }
  }
}
