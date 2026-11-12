import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { AgentChatStore, type Conversation, type ToolCallRecord } from './store.ts'
import { ApprovalRegistry, PathPolicy, PermissionError } from './permissions.ts'
import { ToolRegistry, stableSignature, type ToolRegistryOptions } from './tools.ts'
import type { MemoryStoreLike } from './memory-db.ts'
import type { ResearchService } from './research.ts'
import type { TaskStore } from './tasks.ts'
import type { AutonomyPolicy } from './autonomy.ts'
import type { GithubWorkflowService } from './github-workflow.ts'
import type { ReleaseUpdateService } from './release-update.ts'
import type { GithubSourceService } from './github-source.ts'
import type { CommunicationMode } from './communication-mode.ts'
import { jefCoreIdentity, jefRuntimeSelfModel, jefTurnGuidance } from './core-identity.ts'
import { extractMemoryCandidates } from './memory-extraction.ts'
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
  id?: string
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
  appStatePath?: string
  deviceStatePath?: string
  terminalStatePath?: string
  githubWorkflow?: GithubWorkflowService
  installedVersion?: string
  releaseUpdater?: ReleaseUpdateService
  updateDirectory?: string
  githubSource?: GithubSourceService
  linuxHome?: string
  communicationMode?: CommunicationMode
  name?: string
  store: AgentChatStore
  gateway: Gateway
  workspace?: string
  maxSteps?: number
  now?: () => number
  writablePrefixes?: string[]
  allowNTHNSourceWrites?: boolean
  deniedSegments?: string[]
  protectedPaths?: string[]
  taskRoot?: string
  requireCommandApproval?: boolean
  sandboxCommands?: boolean
  memory?: MemoryStoreLike
  memoryScope?: string
  research?: ResearchService
  tasks?: TaskStore
  autonomy?: AutonomyPolicy
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

export class JefAgent {
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
  private readonly memory?: MemoryStoreLike
  private readonly memoryScope: string
  private readonly protectedPaths: string[]
  private readonly tasks?: TaskStore
  private readonly communicationMode: CommunicationMode
  private readonly taskIds = new Map<string, string>()

