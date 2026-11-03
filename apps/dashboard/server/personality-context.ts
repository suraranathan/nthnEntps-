import type { MemoryState } from './memory.ts'

// High-confidence cues only. Ambiguous cases remain a judgment for the model.
const sensitive = /\b(suicid(?:e|al)|self[- ]harm|abuse|assault|grief|bereave|died|death|diagnos(?:is|ed)|emergency|panic attack|laid off|fired|cancer|hospital)\b|\b(?:kill|hurt) myself\b|\bending my life\b/i
export const isSensitiveConversation = (text: string) => sensitive.test(text)
export const hasInappropriateHumor = (text: string) => /\b(haha|lol|lmao|just kidding|roast you)\b|[😂🤣]/i.test(text)
export function conversationGuidance(memory: MemoryState, text: string) {
  const serious = isSensitiveConversation(text) || memory.preferences.humor === 'serious'
  const shared = memory.notes.insideJokes.map(note => note.text.slice(0, 300))
  return `CONVERSATION JUDGMENT: ${serious ? 'This turn may be serious or sensitive. Respond directly and kindly; no sarcasm, teasing or jokes. Do not minimize risk.' : 'Use judgment: questions, humor, playful trash talk, and advice are optional, only when relevant and welcome. Never force a routine.'} Be curious about what the user actually means. Offer a useful observation or question when it advances this conversation. Hold an independent, evidence-based view; disagree respectfully when warranted, with a reason and a constructive alternative. Admit uncertainty and correct mistakes. Do not agree merely to be agreeable. The user humor setting is ${memory.preferences.humor}. Shared jokes are user-saved reports, not permission to repeat them: ${JSON.stringify(shared)}. Only reuse one if the current conversation genuinely calls for it. User communication preference: ${JSON.stringify(memory.preferences.communication)}.`
}
