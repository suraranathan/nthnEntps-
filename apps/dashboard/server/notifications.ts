import type { Preferences } from '../src/jef-contract.ts'
import type { MemoryState } from './memory.ts'
export function pendingProactiveEvents(memory: MemoryState) {
  const p = memory.preferences
  return memory.events.filter(x => !memory.deliveredEvents.includes(x.id) && ((x.type.startsWith('followup_') && p.followUps) || (p.conversationInitiation === 'relevant' && (x.type.startsWith('project_change') || x.type === 'sophia_request_queued' || x.type === 'jef_model_switched'))))
}
export function localClock(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date)
  const value = (key: string) => parts.find(x => x.type === key)!.value
  return { day: `${value('year')}-${value('month')}-${value('day')}`, time: `${value('hour')}:${value('minute')}` }
}
export function inQuietHours(time: string, preferences: Preferences) {
  const { quietStart: start, quietEnd: end } = preferences
  if (start === end) return false
  return start < end ? time >= start && time < end : time >= start || time < end
}
export function notificationDue(memory: MemoryState, now: Date): 'briefing' | 'update' | null {
  const p = memory.preferences
  if (!p.proactive) return null
  const clock = localClock(now, p.timezone)
  if (inQuietHours(clock.time, p) || now.getTime() - memory.lastNotification < p.intervalMinutes * 60000) return null
  if (p.dailyBriefing && clock.time >= p.briefingTime && memory.lastBriefingDay !== clock.day) return 'briefing'
  if (pendingProactiveEvents(memory).length) return 'update'
  return null
}
