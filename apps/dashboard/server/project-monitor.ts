import { createHash } from 'node:crypto'
import type { MemoryStore } from './memory.ts'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
export function projectFingerprint(content: string) {
  const sections: Record<string, string> = {}
  let title = 'preamble', body = ''
  const commit = () => { sections[title] = hash(body) }
  for (const line of content.split('\n')) {
    if (/^#{1,3}\s/.test(line)) { commit(); title = line.replace(/^#+\s*/, '').slice(0, 90); body = '' }
    else body += line + '\n'
  }
  commit()
  return { hash: hash(content), sections }
}
export function observeProject(store: MemoryStore, content: string) {
  const next = projectFingerprint(content), previous = store.state.projectFingerprint
  if (previous?.hash === next.hash) return false
  store.state.projectFingerprint = next
  if (!previous) return true // establish baseline; no fictitious change at first startup
  const changed = Object.keys(next.sections).filter(key => previous.sections[key] !== next.sections[key]).slice(0, 8)
  const removed = Object.keys(previous.sections).filter(key => !(key in next.sections)).slice(0, 4)
  const names = [...changed, ...removed].join(', ').slice(0, 500) || 'document content'
  const sections = new Map<string, string>()
  let title = 'preamble', body = ''
  for (const line of content.split('\n')) {
    if (/^#{1,3}\s/.test(line)) { sections.set(title, body); title = line.replace(/^#+\s*/, '').slice(0, 90); body = '' }
    else body += line + '\n'
  }
  sections.set(title, body)
  const important = /blocker|security|failed|deadline|complete|milestone|risk|release/i.test(names) || changed.some(key => /blocker|security|failed|deadline|complete|milestone|risk|release/i.test(sections.get(key) ?? ''))
  // Coalesce edits made before Jef can speak; the latest document is the source.
  store.state.events = store.state.events.filter(event => !event.type.startsWith('project_change') || store.state.deliveredEvents.includes(event.id))
  store.event(important ? 'project_change_important' : 'project_change', `PROJECT_STATUS.md changed in: ${names}. This is a document change, not independent proof of task progress.`)
  return true
}
