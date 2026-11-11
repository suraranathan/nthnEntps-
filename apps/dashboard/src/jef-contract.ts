export type ConnectionState = 'offline' | 'online' | 'thinking' | 'error' | 'reconnecting'
export type MemoryCategory = 'project' | 'relationships' | 'insideJokes' | 'temporary'
export type MemoryNote = { id: string; text: string; source: 'user'; createdAt: string }
export type ChatMessage = { id: string; role: 'user' | 'assistant'; content: string; createdAt: string; kind: 'chat' | 'briefing' | 'update'; provider?: string; model?: string }
export type Preferences = {
  humor: 'playful' | 'balanced' | 'serious'
  communication: string
  proactive: boolean
  intervalMinutes: number
  quietStart: string
  quietEnd: string
  timezone: string
  dailyBriefing: boolean
  briefingTime: string
  philosophy: boolean
  conversationInitiation: 'off' | 'relevant'
  followUps: boolean
  reminders: boolean
  stalledAfterDays: number
}
export type FollowUp = { id: string; text: string; state: 'pending' | 'scheduled' | 'completed' | 'dismissed' | 'overdue'; createdAt: string; updatedAt: string; dueAt: string | null; remindAt: string | null; lastSignal: 'stalled' | 'reminder' | 'overdue' | null }
export type TeamRequest = { id: string; target: 'sophia'; type: 'request' | 'clarification'; text: string; state: 'awaiting_adapter' | 'submitted' | 'in_progress' | 'completed' | 'failed'; createdAt: string; updates: { text: string; at: string }[] }
export type ProjectEvent = { id: string; type: string; text: string; at: string }
export type ProviderInfo = { id: string; model: string; configured: boolean; capabilities: { text: boolean; tools: false; streaming: false; images: false; discovery: boolean } }
export type JefSnapshot = {
  identity: { id: string; name: string; role: string; version: number }
  status: ConnectionState
  detail: string
  provider: string | null
  model: string | null
  providers: ProviderInfo[]
  preferences: Preferences
  memory: Record<MemoryCategory, MemoryNote[]>
  messages: ChatMessage[]
  requests: TeamRequest[]
  followUps: FollowUp[]
  events: ProjectEvent[]
  audit: { at: string; action: string; outcome: string }[]
  csrf: string
}
export type JefAction =
  | { action: 'chat'; text: string }
  | { action: 'probe' }
  | { action: 'preferences'; value: Preferences }
  | { action: 'remember'; category: MemoryCategory; text: string }
  | { action: 'forget'; category: MemoryCategory; id: string }
  | { action: 'provider'; id: string }
  | { action: 'handoff'; text: string; type: 'request' | 'clarification'; approved: boolean }
  | { action: 'briefing' }
  | { action: 'followup.create'; text: string; dueAt?: string | null; remindAt?: string | null }
  | { action: 'followup.update'; id: string; state: 'completed' | 'dismissed' | 'pending'; dueAt?: string | null; remindAt?: string | null }