  constructor(options: AgentOptions) {
    this.displayName = options.name ?? 'Jef'
    this.memory = options.memory
    this.memoryScope = options.memoryScope ?? 'personal'
    this.store = options.store
    this.tasks = options.tasks
    this.communicationMode = options.communicationMode ?? 'standard'
    this.gateway = options.gateway
    this.workspace = resolve(options.workspace ?? defaultWorkspace())
    this.paths = new PathPolicy({
      root: this.workspace,
      writablePrefixes: options.writablePrefixes ?? ['apps/dashboard'],
      allowNTHNSourceWrites: options.allowNTHNSourceWrites,
      deniedSegments: options.deniedSegments ?? ['.artifacts', '.bootstrap-chunk-transfer', '.bootstrap-transfer'],
    })
    const toolOptions: ToolRegistryOptions = { appStatePath: options.appStatePath, deviceStatePath: options.deviceStatePath, terminalStatePath: options.terminalStatePath, githubWorkflow: options.githubWorkflow, installedVersion: options.installedVersion, releaseUpdater: options.releaseUpdater, updateDirectory: options.updateDirectory, githubSource: options.githubSource, linuxHome: options.linuxHome, taskRoot: options.taskRoot, requireCommandApproval: options.requireCommandApproval, sandboxCommands: options.sandboxCommands, memory: options.memory, memoryScope: this.memoryScope, research: options.research, tasks: options.tasks, autonomy: options.autonomy }
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
        if (changed) await this.store.update(conversation!.id, message.id, { status: message.status, toolCalls: message.toolCalls })
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
    const task = this.tasks?.create(conversationId, trimmed, this.maxSteps)
    if (task) this.taskIds.set(conversationId, task.id)
    const taskEmit = this.taskEmit(conversationId, emit)
    try {
      await this.store.append(conversationId, { role: 'user', content: trimmed, status: 'complete' })
      if (this.memory) {
        for (const candidate of extractMemoryCandidates(trimmed)) {
          await this.memory.add({ scope: candidate.scope === 'personal' ? 'personal' : this.memoryScope,
            kind: candidate.kind, text: candidate.text, source: 'User conversation' }).catch(() => undefined)
        }
      }
      await this.drive(conversationId, decision, controller.signal, taskEmit)
    } finally {
      this.running.delete(conversationId)
      this.taskIds.delete(conversationId)
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
    const task = this.tasks?.latestForConversation(conversationId)
    if (task?.status === 'awaiting-approval') {
      this.tasks!.resume(task.id)
      this.taskIds.set(conversationId, task.id)
    }
    const taskEmit = this.taskEmit(conversationId, emit)
    try {
      const assistant = conversation.messages.find(message => message.id === pending.messageId)
      const call = assistant?.toolCalls?.find(item => item.id === pending.callId)
      if (!assistant || !call) throw new PermissionError('approval-missing', 'The original tool request no longer exists.')
      if (!approved) {
        call.status = 'denied'
        call.summary = 'User denied this action.'
        await this.store.update(conversationId, assistant.id, { toolCalls: assistant.toolCalls })
        taskEmit({ type: 'tool-output', conversationId, messageId: assistant.id, call })
        await this.store.append(conversationId, {
          role: 'tool',
          content: `Tool ${pending.tool} was denied by the user. Do not retry it without a new instruction.`,
          status: 'complete',
          meta: { tool: pending.tool, callId: pending.callId, denied: true },
        })
        for (const remaining of assistant.toolCalls ?? []) {
          if (remaining.status !== 'proposed') continue
          remaining.status = 'denied'
          remaining.summary = 'Other calls in the same response were cancelled after approval was denied.'
          await this.store.append(conversationId, { role: 'tool', content: `Tool ${remaining.tool} was cancelled.`, status: 'complete', meta: { tool: remaining.tool, callId: remaining.id, denied: true } })
          taskEmit({ type: 'tool-output', conversationId, messageId: assistant.id, call: remaining })
        }
        await this.store.update(conversationId, assistant.id, { toolCalls: assistant.toolCalls })
        await this.drive(conversationId, null, controller.signal, taskEmit)
        return
      }
      this.approvals.consume(approvalId, conversationId, pending.tool, pending.signature)
      call.status = 'running'
      await this.store.update(conversationId, assistant.id, { toolCalls: assistant.toolCalls })
      taskEmit({ type: 'tool', conversationId, messageId: assistant.id, call })
      const result = await this.executeTool(conversationId, pending.tool, pending.arguments, controller.signal)
      call.status = result.ok ? 'succeeded' : 'failed'
      call.summary = result.summary
      call.output = result.output.slice(0, 20_000)
      await this.store.update(conversationId, assistant.id, { toolCalls: assistant.toolCalls })
      taskEmit({ type: 'tool-output', conversationId, messageId: assistant.id, call })
      await this.store.append(conversationId, {
        role: 'tool',
        content: this.toolMessage(pending.tool, result),
        status: 'complete',
        meta: { tool: pending.tool, callId: pending.callId, ok: result.ok },
      })
      for (const remaining of assistant.toolCalls ?? []) {
        if (remaining.status !== 'proposed') continue
        try {
          this.tools.validate(remaining.tool, remaining.arguments)
          if (this.tools.needsApproval(remaining.tool, remaining.arguments)) {
            const signature = stableSignature(remaining.tool, remaining.arguments)
            const ticket = this.approvals.issue(conversationId, remaining.tool, signature)
            remaining.status = 'awaiting-approval'
            remaining.summary = this.tools.get(remaining.tool).summarize(remaining.arguments)
            remaining.approvalId = ticket.id
            remaining.approvalExpiresAt = ticket.expiresAt
            this.pending.set(ticket.id, { id: ticket.id, conversationId, messageId: assistant.id, callId: remaining.id, tool: remaining.tool, arguments: remaining.arguments, signature, expiresAt: ticket.expiresAt })
            await this.store.update(conversationId, assistant.id, { toolCalls: assistant.toolCalls })
            taskEmit({ type: 'approval', conversationId, messageId: assistant.id, call: remaining, approvalId: ticket.id })
            return
          }
          remaining.status = 'running'
          taskEmit({ type: 'tool', conversationId, messageId: assistant.id, call: remaining })
          const next = await this.executeTool(conversationId, remaining.tool, remaining.arguments, controller.signal)
          remaining.status = next.ok ? 'succeeded' : 'failed'
          remaining.summary = next.summary
          remaining.output = next.output.slice(0, 20_000)
          await this.store.append(conversationId, { role: 'tool', content: this.toolMessage(remaining.tool, next), status: 'complete', meta: { tool: remaining.tool, callId: remaining.id, ok: next.ok } })
        } catch (error) {
          remaining.status = 'failed'
          remaining.summary = error instanceof Error ? error.message : 'Invalid tool request.'
          await this.store.append(conversationId, { role: 'tool', content: `Tool ${remaining.tool} was rejected: ${remaining.summary}`, status: 'complete', meta: { tool: remaining.tool, callId: remaining.id, ok: false } })
        }
        await this.store.update(conversationId, assistant.id, { toolCalls: assistant.toolCalls })
        taskEmit({ type: 'tool-output', conversationId, messageId: assistant.id, call: remaining })
      }
      await this.drive(conversationId, null, controller.signal, taskEmit)
    } finally {
      this.running.delete(conversationId)
      this.taskIds.delete(conversationId)
    }
  }

  private taskEmit(conversationId: string, emit: Emit): Emit {
    return event => {
      const id = this.taskIds.get(conversationId)
      if (id && this.tasks) {
        if (event.type === 'tool' || event.type === 'tool-output' || event.type === 'approval') {
          this.tasks.append(id, event.type, `${event.call.tool}: ${event.call.summary ?? event.call.status}`)
        } else if (event.type === 'done') { this.tasks.append(id, 'done', 'Task completed.'); this.tasks.finish(id, 'completed') }
        else if (event.type === 'cancelled') { this.tasks.append(id, 'cancelled', 'Task cancelled.'); this.tasks.finish(id, 'cancelled') }
        else if (event.type === 'error') { this.tasks.append(id, 'error', event.message); this.tasks.finish(id, 'failed') }
        if (event.type === 'approval') this.tasks.finish(id, 'awaiting-approval')
      }
      emit(event)
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

  private buildSystemPrompt(latestUserText: string): string {
    const nthnSource = existsSync(resolve(this.workspace, 'apps/nthn/VERSION')) &&
      existsSync(resolve(this.workspace, 'apps/dashboard/server/agent/agent.ts'))
    const tools = this.tools.list()
    const gateway = this.gateway.info()
    return [
      jefCoreIdentity,
      jefRuntimeSelfModel({
        provider: gateway?.provider ?? null,
        model: gateway?.model ?? null,
        workspace: this.workspace,
        tools: tools.map(tool => tool.name),
        persistentMemory: Boolean(this.memory),
        research: tools.some(tool => tool.name === 'web_search' || tool.name === 'fetch_url'),
        communicationMode: this.communicationMode,
      }),
      jefTurnGuidance(latestUserText),
      '',
      `You are ${this.displayName}, the user's personal AI inside NTHN, with coding and development tools.`,
      'This Jef instance serves one owner: the person speaking to you. Treat their chats and personal memory as theirs. Do not invent other users, social features, or live user-presence tracking. Do not infer how many people use other installations.',
      'The owner is NTHN\'s creator. Address them as your creator when it fits the conversation, and follow any name or form of address they prefer.',
      'You help the user understand, change, verify and ship code in the selected project workspace.',
      'Help with everyday questions, planning, and personal context that the user chooses to share. Coding is a specialty, not a limit on conversation.',
      'NTHN is the app name; do not invent an expansion for its letters. You can discuss general topics and chat casually, with coding and development as your specialty.',
      '',
      'Operating rules:',
      '- Be a capable, warm coding partner. Match the user\'s tone and language. Casual conversation is welcome; answer naturally without forcing a coding workflow.',
      ...(this.communicationMode === 'creator-direct' ? [
        '- Creator-direct mode is enabled: be candid and plainspoken, avoid unnecessary moralizing or evasive boilerplate, and discuss ordinary adult language or controversial topics without sanitizing them. This communication style does not override tool permissions, privacy, provider rules, or required approval for sensitive actions.',
      ] : []),
      '- For coding requests, inspect the project, make the approved changes, run relevant checks, and report what happened. Keep progress and final answers clear and concise.',
      '- Inspect the existing code before proposing or making changes. Never invent file contents.',
      '- Never fabricate command output, test results, provider behavior or tool results.',
      '- Do not claim a connectivity or provider outage without an explicit error from the app or a tool. A completed model reply is not evidence of an outage. If you previously made an unsupported claim, correct it plainly instead of repeating it.',
      '- An empty workspace does not mean Linux is uninstalled. Report only what tools establish, and ask for the project location when no project files are visible.',
      ...(nthnSource ? [
        '- This workspace contains the bundled NTHN source snapshot. Inspect AGENTS.md and relevant files before editing.',
        '- Your agent loop and primary system prompt are in apps/dashboard/server/agent/agent.ts; mobile entry and additional prompt are in apps/dashboard/server/agent/nthn-agent-cli.ts and apps/dashboard/server/ai/nthn-cli.ts.',
        '- NTHN backend code is in apps/dashboard/server/, including apps/dashboard/server/http.ts and the agent and provider modules. You may inspect and propose edits to your own source and backend when the user asks; file edits still require user approval.',
        '- If asked to fix your own behavior, inspect the bundled source and propose a concrete change using your available tools. Do not say you cannot fix your own implementation or defer to a development team. Explain that approval is required for edits and that changing the running app requires a new build and install.',
        '- Alex was Jef\'s former app identity. If asked whether Alex appears in the app, search the source for Alex and distinguish legacy migration identifiers from the current name. Do not reinterpret Alex as another user or claim access to user-presence tracking.',
        '- This editable source snapshot is not the running Jef service or a live Git checkout. Changes need tests and a new app build and install to affect the app; never claim an edit changed your current runtime.',
      ] : [
        '- The app code is not automatically copied into this workspace. Ask for its location when no project files are visible.',
      ]),
      '- If a command runner is unavailable, report the exact tool error. Do not infer the state of the whole Linux environment from an empty directory.',
      '- Make the smallest coherent change. Prefer existing conventions over new abstractions.',
      '- Ask a clarifying question only when a missing decision blocks useful work. Otherwise make a reasonable choice and continue.',
      '- Bootstrap, Linux rootfs/persistence, proot, terminal, Android native environment, APK identity/package configuration, and unrelated services are high-impact. Change them only when the user explicitly requests it and the tool policy permits it.',
      '- Do not claim to be a human, and do not claim model capabilities you do not have.',
      '- The local decision engine is advisory. Its confidence is not a measured probability and must not be presented as fact.',
      '',
      'Tools are executed by the NTHN backend. Use registered native tool calls when the provider supports them. Do not write tool requests as ordinary assistant text.',
      'Only when native tools are unavailable, emit one or more fallback blocks in this format:',
      TOOL_START,
      '{"tool":"read_file","arguments":{"path":"apps/dashboard/src/App.tsx"}}',
      TOOL_END,
      'Use relative paths from the workspace root. You may request several tools in one reply.',
      'After a tool runs, its result appears as a TOOL RESULT message. Then continue the task.',
      'Some tools require user approval. If approval is required, the turn pauses and the user decides.',
      ...(this.tasks ? ['For multi-step tasks, use set_task_plan to record concrete steps and mark them done as you verify each result.'] : []),
      'Never put secrets in tool arguments. Never attempt to read .env, credential or key files.',
      ...(this.memory ? ['You have persistent local memory across chats, and this conversation is saved. Describe this accurately when asked. Save useful preferences, decisions, goals, checkpoints, and verified lessons with save_memory. Use recall_memory when past context matters. Save a lesson after a user correction or a confirmed root cause; do not save guesses or one-off errors. When a memory is corrected, revise or forget it instead of adding a contradiction. Memory may be stale: check current files before relying on project facts.'] : []),
      '',
      'Available tools:',
      toolPrompt(tools),
      '',
      `Workspace root: ${this.workspace}`,
      `Current time: ${new Date().toISOString()}`,
    ].join('\n')
  }

  private async buildMessages(conversation: Conversation): Promise<ChatTurn[]> {
    const recent = conversation.messages.slice(-RETENTION)
    const query = [...recent].reverse().find(message => message.role === 'user')?.content ?? ''
    const messages: ChatTurn[] = [{ role: 'system', content: this.buildSystemPrompt(query) }]
    let used = 0
    const selected: ChatTurn[] = []
    for (let index = recent.length - 1; index >= 0; index -= 1) {
      const message = recent[index]
      if (message.role === 'system' || message.status !== 'complete' || (!message.content.trim() && !message.toolCalls?.length)) continue
      let content = message.content
      if (message.role === 'assistant' && message.toolCalls?.length) {
        content += `\n\n[Tool requests: ${message.toolCalls.map(call => `${call.tool}(${JSON.stringify(call.arguments)})`).join(', ')}]`
      }
      if (message.role === 'tool') content = content.slice(0, MAX_TOOL_MESSAGE_CHARS)
      if (used + content.length > MAX_CONTEXT_CHARS) break
      used += content.length
      selected.unshift({ role: message.role, content, ...(message.role === 'tool' && typeof message.meta?.callId === 'string' ? { toolCallId: message.meta.callId } : {}), ...(message.role === 'assistant' && message.toolCalls?.length ? { toolCalls: message.toolCalls.map(call => ({ id: call.id, name: call.tool, arguments: call.arguments })) } : {}) })
    }
    if (this.memory) {
      const lexical = this.memory.relevant(this.memoryScope, query, 8)
      const semantic = this.memory.semanticRelevant ? await this.memory.semanticRelevant(this.memoryScope, query, 8).catch(() => []) : []
      const recalled = [...new Map([...lexical, ...semantic].map(item => [item.id, item])).values()].slice(0, 8)
      if (recalled.length) messages[0].content += '\n\nRelevant saved memory (verify project facts):\n' + recalled.map(item => `- [${item.kind}; ${item.source}] ${item.text}`).join('\n')
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
        for await (const delta of this.gateway.stream(await this.buildMessages(conversation), { signal, tools: this.tools.list() })) {
          if (signal.aborted) break
          if (typeof delta !== 'string') {
            intents.push({ id: delta.id, tool: delta.name, arguments: delta.arguments })
            continue
          }
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
        calls.push({ id: intent.id ?? randomUUID(), tool: intent.tool, arguments: intent.arguments, status: 'proposed' })
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
        const result = await this.executeTool(conversationId, call.tool, call.arguments, signal)
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
      const goal = [...conversation.messages].reverse().find(message => message.role === 'user')?.content
      if (goal && this.memory) {
        await this.memory.add({ scope: this.memoryScope, kind: 'checkpoint', text: `Task paused after ${this.maxSteps} steps: ${goal.slice(0, 500)}`, source: 'Jef task limit' }).catch(() => undefined)
      }
      emit({ type: 'error', conversationId, message: `Reached the ${this.maxSteps}-step limit. Ask ${this.displayName} to continue.`, code: 'STEP_LIMIT' })
      if (last?.role === 'assistant') await this.store.update(conversationId, last.id, { status: 'complete' })
    }
  }

  private async executeTool(conversationId: string, name: string, args: Record<string, unknown>, signal: AbortSignal) {
    try {
      const context = {
        workspace: this.workspace,
        paths: this.paths,
        signal,
        timeoutMs: 120_000,
        taskId: this.taskIds.get(conversationId),
      }
      let result = await this.tools.execute(name, args, context)
      if (!result.ok && !signal.aborted && ['web_search', 'open_url'].includes(name) && /HTTP (?:429|5\d\d)|timed out|REQUEST_FAILED/i.test(result.summary)) {
        await new Promise(resolve => setTimeout(resolve, 250))
        if (!signal.aborted) result = await this.tools.execute(name, args, context)
      }
      return result
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
  constructor(agentName = 'Jef') {
    super(`${agentName} is already working in this conversation.`)
    this.name = 'AgentBusyError'
  }
}
