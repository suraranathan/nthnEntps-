import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { AgentChatStore, type Conversation, type ToolCallRecord } from './store.ts'
import { ApprovalRegistry, PathPolicy, PermissionError } from './permissions.ts'
import { ToolRegistry, stableSignature, type ToolRegistryOptions } from './tools.ts'
import { GatewayError, type ChatTurn, type Gateway } from './gateway.ts'
import {
  assessRisk,
  classify,
  planWorkflow,
  routeTask,
  type DecisionEnvelope,
  type RiskInput,
} from './decision.ts'

const TOOL_START = '<<<NTHN_TOOL>>>'
const TOOL_END = '<<<END_NTHN_TOOL>>>'
const MAX_STEPS = 8
const MAX_CONTEXT_CHARS = 60_000
const MAX_TOOL_MESSAGE_CHARS = 8_000
const RETENTION = 40

export interface ToolIntent {
  tool: string
  arguments: Record<string, unknown>
}

interface FilterResult {
  visible: string
  tools: ToolIntent[]
}

export class ToolStreamFilter {
  private state: 'text' | 'json' = 'text'
  private pending = ''
  private readonly tools: ToolIntent[] = []

  push(chunk: string): FilterResult {
    this.pending += chunk
    return this.drain(false)
  }

  flush(): FilterResult {
    return this.drain(true)
  }

  private drain(final: boolean): FilterResult {
    let visible = ''
    while (this.pending.length > 0) {
      if (this.state === 'text') {
        const index = this.pending.indexOf(TOOL_START)
        if (index === -1) {
          if (final) {
            visible += this.pending
            this.pending = ''
            break
          }
          // Hold back only a suffix that could be the beginning of a marker.
          let hold = 0
          const maximum = Math.min(TOOL_START.length - 1, this.pending.length)
          for (let length = maximum; length > 0; length -= 1) {
            if (this.pending.endsWith(TOOL_START.slice(0, length))) { hold = length; break }
          }
          visible += this.pending.slice(0, this.pending.length - hold)
          this.pending = this.pending.slice(this.pending.length - hold)
          break
        }
        visible += this.pending.slice(0, index)
        this.pending = this.pending.slice(index + TOOL_START.length)
        this.state = 'json'
        continue
      }
      const end = this.pending.indexOf(TOOL_END)
      if (end === -1) {
        if (this.pending.length > 40_000) {
          this.pending = ''
          this.state = 'text'
        }
        break
      }
      const payload = this.pending.slice(0, end).trim()
      this.pending = this.pending.slice(end + TOOL_END.length)
      this.state = 'text'
      if (!payload) continue
      try {
        const parsed = JSON.parse(payload) as unknown
        const items = Array.isArray(parsed) ? parsed : [parsed]
        for (const item of items) {
          if (!item || typeof item !== 'object') continue
          const record = item as Record<string, unknown>
          const tool = record.tool ?? record.name
          const args = record.arguments ?? record.args ?? {}
          if (typeof tool !== 'string' || !args || typeof args !== 'object' || Array.isArray(args)) continue
          this.tools.push({ tool, arguments: args as Record<string, unknown> })
        }
      } catch {
        // Malformed tool blocks are ignored rather than executed.
      }
    }
    const tools = this.tools.splice(0)
    return { visible, tools }
  }
}

