import { mkdirSync, lstatSync, existsSync, closeSync, openSync, constants } from 'node:fs'
import { join, resolve, dirname, relative, isAbsolute, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { CredentialVault, createPrivateFile, readPrivateFile } from './credential-vault.ts'
import { connectionAdapter } from './connection-adapters.ts'
import { defaultEndpointRules, pinEndpoint, requestPinnedJson, resolveAddresses, validateEndpoint } from './endpoint-policy.ts'
import type { EndpointRules, ProbeTransport, Resolver } from './endpoint-policy.ts'
import { credentialInput, exactFields, ManagementError, objectInput } from './management-types.ts'
import type { ManagedConnection, NetworkPolicy, TestResult } from './management-types.ts'

type Stored = { connection: ManagedConnection; cipher: string | null }
const unknownHealth = (): ManagedConnection['health'] => ({ authentication: 'unknown', discovery: 'never-tested', inference: 'never-tested', checkedAt: null })
const fields = ['label', 'baseUrl', 'networkPolicy', 'enabled', 'scope']
const credentialState = (providerId: string, present: boolean): ManagedConnection['credentials']['state'] => present ? 'configured' : connectionAdapter(providerId).credentiallessState
function label(value: unknown) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\x00-\x1f\x7f]/.test(value)) throw new ManagementError('INVALID_INPUT')
  return value.trim()
}
function scopeInput(value: unknown): ManagedConnection['scope'] {
  const input = objectInput(value); exactFields(input, ['account', 'project', 'region'])
  for (const v of [input.account, input.project, input.region]) if (v !== null && (typeof v !== 'string' || v.length > 200 || /[\x00-\x1f\x7f]/.test(v))) throw new ManagementError('INVALID_INPUT')
  return { account: input.account as string | null, project: input.project as string | null, region: input.region as string | null }
}
function revisionInput(value: number) { if (!Number.isSafeInteger(value) || value < 1) throw new ManagementError('INVALID_INPUT') }
function idInput(value: string) { if (typeof value !== 'string' || !/^[0-9a-f-]{36}$/.test(value)) throw new ManagementError('NOT_FOUND') }
function privateDirectory(directory: string) {
  const appRoot = fileURLToPath(new URL('../../', import.meta.url)), projectRoot = resolve(appRoot, '../..')
  const inProject = relative(projectRoot, directory), privateRoot = resolve(appRoot, '.local')
  if (!inProject.startsWith('..' + sep) && inProject !== '..' && !isAbsolute(inProject) && directory !== privateRoot && !directory.startsWith(privateRoot + sep)) throw new ManagementError('STORE_FAILED')
  // Do not traverse symlinked parents, including a replaced .local directory.
  const parents: string[] = []; let cursor = resolve(directory)
  while (dirname(cursor) !== cursor) { parents.push(cursor); cursor = dirname(cursor) }
  if (parents.some(path => existsSync(path) && lstatSync(path).isSymbolicLink())) throw new ManagementError('STORE_FAILED')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const stat = lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) throw new ManagementError('STORE_FAILED')
}

