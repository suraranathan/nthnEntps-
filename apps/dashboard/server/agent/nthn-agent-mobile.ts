import type { AgentState } from './agent.ts'
import type { AgentMessage, ToolCallRecord } from './store.ts'

export interface MobilePendingApproval {
  conversationId: string
  approvalId: string
  tool: string
  summary: string
  expiresAt: number
}

export interface MobileAgentSnapshot {
  conversationId: string | null
  title: string
  messages: Array<Omit<AgentMessage, 'toolCalls' | 'decision' | 'meta'> & { toolCalls?: Array<Omit<ToolCallRecord, 'arguments' | 'error'>> }>
  pendingApproval: MobilePendingApproval | null
  provider: string | null
  model: string | null
  workspace: string
}

export function mobileAgentSnapshot(state: AgentState): MobileAgentSnapshot {
  const active = state.active
  const messages = (active?.messages ?? []).map(message => ({
    id: message.id,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt,
    status: message.status,
    ...(message.toolCalls?.length ? {
      toolCalls: message.toolCalls.map(call => ({
        id: call.id, tool: call.tool, status: call.status,
        ...(call.summary ? { summary: call.summary } : {}),
        ...(call.output ? { output: call.output } : {}),
        ...(call.approvalId ? { approvalId: call.approvalId } : {}),
        ...(call.approvalExpiresAt ? { approvalExpiresAt: call.approvalExpiresAt } : {}),
      })),
    } : {}),
  }))
  let pendingApproval: MobilePendingApproval | null = null
  for (let messageIndex = (active?.messages.length ?? 0) - 1; messageIndex >= 0 && !pendingApproval; messageIndex -= 1) {
    const message = active!.messages[messageIndex]
    for (let callIndex = (message.toolCalls?.length ?? 0) - 1; callIndex >= 0; callIndex -= 1) {
      const call = message.toolCalls![callIndex]
      if (call.status === 'awaiting-approval' && call.approvalId && call.approvalExpiresAt) {
        pendingApproval = {
          conversationId: active!.id,
          approvalId: call.approvalId,
          tool: call.tool,
          summary: call.summary ?? call.tool,
          expiresAt: call.approvalExpiresAt,
        }
        break
      }
    }
  }
  return {
    conversationId: active?.id ?? null,
    title: active?.title ?? 'New conversation',
    messages,
    pendingApproval,
    provider: state.gateway?.provider ?? null,
    model: state.gateway?.model ?? null,
    workspace: state.workspace,
  }
}