export interface DecisionSummary {
  routing: DecisionEnvelope<unknown>
  classification: DecisionEnvelope<unknown>
  risk: DecisionEnvelope<unknown>
  workflow: DecisionEnvelope<unknown>
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

export type Emit = (event: AgentEvent) => void

interface PendingApproval {
  id: string
  conversationId: string
  messageId: string
  callId: string
  tool: string
  arguments: Record<string, unknown>
  signature: string
  expiresAt: number
}

interface AgentOptions {
  name?: string
  store: AgentChatStore
  gateway: Gateway
  workspace?: string
  maxSteps?: number
  now?: () => number
  writablePrefixes?: string[]
  deniedSegments?: string[]
  protectedPaths?: string[]
  taskRoot?: string
  requireCommandApproval?: boolean
  sandboxCommands?: boolean
}

export interface AgentState {
  conversations: ReturnType<AgentChatStore['list']>
  activeId: string | null
  active: Conversation | null
  gateway: ReturnType<Gateway['info']>
  tools: ReturnType<ToolRegistry['list']>
  workspace: string
  protectedPaths: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function defaultWorkspace(): string {
  // server/agent/ -> server/ -> dashboard/ -> apps/ -> repository root
  return resolve(fileURLToPath(new URL('../../../../', import.meta.url)))
}

function toolPrompt(tools: ReturnType<ToolRegistry['list']>): string {
  const lines = tools.map(tool => {
    const args = Object.entries(tool.arguments).map(([name, type]) => `${name}: ${type}`).join(', ')
    return `- ${tool.name}(${args}) — ${tool.description} Approval: ${tool.requiresApproval === true ? 'always' : tool.requiresApproval === 'conditional' ? 'conditional' : 'not required'}.`
  })
  return lines.join('\n')
}

export class AlexAgent {
  private readonly displayName: string
  private readonly store: AgentChatStore
  private readonly gateway: Gateway
  private readonly workspace: string
  private readonly paths: PathPolicy
  private readonly tools: ToolRegistry
  private readonly approvals = new ApprovalRegistry()
  private readonly pending = new Map<string, PendingApproval>()
  private readonly running = new Map<string, AbortController>()
  private readonly maxSteps: number
  private readonly now: () => number
  private readonly protectedPaths: string[]

  constructor(options: AgentOptions) {
    this.displayName = options.name ?? 'Alex'
    this.store = options.store
    this.gateway = options.gateway
    this.workspace = resolve(options.workspace ?? defaultWorkspace())
    this.paths = new PathPolicy({
      root: this.workspace,
      writablePrefixes: options.writablePrefixes ?? ['apps/dashboard'],
      deniedSegments: options.deniedSegments ?? ['.artifacts', '.bootstrap-chunk-transfer', '.bootstrap-transfer'],
    })
    const toolOptions: ToolRegistryOptions = { taskRoot: options.taskRoot, requireCommandApproval: options.requireCommandApproval, sandboxCommands: options.sandboxCommands }
    this.tools = new ToolRegistry(toolOptions)
    this.maxSteps = options.maxSteps ?? MAX_STEPS
    this.now = options.now ?? (() => Date.now())
    this.protectedPaths = options.protectedPaths ?? ['apps/nthn', 'bootstrap', 'Linux/proot', 'terminal', 'Android native environment', 'package configuration']
  }

  async load(): Promise<void> {
    await this.store.load()
    for (const summary of this.store.list()) {
      const conversation = this.store.get(summary.id)
      for (const message of conversation?.messages ?? []) {
        let changed = false
        for (const call of message.toolCalls ?? []) {
          if (call.status !== 'awaiting-approval' || !call.approvalId || !call.approvalExpiresAt) continue
          if (call.approvalExpiresAt <= this.now()) {
            call.status = 'cancelled'
            call.summary = 'Approval expired.'
            changed = true
            continue
          }
          try {
            this.tools.validate(call.tool, call.arguments)
            const signature = stableSignature(call.tool, call.arguments)
            this.approvals.restore({
              id: call.approvalId,
              conversationId: conversation!.id,
              tool: call.tool,
              signature,
              createdAt: call.approvalExpiresAt - 10 * 60_000,
              expiresAt: call.approvalExpiresAt,
            })
            this.pending.set(call.approvalId, {
              id: call.approvalId,
              conversationId: conversation!.id,
              messageId: message.id,
              callId: call.id,
              tool: call.tool,
              arguments: call.arguments,
              signature,
              expiresAt: call.approvalExpiresAt,
            })
          } catch { /* Invalid or expired persisted approvals remain non-executable. */ }
        }
        if (changed) await this.store.update(conversation!.id, message.id, { toolCalls: message.toolCalls })
      }
    }
  }

