import type { MemoryKind } from './memory.ts'

export interface MemoryCandidate { scope: 'personal' | 'project'; kind: MemoryKind; text: string }

/** Only explicit first-person statements are candidates; the store rejects secrets. */
export function extractMemoryCandidates(message: string): MemoryCandidate[] {
  const text = message.trim()
  if (text.length > 500 || text.includes('\n')) return []
  const rules: Array<{ pattern: RegExp; kind: MemoryKind; prefix?: string }> = [
    { pattern: /^I prefer\s+(.+?)[.!?]?$/i, kind: 'preference', prefix: 'Prefer ' },
    { pattern: /^My goal is\s+(.+?)[.!?]?$/i, kind: 'goal' },
    { pattern: /^Remember that\s+(.+?)[.!?]?$/i, kind: 'fact' },
  ]
  for (const rule of rules) {
    const match = rule.pattern.exec(text)
    if (!match) continue
    const value = match[1].replace(/[.!?]+$/, '').trim()
    if (value.length < 4 || value.length > 300) return []
    const candidateText = rule.prefix ? `${rule.prefix}${value}` : value[0].toUpperCase() + value.slice(1)
    const scope = /\b(?:my|this|the) project\b/i.test(value) ? 'project' : 'personal'
    return [{ scope, kind: rule.kind, text: candidateText }]
  }
  return []
}
