import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, chmodSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { JefMemory, MemoryKind } from './memory.ts'

export interface EmbeddingProvider { embed(text: string): Promise<number[]> }
export interface MemoryStoreLike {
  list(scope: string): JefMemory[]
  relevant(scope: string, query: string, limit?: number): JefMemory[]
  semanticRelevant?(scope: string, query: string, limit?: number): Promise<JefMemory[]>
  link?(from: string, to: string, relation: string): Promise<void>
  links?(id: string): Array<{ from: string; to: string; relation: string }>
  history?(id: string): Array<{ action: string; at: string; snapshot: JefMemory }>
  export?(scope: string): JefMemory[]
  add(input: { scope: string; kind: MemoryKind; text: string; source: string; sourcePath?: string }): Promise<JefMemory>
  update(id: string, patch: { text?: string; pinned?: boolean }): Promise<JefMemory>
  remove(id: string): Promise<void>
}

const KINDS = new Set<MemoryKind>(['fact', 'preference', 'decision', 'goal', 'checkpoint', 'lesson'])
const SECRET = /(?:sk-[A-Za-z0-9_-]{16,}|(?:api[_ -]?key|password|secret|token|private[_ -]?key|authorization)\s*[:=]\s*\S+|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i
const MAX_MEMORIES = 5000

type Row = Record<string, unknown>
function tokens(value: string): string[] { return [...new Set(value.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])].slice(0, 16) }
function validText(text: string): string {
  const trimmed = text.trim()
  if (!trimmed || trimmed.length > 1000 || SECRET.test(trimmed)) throw new Error('Memory is empty, too long, or may contain a secret.')
  return trimmed
}
function vector(value: number[]): string {
  if (!Array.isArray(value) || !value.length || value.length > 4096 || value.some(number => !Number.isFinite(number))) throw new Error('Embedding provider returned an invalid vector.')
  return JSON.stringify(value)
}
function cosine(left: number[], right: number[]): number {
  if (left.length !== right.length) return -1
  let dot = 0, a = 0, b = 0
  for (let index = 0; index < left.length; index += 1) { dot += left[index] * right[index]; a += left[index] ** 2; b += right[index] ** 2 }
  return a && b ? dot / Math.sqrt(a * b) : -1
}

export class SqliteMemoryStore implements MemoryStoreLike {
  private readonly db: DatabaseSync
  private readonly workspace?: string
  private readonly embedding?: EmbeddingProvider

  constructor(file: string, legacyJson: string, workspace?: string, embedding?: EmbeddingProvider) {
    this.workspace = workspace ? resolve(workspace) : undefined
    this.embedding = embedding
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(file)
    chmodSync(file, 0o600)
    this.db.exec(`
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY, scope TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL,
        source TEXT NOT NULL, source_path TEXT, source_hash TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0,
        embedding TEXT
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(id UNINDEXED, text);
      CREATE TABLE IF NOT EXISTS memory_history (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, action TEXT NOT NULL,
        snapshot TEXT NOT NULL, at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_links (
        from_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        to_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        relation TEXT NOT NULL, PRIMARY KEY (from_id, to_id, relation)
      );
      CREATE TABLE IF NOT EXISTS memory_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `)
    if (!this.db.prepare("SELECT 1 FROM memory_meta WHERE key='legacy_imported'").get()) {
      let old: unknown = []
      if (existsSync(legacyJson)) {
        try { old = JSON.parse(readFileSync(legacyJson, 'utf8')) } catch { throw new Error('Saved Jef memory is corrupt; refusing to overwrite it.') }
        if (!Array.isArray(old)) throw new Error('Saved Jef memory is corrupt; refusing to overwrite it.')
      }
      this.db.exec('BEGIN IMMEDIATE')
      try {
        for (const value of Number((this.db.prepare('SELECT count(*) AS count FROM memories').get() as Row).count) === 0 ? old as unknown[] : []) {
          if (!value || typeof value !== 'object') continue
          const item = value as JefMemory
          if (typeof item.id !== 'string' || typeof item.scope !== 'string' || !KINDS.has(item.kind) || typeof item.text !== 'string') continue
          this.insert({ ...item, text: validText(item.text), source: String(item.source ?? 'legacy import'), createdAt: item.createdAt ?? new Date().toISOString(), updatedAt: item.updatedAt ?? new Date().toISOString(), pinned: !!item.pinned, stale: false })
        }
        this.db.prepare("INSERT INTO memory_meta (key,value) VALUES ('legacy_imported','1')").run()
        this.db.exec('COMMIT')
      } catch (error) { this.db.exec('ROLLBACK'); throw error }
    }
  }