  state(): AgentState {
    const activeId = this.store.activeId()
    return {
      conversations: this.store.list(),
      activeId,
      active: activeId ? this.store.get(activeId) : null,
      gateway: this.gateway.info(),
      tools: this.tools.list(),
      workspace: this.workspace,
      protectedPaths: this.protectedPaths,
    }
  }

  async newConversation(title?: string): Promise<Conversation> {
    const existing = this.store.list()[0]
    if (existing && existing.messageCount === 0) {
      const conversation = this.store.get(existing.id)
      if (conversation) {
        await this.store.setActive(conversation.id)
        return conversation
      }
    }
    return await this.store.create(title?.trim() || 'New conversation')
  }

  conversation(id: string): Conversation | null {
    return this.store.get(id)
  }

  async select(id: string): Promise<Conversation | null> {
    const conversation = this.store.get(id)
    if (!conversation) return null
    await this.store.setActive(id)
    return conversation
  }

  async remove(id: string): Promise<void> {
    this.cancel(id)
    for (const [approvalId, pending] of this.pending) if (pending.conversationId === id) this.pending.delete(approvalId)
    await this.store.remove(id)
  }

  cancel(conversationId: string): boolean {
    const controller = this.running.get(conversationId)
    if (!controller) return false
    controller.abort()
    return true
  }

  decide(input: unknown): unknown {
    const data = isRecord(input) ? input : {}
    const kind = typeof data.kind === 'string' ? data.kind : 'routing'
    const question = typeof data.question === 'string' ? data.question : 'Advisory decision'
    const context = isRecord(data.context) ? data.context : {}
    switch (kind) {
      case 'classify': return classify(question, String(data.text ?? ''), Array.isArray(data.labels) ? data.labels.map(String) : [], context)
      case 'risk': {
        const base = isRecord(data.input) ? data.input as unknown as RiskInput : { action: question }
        return assessRisk({ ...base, action: question }, context)
      }
      case 'workflow': return planWorkflow(question, context)
      case 'route': return routeTask(question, context)
      default: return routeTask(question, context)
    }
  }

  async run(conversationId: string, text: string, emit: Emit): Promise<void> {
    if (this.running.has(conversationId)) throw new AgentBusyError(this.displayName)
    const conversation = this.store.get(conversationId)
    if (!conversation) throw new PermissionError('no-conversation', 'Conversation not found.')
    const trimmed = text.trim()
    if (!trimmed) throw new PermissionError('empty-message', 'Message is empty.')
    if (trimmed.length > 20_000) throw new PermissionError('message-too-long', 'Message exceeds 20,000 characters.')
    const controller = new AbortController()
    this.running.set(conversationId, controller)
    const decision = this.summarizeDecision(trimmed)
    try {
      await this.store.append(conversationId, { role: 'user', content: trimmed, status: 'complete' })
      await this.drive(conversationId, decision, controller.signal, emit)
    } finally {
      this.running.delete(conversationId)
    }
  }