/** Local backend-only service. SQLite transactions serialize revisions across CLI processes. */
export class ConnectionManager {
  #directory: string
  #db: DatabaseSync
  #vault: CredentialVault
  #resolver: Resolver
  #transport: ProbeTransport
  #rules: EndpointRules
  #testing = new Set<string>()
  constructor(directory: string, options: { resolver?: Resolver; transport?: ProbeTransport; rules?: EndpointRules } = {}) {
    this.#resolver = options.resolver ?? resolveAddresses; this.#transport = options.transport ?? requestPinnedJson; this.#rules = options.rules ?? defaultEndpointRules
    directory = resolve(directory)
    privateDirectory(directory)
    this.#directory = directory
    const dbPath = join(directory, 'providers.sqlite'), keyPath = join(directory, 'master.key')
    if (!existsSync(keyPath)) {
      if (existsSync(dbPath)) throw new ManagementError('KEY_UNAVAILABLE')
      try { createPrivateFile(keyPath, randomBytes(32)) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new ManagementError('KEY_UNAVAILABLE') }
    }
    const key = readPrivateFile(keyPath)
    this.#vault = new CredentialVault(key); key.fill(0)
    let db: DatabaseSync | undefined
    try {
      if (!existsSync(dbPath)) {
        try { const fd = openSync(dbPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); closeSync(fd) }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
      }
      // Includes ownership, permissions, and symlink validation; content is not logged.
      const fd = openSync(dbPath, constants.O_RDONLY | constants.O_NOFOLLOW)
      try { const stat = lstatSync(dbPath); if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) throw new Error('unsafe database') } finally { closeSync(fd) }
      db = new DatabaseSync(dbPath)
      db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON;')
      const version = db.prepare('PRAGMA user_version').get() as { user_version: number }
      if (version.user_version > 1) throw new Error('unsupported schema')
      db.exec('BEGIN IMMEDIATE')
      try {
        db.exec('CREATE TABLE IF NOT EXISTS metadata (name TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS connections (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, data TEXT NOT NULL, cipher TEXT); CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, at TEXT NOT NULL, connection_id TEXT, action TEXT NOT NULL, code TEXT NOT NULL);')
        const check = db.prepare('SELECT value FROM metadata WHERE name=?').get('vault-check') as { value: string } | undefined
        if (check) { if (this.#vault.open(check.value, 'vault-check') !== 'nthn-provider-store-v1') throw new ManagementError('DECRYPT_FAILED') }
        else {
          if (Number((db.prepare('SELECT count(*) AS n FROM connections').get() as { n: number }).n)) throw new Error('missing verifier')
          db.prepare('INSERT INTO metadata VALUES (?, ?)').run('vault-check', this.#vault.seal('nthn-provider-store-v1', 'vault-check'))
        }
        db.exec('PRAGMA user_version=1; COMMIT')
      } catch (error) { db.exec('ROLLBACK'); throw error }
      this.#db = db
    } catch (error) { db?.close(); this.#vault.destroy(); throw error instanceof ManagementError ? error : new ManagementError('STORE_FAILED') }
  }
  close() { this.#db.close(); this.#vault.destroy() }
  #transaction<T>(operation: () => T): T {
    try {
      this.#db.exec('BEGIN IMMEDIATE')
      try { const result = operation(); this.#db.exec('COMMIT'); return result }
      catch (error) { this.#db.exec('ROLLBACK'); throw error }
    } catch (error) { throw error instanceof ManagementError ? error : new ManagementError('STORE_FAILED') }
  }
  #read(id: string): Stored {
    idInput(id)
    const row = this.#db.prepare('SELECT data, cipher FROM connections WHERE id=?').get(id) as { data: string; cipher: string | null } | undefined
    if (!row) throw new ManagementError('NOT_FOUND')
    return { connection: JSON.parse(row.data), cipher: row.cipher }
  }
  #expected(id: string, revision: number) {
    revisionInput(revision)
    const row = this.#read(id)
    if (row.connection.revision !== revision) throw new ManagementError('CONFLICT')
    return row
  }
  #audit(id: string | null, action: string, code = 'OK') { this.#db.prepare('INSERT INTO audit (at, connection_id, action, code) VALUES (?, ?, ?, ?)').run(new Date().toISOString(), id, action, code) }
  #write(row: Stored) {
    this.#db.prepare('INSERT INTO connections (id, revision, data, cipher) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision, data=excluded.data, cipher=excluded.cipher').run(row.connection.id, row.connection.revision, JSON.stringify(row.connection), row.cipher)
  }
  list(): ManagedConnection[] { return (this.#db.prepare('SELECT data FROM connections ORDER BY rowid').all() as { data: string }[]).map(row => JSON.parse(row.data)) }
  get(id: string): ManagedConnection { return this.#read(id).connection }
  audit() { return this.#db.prepare('SELECT at, connection_id AS connectionId, action, code FROM audit ORDER BY id DESC LIMIT 100').all() }
  add(input: unknown, secret: unknown = null): ManagedConnection {
    const data = objectInput(input); exactFields(data, ['providerId', ...fields])
    const adapter = connectionAdapter(data.providerId), key = credentialInput(secret)
    const network = (data.networkPolicy ?? 'public') as NetworkPolicy
    if (data.enabled !== undefined && typeof data.enabled !== 'boolean') throw new ManagementError('INVALID_INPUT')
    const connection: ManagedConnection = {
      id: randomUUID(), providerId: adapter.definition.id, label: label(data.label),
      baseUrl: validateEndpoint(data.baseUrl, network, adapter.definition.id, this.#rules), networkPolicy: network,
      scope: data.scope === undefined ? { account: null, project: null, region: null } : scopeInput(data.scope), enabled: data.enabled ?? false,
      revision: 1, credentials: { state: credentialState(adapter.definition.id, Boolean(key)), revision: key ? 1 : 0 }, health: unknownHealth(),
    }
    return this.#transaction(() => {
      this.#write({ connection, cipher: key ? this.#vault.seal(key, `${connection.id}:1`) : null }); this.#audit(connection.id, 'add'); return connection
    })
  }
  edit(id: string, revision: number, input: unknown): ManagedConnection {
    const data = objectInput(input); exactFields(data, fields)
    if (!Object.keys(data).length || (data.enabled !== undefined && typeof data.enabled !== 'boolean')) throw new ManagementError('INVALID_INPUT')
    return this.#transaction(() => {
      const row = this.#expected(id, revision), c = row.connection
      const network = (data.networkPolicy ?? c.networkPolicy) as NetworkPolicy
      const base = validateEndpoint(data.baseUrl ?? c.baseUrl, network, c.providerId, this.#rules)
      const endpointChanged = base !== c.baseUrl || network !== c.networkPolicy
      if (data.label !== undefined) c.label = label(data.label)
      if (data.scope !== undefined) c.scope = scopeInput(data.scope)
      if (typeof data.enabled === 'boolean') c.enabled = data.enabled
      c.baseUrl = base; c.networkPolicy = network; c.revision++
      if (endpointChanged) {
        row.cipher = null; c.credentials = { state: credentialState(c.providerId, false), revision: c.credentials.revision + 1 }; c.health = unknownHealth()
      }
      this.#write(row); this.#audit(id, endpointChanged ? 'edit.endpoint.credentials-cleared' : 'edit'); return c
    })
  }
  setEnabled(id: string, revision: number, enabled: boolean) { return this.edit(id, revision, { enabled }) }
  setCredential(id: string, revision: number, secret: unknown) {
    const key = credentialInput(secret)
    return this.#transaction(() => {
      const row = this.#expected(id, revision), c = row.connection
      c.revision++; c.credentials = { state: credentialState(c.providerId, Boolean(key)), revision: c.credentials.revision + 1 }; c.health = unknownHealth()
      row.cipher = key ? this.#vault.seal(key, `${id}:${c.credentials.revision}`) : null
      this.#write(row); this.#audit(id, key ? 'credential.replace' : 'credential.clear'); return c
    })
  }
  remove(id: string, revision: number) {
    this.#transaction(() => { this.#expected(id, revision); this.#db.prepare('DELETE FROM connections WHERE id=?').run(id); this.#audit(id, 'remove') })
  }
  /** Independent catalog DB; callers own its handle, never the credential database. */
  openCatalogDatabase(): DatabaseSync {
    privateDirectory(this.#directory)
    const path = join(this.#directory, 'catalog.sqlite')
    try {
      if (!existsSync(path)) { try { const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); closeSync(fd) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error } }
      const stat = lstatSync(path)
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) throw new Error('unsafe catalog')
      return new DatabaseSync(path)
    } catch { throw new ManagementError('STORE_FAILED') }
  }
  /** Fixed provider-owned listing path only; no plaintext credential getter. */
  async catalogPage(id: string, revision: number, query: Record<string, string> = {}) {
    const row = this.#expected(id, revision), c = row.connection, adapter = connectionAdapter(c.providerId)
    if (!c.enabled) throw new ManagementError('CONNECTION_DISABLED')
    exactFields(query, ['after', 'offset', 'limit', 'cursor', 'page', 'page_token', 'pageToken', 'output_modalities'])
    if (Object.values(query).some(value => typeof value !== 'string' || value.length > 16000)) throw new ManagementError('INVALID_INPUT')
    if (adapter.requiresCredential && !row.cipher) throw new ManagementError('CREDENTIAL_REQUIRED')
    const endpoint = await pinEndpoint(c.baseUrl, c.networkPolicy, c.providerId, this.#resolver, this.#rules)
    const key = row.cipher ? this.#vault.open(row.cipher, id + ':' + c.credentials.revision) : null
    let response
    try {
      const suffix = new URLSearchParams(query).toString()
      response = await this.#transport(endpoint, adapter.discoveryPath + (suffix ? '?' + suffix : ''), key, { maxBytes: 16 * 1024 * 1024 })
    } catch (error) { throw error instanceof ManagementError ? error : new ManagementError('REQUEST_FAILED') }
    this.#expected(id, revision)
    if (!this.#read(id).connection.enabled) throw new ManagementError('CONNECTION_DISABLED')
    if (response.status === 401 || response.status === 403) throw new ManagementError('AUTH_REJECTED')
    if (response.status === 404 || response.status === 405) throw new ManagementError('DISCOVERY_UNSUPPORTED')
    if (response.status === 429) throw new ManagementError('RATE_LIMITED')
    if (response.status >= 300 && response.status < 400) throw new ManagementError('REDIRECT_BLOCKED')
    if (response.status < 200 || response.status >= 300) throw new ManagementError('PROBE_FAILED')
    if (key) {
      const pending: unknown[] = [response.body, response.link], seen = new WeakSet<object>()
      while (pending.length) {
        const value = pending.pop()
        if (typeof value === 'string' && value.includes(key)) throw new ManagementError('INVALID_RESPONSE')
        if (value && typeof value === 'object' && !seen.has(value)) {
          seen.add(value)
          for (const [name, child] of Object.entries(value)) { pending.push(name, child) }
        }
      }
    }
    return { body: response.body, link: response.link ?? null }
  }
  recordDiscovery(id: string, revision: number, succeeded: boolean, code: string) {
    this.#transaction(() => {
      const row = this.#expected(id, revision)
      row.connection.health.discovery = succeeded ? 'succeeded' : code === 'DISCOVERY_UNSUPPORTED' ? 'unsupported' : 'failed'
      row.connection.health.checkedAt = new Date().toISOString()
      if (code === 'AUTH_REJECTED') row.connection.health.authentication = 'rejected'
      this.#write(row); this.#audit(id, 'catalog.refresh', succeeded ? 'OK' : new ManagementError(code).code)
    })
  }
  async test(id: string, revision: number): Promise<TestResult> {
    if (this.#testing.has(id)) throw new ManagementError('TEST_BUSY')
    const row = this.#expected(id, revision), c = row.connection, adapter = connectionAdapter(c.providerId)
    this.#testing.add(id)
    let health = unknownHealth(), code = 'OK', ok = false
    try {
      if (adapter.requiresCredential && !row.cipher) throw new ManagementError('CREDENTIAL_REQUIRED')
      const endpoint = await pinEndpoint(c.baseUrl, c.networkPolicy, c.providerId, this.#resolver, this.#rules)
      const key = row.cipher ? this.#vault.open(row.cipher, `${id}:${c.credentials.revision}`) : null
      if (adapter.requiresCredential && !key) throw new ManagementError('CREDENTIAL_REQUIRED')
      const result = await this.#transport(endpoint, adapter.probePath, key)
      health = { ...health, ...adapter.interpret(result), checkedAt: new Date().toISOString() }; ok = true
    } catch (error) {
      code = error instanceof ManagementError ? error.code : 'REQUEST_FAILED'
      health = { ...health, checkedAt: new Date().toISOString(), ...(code === 'AUTH_REJECTED' ? { authentication: 'rejected' as const } : {}) }
      if (adapter.probeKind === 'discovery') health.discovery = 'failed'
    } finally { this.#testing.delete(id) }
    const connection = this.#transaction(() => {
      const current = this.#expected(id, revision)
      current.connection.health = health; this.#write(current); this.#audit(id, 'test', code)
      return current.connection
    })
    return { connection, ok, code }
  }
}