  close(): void { this.db.close() }

  private fingerprint(path: string): string | undefined {
    if (!this.workspace || isAbsolute(path) || path.split(/[\\/]+/).some(part => part === '..' || part.startsWith('.'))) return undefined
    const target = resolve(this.workspace, path)
    const rel = relative(this.workspace, target)
    if (rel === '..' || rel.startsWith(`..${sep}`) || !existsSync(target)) return undefined
    try {
      const real = realpathSync(target), realRel = relative(this.workspace, real)
      if (realRel === '..' || realRel.startsWith(`..${sep}`) || isAbsolute(realRel)) return undefined
      return createHash('sha256').update(readFileSync(real)).digest('hex')
    } catch { return undefined }
  }

  private item(row: Row): JefMemory {
    const sourcePath = typeof row.source_path === 'string' ? row.source_path : undefined
    const sourceHash = typeof row.source_hash === 'string' ? row.source_hash : undefined
    return {
      id: String(row.id), scope: String(row.scope), kind: row.kind as MemoryKind, text: String(row.text), source: String(row.source),
      ...(sourcePath ? { sourcePath } : {}), ...(sourceHash ? { sourceHash } : {}),
      createdAt: String(row.created_at), updatedAt: String(row.updated_at), pinned: !!row.pinned,
      stale: !!(sourcePath && sourceHash && this.fingerprint(sourcePath) !== sourceHash),
    }
  }