  async approve(conversationId: string, approvalId: string, approved: boolean, emit: Emit): Promise<void> {
    if (this.running.has(conversationId)) throw new AgentBusyError(this.displayName)
    const pending = this.pending.get(approvalId)
    if (!pending || pending.conversationId !== conversationId || pending.expiresAt <= this.now()) {
      this.pending.delete(approvalId)
      throw new PermissionError('approval-missing', 'Approval request is missing or expired.')
    }
    const conversation = this.store.get(conversationId)
    if (!conversation) throw new PermissionError('no-conversation', 'Conversation not found.')
    const controller = new AbortController()
    this.running.set(conversationId, controller)
    this.pending.delete(approvalId)
    try {
      const assistant = conversation.messages.find(message => message.id === pending.messageId)
      const call = assistant?.toolCalls?.find(item => item.id === pending.callId)
      if (!assistant || !call) throw new PermissionError('approval-missing', 'The original tool request no longer exists.')
      if (!approved) {
        call.status = 'denied'
        call.summary = 'User denied this action.'
        await this.store.update(conversationId, assistant.id, { toolCalls: assistant.toolCalls })
        emit({ type: 'tool-output', conversationId, messageId: assistant.id, call })
        await this.store.append(conversationId, {
          role: 'tool',
          content: `Tool ${pending.tool} was denied by the user. Do not retry it without a new instruction.`,
          status: 'complete',
          meta: { tool: pending.tool, callId: pending.callId, denied: true },
        })
        await this.drive(conversationId, null, controller.signal, emit)
        return
      }
      this.approvals.consume(approvalId, conversationId, pending.tool, pending.signature)
      call.status = 'running'
      await this.store.update(conversationId, assistant.id, { toolCalls: assistant.toolCalls })
      emit({ type: 'tool', conversationId, messageId: assistant.id, call })
      const result = await this.executeTool(pending.tool, pending.arguments, controller.signal)
      call.status = result.ok ? 'succeeded' : 'failed'
      call.summary = result.summary
      call.output = result.output.slice(0, 20_000)
      await this.store.update(conversationId, assistant.id, { toolCalls: assistant.toolCalls })
      emit({ type: 'tool-output', conversationId, messageId: assistant.id, call })
      await this.store.append(conversationId, {
        role: 'tool',
        content: this.toolMessage(pending.tool, result),
        status: 'complete',
        meta: { tool: pending.tool, callId: pending.callId, ok: result.ok },
      })
      await this.drive(conversationId, null, controller.signal, emit)
    } finally {
      this.running.delete(conversationId)
    }
  }

  private summarizeDecision(text: string): DecisionSummary {
    const routing = routeTask(text)
    const classification = classify('Classify the user request', text, ['question', 'investigation', 'code-change', 'verification', 'destructive-change', 'conversation'])
    const risk = assessRisk({
      action: text.slice(0, 500),
      irreversibility: routing.result.requiresApproval ? 0.7 : 0.2,
      blastRadius: routing.result.workflow === 'modify-code' ? 0.4 : 0.2,
      dataLoss: routing.result.workflow === 'destructive-change' ? 0.8 : 0.1,
      externalEffect: routing.result.requiresApproval ? 0.5 : 0.1,
      uncertainty: routing.result.workflow === 'clarify' ? 0.8 : 0.3,
    })
    const workflow = planWorkflow(text)
    return { routing, classification, risk, workflow }
  }

  private buildSystemPrompt(): string {
    return [
      `You are ${this.displayName}, the AI coding and development agent inside NTHN.`,
      'You help the user understand, change, verify and ship code in this repository.',
      '',
      'Operating rules:',
      '- Be concise and technical. Do not pad answers with filler or praise.',
      '- Inspect the existing code before proposing or making changes. Never invent file contents.',
      '- Never fabricate command output, test results, provider behavior or tool results.',
      '- Make the smallest coherent change. Prefer existing conventions over new abstractions.',
      '- Ask a clarifying question when the request is genuinely ambiguous.',
      '- Do not touch protected infrastructure: bootstrap, Linux rootfs/persistence, proot, terminal, Android native environment, APK identity/package configuration, or unrelated services. If a task requires it, stop and explain.',
      '- Do not claim to be a human, and do not claim model capabilities you do not have.',
      '- The local decision engine is advisory. Its confidence is not a measured probability and must not be presented as fact.',
      '',
      'Tools are executed by the NTHN backend. To call a tool, emit exactly one or more blocks in this format:',
      TOOL_START,
      '{"tool":"read_file","arguments":{"path":"apps/dashboard/src/App.tsx"}}',
      TOOL_END,
      'Use relative paths from the workspace root. You may request several tools in one reply.',
      'After a tool runs, its result appears as a TOOL RESULT message. Then continue the task.',
      'Some tools require user approval. If approval is required, the turn pauses and the user decides.',
      'Never put secrets in tool arguments. Never attempt to read .env, credential or key files.',
      '',
      'Available tools:',
      toolPrompt(this.tools.list()),
      '',
      `Workspace root: ${this.workspace}`,
      `Current time: ${new Date().toISOString()}`,
    ].join('\n')
  }

