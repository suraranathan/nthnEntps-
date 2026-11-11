import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export type MemoryKind = 'fact' | 'preference' | 'decision' | 'goal' | 'checkpoint' | 'lesson'
export interface JefMemory {
  id: string
  scope: string
  kind: MemoryKind
  text: string
  source: string
  sourcePath?: string
  sourceHash?: string
  createdAt: string
  updatedAt: string
  pinned: boolean
  stale: boolean
}

const KINDS = new Set<MemoryKind>(['fact', 'preference', 'decision', 'goal', 'checkpoint', 'lesson'])
const SECRET = /(?:sk-[A-Za-z0-9_-]{16,}|(?:api[_ -]?key|password|secret|token|private[_ -]?key|authorization)\s*[:=]\s*\S+|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i
const MAX_MEMORIES = 500

function tokens(value: string): Set<string> {
  return new Set(value.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])
}

export class JefMemoryStore {
  private readonly file: string
  private readonly workspace?: string
  private items: JefMemory[]

  constructor(file: string, workspace?: string) {
    this.file = file
    this.workspace = workspace ? resolve(workspace) : undefined
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
      this.items = Array.isArray(parsed) ? parsed.filter((item): item is JefMemory =>
        item && typeof item.id === 'string' && typeof item.scope === 'string' &&
        typeof item.text === 'string' && KINDS.has(item.kind)) : []
    } catch (error) {
      if (existsSync(file)) throw new Error('Saved Jef memory is corrupt; refusing to overwrite it.', { cause: error })
      this.items = []
    }
  }

  private fingerprint(path: string): string | undefined {
    if (!this.workspace || isAbsolute(path) || path.split(/[\\/]/).some(part => part === '..' || part.startsWith('.'))) return undefined
    const target = resolve(this.workspace, path)
    const rel = relative(this.workspace, target)
    if (rel.startsWith(`..${sep}`) || rel === '..' || !existsSync(target)) return undefined
    try {
      const real = realpathSync(target)
      const realRelative = relative(this.workspace, real)
      if (realRelative === '..' || realRelative.startsWith(`..${sep}`) || isAbsolute(realRelative)) return undefined
      return createHash('sha256').update(readFileSync(real)).digest('hex')
    }
    catch { return undefined }
  }

  private hydrated(item: JefMemory): JefMemory {
    return { ...item, stale: !!(item.sourcePath && item.sourceHash && this.fingerprint(item.sourcePath) !== item.sourceHash) }
  }

  list(scope: string): JefMemory[] {
    return this.items.filter(item => item.scope === 'personal' || item.scope === scope)
      .map(item => this.hydrated(item))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt))
  }

  relevant(scope: string, query: string, limit = 8): JefMemory[] {
    const targetCount = Math.max(0, Math.min(limit, 20))
    if (targetCount === 0) return []
    const words = tokens(query)
    const candidates = this.items.filter(item => item.scope === 'personal' || item.scope === scope)
      .map(item => ({ item, score: [...tokens(item.text)].filter(word => words.has(word)).length + (item.pinned ? 2 : 0) }))
      .filter(entry => entry.score > 0 || entry.item.kind === 'preference')
      .sort((a, b) => b.score - a.score || b.item.updatedAt.localeCompare(a.item.updatedAt))
    const found: JefMemory[] = []
    for (const candidate of candidates) {
      const item = this.hydrated(candidate.item)
      if (!item.stale) found.push(item)
      if (found.length >= targetCount) break
    }
    return found
  }

  async add(input: { scope: string; kind: MemoryKind; text: string; source: string; sourcePath?: string }): Promise<JefMemory> {
    const text = input.text.trim()
    if (!input.scope || !KINDS.has(input.kind) || !text || text.length > 1000 || SECRET.test(text)) throw new Error('Memory is empty, too long, or may contain a secret.')
    const existing = this.items.find(item => item.scope === input.scope && item.text.toLowerCase() === text.toLowerCase())
    if (existing) return this.hydrated(existing)
    const now = new Date().toISOString()
    const sourcePath = input.sourcePath && this.fingerprint(input.sourcePath) ? input.sourcePath : undefined
    const item: JefMemory = {
      id: randomUUID(), scope: input.scope, kind: input.kind, text,
      source: input.source.slice(0, 200), ...(sourcePath ? { sourcePath, sourceHash: this.fingerprint(sourcePath) } : {}),
      createdAt: now, updatedAt: now, pinned: false, stale: false,
    }
    this.items.push(item)
    if (this.items.length > MAX_MEMORIES) this.items = this.items.slice(-MAX_MEMORIES)
    await this.persist()
    return item
  }

  async update(id: string, patch: { text?: string; pinned?: boolean }): Promise<JefMemory> {
    const item = this.items.find(candidate => candidate.id === id)
    if (!item) throw new Error('Memory not found.')
    if (patch.text !== undefined) {
      const text = patch.text.trim()
      if (!text || text.length > 1000 || SECRET.test(text)) throw new Error('Memory is empty, too long, or may contain a secret.')
      item.text = text
    }
    if (patch.pinned !== undefined) item.pinned = patch.pinned
    item.updatedAt = new Date().toISOString()
    await this.persist()
    return this.hydrated(item)
  }

  async remove(id: string): Promise<void> {
    this.items = this.items.filter(item => item.id !== id)
    await this.persist()
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 })
    const temporary = join(dirname(this.file), `.memories-${process.pid}-${randomUUID()}.tmp`)
    await writeFile(temporary, JSON.stringify(this.items), { mode: 0o600, flag: 'wx' })
    await rename(temporary, this.file)
  }
}
