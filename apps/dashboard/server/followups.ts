import type { MemoryStore } from './memory.ts'

export function scanFollowUps(store: MemoryStore, now: Date) {
  const p = store.state.preferences
  let changed = false
  for (const item of store.state.followUps) {
    if (item.state === 'completed' || item.state === 'dismissed') continue
    const due = item.dueAt ? Date.parse(item.dueAt) : Infinity
    const reminder = item.remindAt ? Date.parse(item.remindAt) : Infinity
    const overdue = now.getTime() > due
    const signal = overdue ? 'overdue' : p.reminders && now.getTime() >= reminder ? 'reminder' : now.getTime() - Date.parse(item.updatedAt) >= p.stalledAfterDays * 86400000 ? 'stalled' : null
    if (overdue && item.state !== 'overdue') { item.state = 'overdue'; item.updatedAt = now.toISOString(); changed = true }
    if (!p.proactive || !p.followUps || !signal || signal === item.lastSignal || (signal === 'reminder' && !p.reminders)) continue
    item.lastSignal = signal
    store.event('followup_' + signal, `User-saved follow-up ${item.id} is ${signal}: ${item.text.slice(0, 500)}. This is a reminder, not verified task progress.`)
    changed = true
  }
  return changed
}