  private insert(item: JefMemory, embedding?: string): void {
    this.db.prepare(`INSERT INTO memories (id,scope,kind,text,source,source_path,source_hash,created_at,updated_at,pinned,embedding)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(item.id, item.scope, item.kind, item.text, item.source, item.sourcePath ?? null, item.sourceHash ?? null, item.createdAt, item.updatedAt, item.pinned ? 1 : 0, embedding ?? null)
    this.db.prepare('INSERT INTO memory_fts (id,text) VALUES (?,?)').run(item.id, item.text)
    this.record(item.id, 'add', item)
  }

  private record(id: string, action: string, item: JefMemory): void {
    this.db.prepare('INSERT INTO memory_history (id,action,snapshot,at) VALUES (?,?,?,?)').run(id, action, JSON.stringify(item), new Date().toISOString())
  }

  list(scope: string): JefMemory[] {
    return (this.db.prepare('SELECT * FROM memories WHERE scope=? OR scope=? ORDER BY pinned DESC, updated_at DESC').all('personal', scope) as Row[]).map(row => this.item(row))
  }

  relevant(scope: string, query: string, limit = 8): JefMemory[] {
    const cap = Math.max(0, Math.min(limit, 20))
    if (!cap) return []
    const words = tokens(query)
    const found = words.length ? this.db.prepare(`SELECT m.* FROM memory_fts f JOIN memories m ON m.id=f.id
      WHERE memory_fts MATCH ? AND (m.scope='personal' OR m.scope=?) ORDER BY m.pinned DESC, bm25(memory_fts), m.updated_at DESC LIMIT ?`)
      .all(words.map(word => `"${word}"`).join(' OR '), scope, cap * 3) as Row[] : []
    const preferences = this.db.prepare("SELECT * FROM memories WHERE kind='preference' AND (scope='personal' OR scope=?) ORDER BY pinned DESC, updated_at DESC LIMIT ?").all(scope, cap) as Row[]
    const unique = new Map<string, JefMemory>()
    for (const row of [...found, ...preferences]) {
      const item = this.item(row)
      if (!item.stale) unique.set(item.id, item)
      if (unique.size >= cap) break
    }
    return [...unique.values()]
  }

  async semanticRelevant(scope: string, query: string, limit = 8): Promise<JefMemory[]> {
    if (!this.embedding) return this.relevant(scope, query, limit)
    const queryVector = await this.embedding.embed(query)
    vector(queryVector)
    const candidates = this.db.prepare('SELECT * FROM memories WHERE (scope=? OR scope=?) AND embedding IS NOT NULL').all('personal', scope) as Row[]
    const scored = candidates.map(row => ({ item: this.item(row), score: cosine(queryVector, JSON.parse(String(row.embedding)) as number[]) }))
      .filter(entry => !entry.item.stale && entry.score > 0)
      .sort((a, b) => b.score - a.score)
    return scored.slice(0, Math.max(0, Math.min(limit, 20))).map(entry => entry.item)
  }

  async add(input: { scope: string; kind: MemoryKind; text: string; source: string; sourcePath?: string }): Promise<JefMemory> {
    const text = validText(input.text)
    if (!input.scope || !KINDS.has(input.kind)) throw new Error('Invalid memory scope or kind.')
    const prior = this.db.prepare('SELECT * FROM memories WHERE scope=? AND lower(text)=lower(?)').get(input.scope, text) as Row | undefined
    if (prior) return this.item(prior)
    const count = Number((this.db.prepare('SELECT count(*) AS count FROM memories').get() as Row).count)
    if (count >= MAX_MEMORIES) throw new Error('Memory capacity reached; export or delete old memories.')
    const now = new Date().toISOString()
    const sourceHash = input.sourcePath ? this.fingerprint(input.sourcePath) : undefined
    const item: JefMemory = { id: randomUUID(), scope: input.scope, kind: input.kind, text, source: input.source.slice(0, 200),
      ...(sourceHash ? { sourcePath: input.sourcePath, sourceHash } : {}), createdAt: now, updatedAt: now, pinned: false, stale: false }
    let embedding: string | undefined
    if (this.embedding) embedding = vector(await this.embedding.embed(text))
    this.db.exec('BEGIN IMMEDIATE')
    try { this.insert(item, embedding); this.db.exec('COMMIT') }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
    return item
  }

  async update(id: string, patch: { text?: string; pinned?: boolean }): Promise<JefMemory> {
    const row = this.db.prepare('SELECT * FROM memories WHERE id=?').get(id) as Row | undefined
    if (!row) throw new Error('Memory not found.')
    const item = this.item(row)
    if (patch.text !== undefined) item.text = validText(patch.text)
    if (patch.pinned !== undefined) item.pinned = patch.pinned
    item.updatedAt = new Date().toISOString()
    const embedding = patch.text !== undefined && this.embedding ? vector(await this.embedding.embed(item.text)) : (row.embedding as Uint8Array | null) ?? null
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('UPDATE memories SET text=?, pinned=?, updated_at=?, embedding=? WHERE id=?').run(item.text, item.pinned ? 1 : 0, item.updatedAt, embedding, id)
      this.db.prepare('DELETE FROM memory_fts WHERE id=?').run(id)
      this.db.prepare('INSERT INTO memory_fts (id,text) VALUES (?,?)').run(id, item.text)
      this.record(id, 'update', item)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
    return item
  }

  async remove(id: string): Promise<void> {
    const row = this.db.prepare('SELECT * FROM memories WHERE id=?').get(id) as Row | undefined
    if (!row) return
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.record(id, 'delete', this.item(row))
      this.db.prepare('DELETE FROM memory_fts WHERE id=?').run(id)
      this.db.prepare('DELETE FROM memories WHERE id=?').run(id)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  async link(from: string, to: string, relation: string): Promise<void> {
    if (from === to || !/^[a-z][a-z-]{0,39}$/.test(relation)) throw new Error('Invalid memory relationship.')
    this.db.prepare('INSERT OR IGNORE INTO memory_links (from_id,to_id,relation) VALUES (?,?,?)').run(from, to, relation)
  }

  links(id: string): Array<{ from: string; to: string; relation: string }> {
    return (this.db.prepare('SELECT from_id,to_id,relation FROM memory_links WHERE from_id=? OR to_id=?').all(id, id) as Row[])
      .map(row => ({ from: String(row.from_id), to: String(row.to_id), relation: String(row.relation) }))
  }

  history(id: string): Array<{ action: string; at: string; snapshot: JefMemory }> {
    return (this.db.prepare('SELECT action,at,snapshot FROM memory_history WHERE id=? ORDER BY sequence').all(id) as Row[])
      .map(row => ({ action: String(row.action), at: String(row.at), snapshot: JSON.parse(String(row.snapshot)) as JefMemory }))
  }

  export(scope: string): JefMemory[] { return this.list(scope) }
}
