import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { validatePreferences } from './validation.ts'
import { randomUUID } from 'node:crypto'
import type { ChatMessage, MemoryCategory, MemoryNote, Preferences, ProjectEvent, TeamRequest } from '../src/alex-contract.ts'
export const defaultPreferences: Preferences = { humor: 'balanced', communication: '', proactive: false, intervalMinutes: 60, quietStart: '22:00', quietEnd: '08:00', timezone: 'Asia/Manila', dailyBriefing: false, briefingTime: '09:00' }
export type MemoryState = {
  version: 1
  preferences: Preferences
  notes: Record<MemoryCategory, MemoryNote[]>
  messages: ChatMessage[]
  requests: TeamRequest[]
  events: ProjectEvent[]
  audit: { at: string; action: string; outcome: string }[]
  routing: string | null
  lastNotification: number
  lastBriefingDay: string
  deliveredEvents: string[]
}
export function emptyMemory(): MemoryState {
  return { version: 1, preferences: { ...defaultPreferences }, notes: { project: [], relationships: [], insideJokes: [], temporary: [] }, messages: [], requests: [], events: [], audit: [], routing: null, lastNotification: 0, lastBriefingDay: '', deliveredEvents: [] }
}
export class MemoryStore {
  state = emptyMemory()
  private pending = Promise.resolve()
  readonly directory: string
  constructor(directory: string) { this.directory = directory }
  async load() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    try {
      const saved = JSON.parse(await readFile(join(this.directory, 'alex.json'), 'utf8'))
      validateMemory(saved)
      this.state = saved
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await this.save()
    }
  }
  async save() {
    const data = JSON.stringify(this.state, null, 2)
    // Serialize atomic rename writes; failed writes must not poison later attempts.
    const operation = this.pending.catch(() => {}).then(async () => {
      const temporary = join(this.directory, `alex-${randomUUID()}.tmp`)
      await writeFile(temporary, data, { mode: 0o600 })
      await rename(temporary, join(this.directory, 'alex.json'))
    })
    this.pending = operation
    await operation
  }
  log(action: string, outcome: string) {
    this.state.audit.push({ at: new Date().toISOString(), action, outcome })
    this.state.audit = this.state.audit.slice(-1000)
  }
  event(type: string, text: string) {
    const event = { id: randomUUID(), at: new Date().toISOString(), type, text }
    this.state.events.push(event); this.state.events = this.state.events.slice(-500)
    return event
  }
}
export function conversationContext(messages: ChatMessage[], query: string) {
  const recent = messages.slice(-32)
  const words = new Set(query.toLowerCase().match(/[a-z0-9]{4,}/g) ?? [])
  const older = messages.slice(0, -32).map((message, index) => ({ message, index, score: [...words].filter(w => message.content.toLowerCase().includes(w)).length }))
    .filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 4).sort((a, b) => a.index - b.index)
  return [...older.map(x => x.message), ...recent].map(({ role, content }) => ({ role, content: content.slice(0, 8000) }))
}

function validateMemory(value: unknown): asserts value is MemoryState {
  const fail = () => { throw new Error('Invalid memory schema; restore a valid backup before starting') }
  if (!value || typeof value !== 'object') fail()
  const state = value as MemoryState
  const string = (x: unknown, max = 20000) => typeof x === 'string' && x.length <= max
  const array = (x: unknown): x is unknown[] => Array.isArray(x)
  if (state.version !== 1 || !state.notes || typeof state.notes !== 'object') fail()
  try { validatePreferences(state.preferences) } catch { fail() }
  for (const category of ['project', 'relationships', 'insideJokes', 'temporary'] as const) {
    const notes = state.notes[category]
    if (!array(notes) || notes.length > 30 || !notes.every(n => n && typeof n === 'object' && string(n.id, 100) && string(n.text, 1000) && n.source === 'user' && string(n.createdAt, 100))) fail()
  }
  if (!array(state.messages) || !state.messages.every(m => m && typeof m === 'object' && string(m.id, 100) && ['user', 'assistant'].includes(m.role) && string(m.content) && string(m.createdAt, 100) && ['chat', 'briefing', 'update'].includes(m.kind))) fail()
  if (!array(state.requests) || !state.requests.every(r => r && typeof r === 'object' && string(r.id, 100) && r.target === 'sophia' && ['request', 'clarification'].includes(r.type) && ['awaiting_adapter', 'submitted', 'in_progress', 'completed', 'failed'].includes(r.state) && string(r.text, 8000) && string(r.createdAt, 100) && array(r.updates) && r.updates.every(u => u && typeof u === 'object' && string(u.text, 8000) && string(u.at, 100)))) fail()
  if (!array(state.events) || !state.events.every(e => e && typeof e === 'object' && string(e.id, 100) && string(e.type, 100) && string(e.text) && string(e.at, 100))) fail()
  if (!array(state.audit) || !state.audit.every(e => e && typeof e === 'object' && string(e.at, 100) && string(e.action, 100) && string(e.outcome))) fail()
  if (!(state.routing === null || string(state.routing, 100)) || !Number.isFinite(state.lastNotification) || state.lastNotification < 0 || !string(state.lastBriefingDay, 100) || !array(state.deliveredEvents) || !state.deliveredEvents.every(id => string(id, 100))) fail()
}