  private buildMessages(conversation: Conversation): ChatTurn[] {
    const messages: ChatTurn[] = [{ role: 'system', content: this.buildSystemPrompt() }]
    const recent = conversation.messages.slice(-RETENTION)
    let used = 0
    const selected: ChatTurn[] = []
    for (let index = recent.length - 1; index >= 0; index -= 1) {
      const message = recent[index]
      if (message.role === 'system') continue
      let content = message.content
      if (message.role === 'assistant' && message.toolCalls?.length) {
        content += `\n\n[Tool requests: ${message.toolCalls.map(call => `${call.tool}(${JSON.stringify(call.arguments)})`).join(', ')}]`
      }
      if (message.role === 'tool') content = content.slice(0, MAX_TOOL_MESSAGE_CHARS)
      if (used + content.length > MAX_CONTEXT_CHARS) break
      used += content.length
      selected.unshift({ role: message.role, content })
    }
    messages.push(...selected)
    return messages
  }

  private async drive(conversationId: string, decision: DecisionSummary | null, signal: AbortSignal, emit: Emit): Promise<void> {
    for (let step = 0; step < this.maxSteps; step += 1) {
      if (signal.aborted) {
        emit({ type: 'cancelled', conversationId, messageId: '' })
        return
      }
      const conversation = this.store.get(conversationId)
      if (!conversation) return
      const assistant = await this.store.append(conversationId, { role: 'assistant', content: '', status: 'streaming', toolCalls: [] })
      emit({ type: 'start', conversationId, messageId: assistant.id })
      if (decision) {
        await this.store.update(conversationId, assistant.id, { decision })
        emit({ type: 'decision', conversationId, messageId: assistant.id, decision })
        decision = null
      }
      const filter = new ToolStreamFilter()
      let content = ''
      let lastPersist = this.now()
      const intents: ToolIntent[] = []
      let failed: unknown = null
      try {
        for await (const delta of this.gateway.stream(this.buildMessages(conversation), { signal })) {
          if (signal.aborted) break
          const result = filter.push(delta)
          if (result.tools.length) intents.push(...result.tools)
          if (result.visible) {
            content += result.visible
            emit({ type: 'delta', conversationId, messageId: assistant.id, text: result.visible })
            if (this.now() - lastPersist > 750) {
              lastPersist = this.now()
              await this.store.update(conversationId, assistant.id, { content })
            }
          }
        }
        const tail = filter.flush()
        if (tail.tools.length) intents.push(...tail.tools)
        if (tail.visible) {
          content += tail.visible
          emit({ type: 'delta', conversationId, messageId: assistant.id, text: tail.visible })
        }
      } catch (error) {
        failed = error
      }
      if (signal.aborted) {
        await this.store.update(conversationId, assistant.id, { content, status: 'cancelled' })
        emit({ type: 'cancelled', conversationId, messageId: assistant.id })
        return
      }
      if (failed) {
        const error = failed instanceof GatewayError ? failed : new GatewayError('GATEWAY_ERROR', 'The model request failed.')
        const note = content ? `${content}\n\n[Request failed: ${error.message}]` : `[Request failed: ${error.message}]`
        await this.store.update(conversationId, assistant.id, { content: note, status: 'error' })
        emit({ type: 'error', conversationId, message: error.message, code: error.code })
        return
      }
      if (intents.length === 0) {
        await this.store.update(conversationId, assistant.id, { content, status: 'complete' })
        emit({ type: 'done', conversationId, messageId: assistant.id, stopped: false })
        return
      }
      const calls: ToolCallRecord[] = []
      for (const intent of intents) {
        calls.push({ id: randomUUID(), tool: intent.tool, arguments: intent.arguments, status: 'proposed' })
      }
      await this.store.update(conversationId, assistant.id, { content, status: 'complete', toolCalls: calls })
      for (let index = 0; index < calls.length; index += 1) {
        const call = calls[index]
        const intent = intents[index]
        let definition
        try {
          definition = this.tools.get(call.tool)
          this.tools.validate(call.tool, call.arguments)
        } catch (error) {
          call.status = 'failed'
          call.summary = error instanceof PermissionError ? error.message : 'Invalid tool request.'
          await this.store.update(conversationId, assistant.id, { toolCalls: calls })
          emit({ type: 'tool-output', conversationId, messageId: assistant.id, call })
          await this.store.append(conversationId, {
            role: 'tool',
            content: `Tool ${call.tool} was rejected before execution: ${call.summary}`,
            status: 'complete',
            meta: { tool: call.tool, callId: call.id, ok: false },
          })
          continue
        }
        const signature = stableSignature(call.tool, call.arguments)
        if (this.tools.needsApproval(call.tool, call.arguments)) {
          const ticket = this.approvals.issue(conversationId, call.tool, signature)
          call.status = 'awaiting-approval'
          call.approvalId = ticket.id
          call.approvalExpiresAt = ticket.expiresAt
          call.summary = definition.summarize(call.arguments)
          await this.store.update(conversationId, assistant.id, { toolCalls: calls })
          this.pending.set(ticket.id, {
            id: ticket.id, conversationId, messageId: assistant.id, callId: call.id,
            tool: call.tool, arguments: intent.arguments, signature, expiresAt: ticket.expiresAt,
          })
          emit({ type: 'approval', conversationId, messageId: assistant.id, call, approvalId: ticket.id })
          return
        }
        call.status = 'running'
        call.summary = definition.summarize(call.arguments)
        await this.store.update(conversationId, assistant.id, { toolCalls: calls })
        emit({ type: 'tool', conversationId, messageId: assistant.id, call })
        const result = await this.executeTool(call.tool, call.arguments, signal)
        call.status = result.ok ? 'succeeded' : 'failed'
        call.summary = result.summary
        call.output = result.output.slice(0, 20_000)
        await this.store.update(conversationId, assistant.id, { toolCalls: calls })
        emit({ type: 'tool-output', conversationId, messageId: assistant.id, call })
        await this.store.append(conversationId, {
          role: 'tool',
          content: this.toolMessage(call.tool, result),
          status: 'complete',
          meta: { tool: call.tool, callId: call.id, ok: result.ok },
        })
      }
    }
    const conversation = this.store.get(conversationId)
    if (conversation) {
      const last = conversation.messages.at(-1)
      emit({ type: 'error', conversationId, message: `Reached the ${this.maxSteps}-step limit. Ask ${this.displayName} to continue.`, code: 'STEP_LIMIT' })
      if (last?.role === 'assistant') await this.store.update(conversationId, last.id, { status: 'complete' })
    }
  }

  private async executeTool(name: string, args: Record<string, unknown>, signal: AbortSignal) {
    try {
      return await this.tools.execute(name, args, {
        workspace: this.workspace,
        paths: this.paths,
        signal,
        timeoutMs: 120_000,
      })
    } catch (error) {
      const message = error instanceof PermissionError ? error.message : 'The tool failed before producing output.'
      return { ok: false, summary: message, output: message }
    }
  }

  private toolMessage(tool: string, result: { ok: boolean; summary: string; output: string; truncated?: boolean }): string {
    const status = result.ok ? 'succeeded' : 'failed'
    const output = result.output.length > MAX_TOOL_MESSAGE_CHARS ? `${result.output.slice(0, MAX_TOOL_MESSAGE_CHARS)}\n…[truncated]` : result.output
    return `Tool ${tool} ${status}: ${result.summary}\n${output}`
  }
}

export class AgentBusyError extends Error {
  readonly code = 'AGENT_BUSY'
  constructor(agentName = 'Alex') {
    super(`${agentName} is already working in this conversation.`)
    this.name = 'AgentBusyError'
  }
}
