import type { AgentState, AgentEvent } from './agent.ts'
import type { AgentMessage, ToolCallRecord } from './store.ts'
import { readdirSync } from 'node:fs'

export interface MobilePendingApproval {
  conversationId: string
  approvalId: string
  tool: string
  summary: string
  preview?: string
  previewTruncated?: boolean
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
  workspaceStatus: 'empty' | 'populated' | 'unavailable'
}

function approvalPreview(call: ToolCallRecord): string | undefined {
  const render = (path: string, before: string, after: string) => `--- ${path}\n- ${before}\n+++ ${path}\n+ ${after}`
  const args = call.arguments
  if (call.tool === 'write_file' && typeof args.path === 'string' && typeof args.content === 'string') {
    return render(args.path, '(new or overwritten file)', args.content).slice(0, 20000)
  }
  if (call.tool === 'edit_file' && typeof args.path === 'string' && typeof args.oldText === 'string' && typeof args.newText === 'string') {
    return render(args.path, args.oldText, args.newText).slice(0, 20000)
  }
  if (call.tool === 'edit_files' && typeof args.changes === 'string') {
    try {
      const changes: unknown = JSON.parse(args.changes)
      if (!Array.isArray(changes)) return undefined
      return changes.map(change => change && typeof change.path === 'string' && typeof change.oldText === 'string' && typeof change.newText === 'string'
        ? render(change.path, change.oldText, change.newText) : '').join('\n\n').slice(0, 20000)
    } catch { return undefined }
  }
  if (call.tool === 'run_command' && typeof args.command === 'string') return `Command: ${args.command}`
  return undefined
}

export function mobileAgentProgress(event: AgentEvent): Record<string, unknown> | null {
  switch (event.type) {
    case 'start': case 'done': case 'cancelled':
      return { type: event.type, messageId: event.messageId }
    case 'delta':
      return { type: 'delta', messageId: event.messageId, text: event.text }
    case 'tool': case 'tool-output': case 'approval':
      return {
        type: event.type, messageId: event.messageId, tool: event.call.tool,
        status: event.call.status, summary: event.call.summary ?? event.call.tool,
        ...(event.type === 'tool-output' && event.call.output ? { output: event.call.output.slice(0, 2000) } : {}),
      }
    case 'error':
      return { type: 'error', message: event.message, code: event.code }
    case 'decision':
      return null
  }
}

export function mobileAgentSnapshot(state: AgentState): MobileAgentSnapshot {
  let workspaceStatus: MobileAgentSnapshot['workspaceStatus'] = 'unavailable'
  try {
    workspaceStatus = readdirSync(state.workspace).some(name => !['.local', '.git', '.ssh'].includes(name)) ? 'populated' : 'empty'
  } catch { /* The workspace cannot currently be read. */ }
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
      if (call.status === 'awaiting-approval' && call.approvalId && call.approvalExpiresAt && call.approvalExpiresAt > Date.now()) {
        pendingApproval = {
          conversationId: active!.id,
          approvalId: call.approvalId,
          tool: call.tool,
          summary: call.summary ?? call.tool,
          preview: approvalPreview(call),
          previewTruncated: ['write_file', 'edit_file', 'edit_files'].includes(call.tool) && JSON.stringify(call.arguments).length > 18000,
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
    workspaceStatus,
  }
}
