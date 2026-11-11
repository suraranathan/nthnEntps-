import type { MemoryCategory, Preferences } from '../src/jef-contract.ts'
import { localClock } from './notifications.ts'
export class InputError extends Error { readonly status: number; constructor(message: string, status = 400) { super(message); this.status = status } }
export function textInput(value: unknown, max = 8000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new InputError(`Expected text between 1 and ${max} characters`)
  return value.trim()
}
export function categoryInput(value: unknown): MemoryCategory {
  if (!['project', 'relationships', 'insideJokes', 'temporary'].includes(String(value))) throw new InputError('Unknown memory category')
  return value as MemoryCategory
}
export function validatePreferences(input: unknown): Preferences {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new InputError('Invalid preferences')
  const p = input as Preferences
  if (!['balanced', 'playful', 'serious'].includes(p.humor) || typeof p.communication !== 'string' || p.communication.length > 1000 || typeof p.proactive !== 'boolean' || typeof p.dailyBriefing !== 'boolean' || !Number.isInteger(p.intervalMinutes) || p.intervalMinutes < 15 || p.intervalMinutes > 1440 || typeof p.philosophy !== 'boolean' || !['off', 'relevant'].includes(p.conversationInitiation) || typeof p.followUps !== 'boolean' || typeof p.reminders !== 'boolean' || !Number.isInteger(p.stalledAfterDays) || p.stalledAfterDays < 1 || p.stalledAfterDays > 90) throw new InputError('Invalid preferences or notification interval (15–1440 minutes)')
  for (const time of [p.quietStart, p.quietEnd, p.briefingTime]) if (typeof time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new InputError('Times must use HH:MM')
  if (typeof p.timezone !== 'string' || p.timezone.length > 100) throw new InputError('Invalid timezone')
  try { localClock(new Date(), p.timezone) } catch { throw new InputError('Unknown timezone') }
  return { humor: p.humor, communication: p.communication, proactive: p.proactive, intervalMinutes: p.intervalMinutes, quietStart: p.quietStart, quietEnd: p.quietEnd, timezone: p.timezone, dailyBriefing: p.dailyBriefing, briefingTime: p.briefingTime, philosophy: p.philosophy, conversationInitiation: p.conversationInitiation, followUps: p.followUps, reminders: p.reminders, stalledAfterDays: p.stalledAfterDays }
}
export function optionalDate(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(value) || !Number.isFinite(Date.parse(value)) || value.length > 40) throw new InputError('Invalid reminder or due date')
  return new Date(value).toISOString()
}
