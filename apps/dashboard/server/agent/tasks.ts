import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export type TaskStatus = 'running' | 'awaiting-approval' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
export interface TaskStep { action: string; done: boolean }
export interface TaskEvent { at: string; type: string; summary: string }
export interface JefTask {
  id: string; conversationId: string; objective: string; status: TaskStatus
  plan: TaskStep[]; events: TaskEvent[]; maxSteps: number; createdAt: string; updatedAt: string
}
type Row = Record<string, unknown>

export class TaskStore {
  private readonly db: DatabaseSync

  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(file)
    chmodSync(file, 0o600)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, objective TEXT NOT NULL,
        status TEXT NOT NULL, plan TEXT NOT NULL, max_steps INTEGER NOT NULL,
        owner_pid INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        at TEXT NOT NULL, type TEXT NOT NULL, summary TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS task_conversation ON tasks(conversation_id, created_at);
    `)
    this.db.exec('PRAGMA foreign_keys=ON')
    const staleBefore = new Date(Date.now() - 5 * 60_000).toISOString()
    this.db.prepare("UPDATE tasks SET status='interrupted', owner_pid=NULL WHERE status='running' AND updated_at<?").run(staleBefore)
  }

  close(): void {
    this.db.prepare("UPDATE tasks SET status='interrupted', owner_pid=NULL, updated_at=? WHERE status='running' AND owner_pid=?").run(new Date().toISOString(), process.pid)
    this.db.close()
  }

  create(conversationId: string, objective: string, maxSteps: number): JefTask {
    if (!conversationId || !objective.trim() || objective.length > 20_000 || maxSteps < 1 || maxSteps > 100) throw new Error('Invalid task.')
    const id = randomUUID(), now = new Date().toISOString()
    this.db.prepare(`INSERT INTO tasks (id,conversation_id,objective,status,plan,max_steps,owner_pid,created_at,updated_at)
      VALUES (?,?,?,'running','[]',?,?,?,?)`).run(id, conversationId, objective.trim(), maxSteps, process.pid, now, now)
    return this.get(id)!
  }

  get(id: string): JefTask | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id) as Row | undefined
    if (!row) return null
    const events = this.db.prepare('SELECT at,type,summary FROM task_events WHERE task_id=? ORDER BY sequence DESC LIMIT 500').all(id) as Row[]
    return {
      id: String(row.id), conversationId: String(row.conversation_id), objective: String(row.objective),
      status: row.status as TaskStatus, plan: JSON.parse(String(row.plan)) as TaskStep[],
      events: events.reverse().map(event => ({ at: String(event.at), type: String(event.type), summary: String(event.summary) })),
      maxSteps: Number(row.max_steps), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    }
  }

  latestForConversation(conversationId: string): JefTask | null {
    const row = this.db.prepare('SELECT id FROM tasks WHERE conversation_id=? ORDER BY created_at DESC LIMIT 1').get(conversationId) as Row | undefined
    return row ? this.get(String(row.id)) : null
  }

  list(limit = 30): JefTask[] {
    const rows = this.db.prepare('SELECT id FROM tasks ORDER BY created_at DESC LIMIT ?').all(Math.max(1, Math.min(limit, 100))) as Row[]
    return rows.map(row => this.get(String(row.id))!).filter(Boolean)
  }

  setPlan(id: string, steps: TaskStep[]): void {
    if (!Array.isArray(steps) || steps.length > 20 || steps.some(step => !step || typeof step.action !== 'string' || !step.action.trim() || step.action.length > 500 || typeof step.done !== 'boolean')) throw new Error('Invalid task plan.')
    this.db.prepare('UPDATE tasks SET plan=?,updated_at=? WHERE id=?').run(JSON.stringify(steps), new Date().toISOString(), id)
  }

  append(id: string, type: string, summary: string): void {
    if (!this.get(id) || !/^[a-z-]{1,30}$/.test(type)) throw new Error('Invalid task event.')
    const now = new Date().toISOString()
    this.db.prepare('INSERT INTO task_events (task_id,at,type,summary) VALUES (?,?,?,?)').run(id, now, type, summary.slice(0, 500))
    this.db.prepare('UPDATE tasks SET updated_at=? WHERE id=?').run(now, id)
  }

  finish(id: string, status: TaskStatus): void {
    if (!['awaiting-approval', 'completed', 'failed', 'cancelled', 'interrupted'].includes(status)) throw new Error('Invalid task status.')
    this.db.prepare('UPDATE tasks SET status=?,owner_pid=NULL,updated_at=? WHERE id=?').run(status, new Date().toISOString(), id)
  }

  resume(id: string): void {
    const task = this.get(id)
    if (!task || !['interrupted', 'awaiting-approval'].includes(task.status)) throw new Error('Task cannot resume.')
    this.db.prepare("UPDATE tasks SET status='running',owner_pid=?,updated_at=? WHERE id=?").run(process.pid, new Date().toISOString(), id)
  }
}
