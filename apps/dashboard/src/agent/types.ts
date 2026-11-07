export type AgentRole = 'user' | 'assistant' | 'tool' | 'system'
export type ToolCallStatus = 'proposed' | 'awaiting-approval' | 'running' | 'succeeded' | 'failed' | 'denied' | 'cancelled'

export interface ToolCallRecord {
  id: string
  tool: string
  arguments: Record<string, unknown>
  status: ToolCallStatus
  summary?: string
  output?: string
  error?: string
  approvalId?: string
}

export interface AgentMessage {
  id: string
  role: AgentRole
  content: string
  createdAt: string
  status: 'complete' | 'streaming' | 'error' | 'cancelled'
  toolCalls?: ToolCallRecord[]
  decision?: DecisionSummary
  meta?: Record<string, unknown>
}

export interface Conversation {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  messages: AgentMessage[]
}

export interface ConversationSummary {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  messageCount: number
}

export interface ToolInfo {
  name: string
  description: string
  requiresApproval: boolean | 'conditional'
  arguments: Record<string, string>
}

export interface GatewayInfo {
  provider: string
  model: string
  transport: 'streaming' | 'buffered'
}

export interface DecisionEnvelope<T = unknown> {
  id: string
  kind: string
  question: string
  result: T
  confidence: { value: number; band: string; basis: string }
  reasoning: string[]
  alternatives: { option: string; score: number; rejectedBecause: string }[]
  inputs: Record<string, unknown>
  advisoryOnly: true
  engine: { name: string; mode: string; inspiredBy: string; isJev: false; performanceClaim: string }
  createdAt: string
}

export interface DecisionSummary {
  routing: DecisionEnvelope<{ workflow: string; tools: string[]; requiresApproval: boolean; rationale: string }>
  classification: DecisionEnvelope<{ label: string; scores: Record<string, number> }>
  risk: DecisionEnvelope<{ score: number; level: string; factors: Record<string, number>; requiresHumanApproval: boolean }>
  workflow: DecisionEnvelope<{ objective: string; steps: { order: number; action: string; tools: string[]; exitCriteria: string }[]; risks: string[] }>
}

export interface AgentState {
  conversations: ConversationSummary[]
  activeId: string | null
  active: Conversation | null
  gateway: GatewayInfo | null
  tools: ToolInfo[]
  workspace: string
  protectedPaths: string[]
  csrf?: string
}

export type AgentEvent =
  | { type: 'start'; conversationId: string; messageId: string }
  | { type: 'delta'; conversationId: string; messageId: string; text: string }
  | { type: 'decision'; conversationId: string; messageId: string; decision: DecisionSummary }
  | { type: 'tool'; conversationId: string; messageId: string; call: ToolCallRecord }
  | { type: 'tool-output'; conversationId: string; messageId: string; call: ToolCallRecord }
  | { type: 'approval'; conversationId: string; messageId: string; call: ToolCallRecord; approvalId: string }
  | { type: 'done'; conversationId: string; messageId: string; stopped: boolean }
  | { type: 'cancelled'; conversationId: string; messageId: string }
  | { type: 'error'; conversationId: string; message: string; code: string }
