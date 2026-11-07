import type { AgentAssignments } from '../ai/agent-assignments.ts'
import { connectionAdapter } from '../ai/connection-adapters.ts'
import type { ConnectionManager } from '../ai/connection-manager.ts'
import type { ModelRoute } from '../ai/contracts.ts'
import { ManagementError } from '../ai/management-types.ts'
import { ProviderError, type ModelMessage, type ModelProvider } from '../providers.ts'

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool'

export interface ChatTurn {
  role: ChatRole
  content: string
  name?: string
}

export interface GatewayInfo {
  provider: string
  model: string
  transport: 'streaming' | 'buffered'
}

export class GatewayError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'GatewayError'
    this.code = code
  }
}

export interface Gateway {
  info(): GatewayInfo | null
  stream(messages: ChatTurn[], options?: { signal?: AbortSignal; maxTokens?: number }): AsyncGenerator<string>
}

function friendly(error: unknown): GatewayError {
  if (error instanceof GatewayError) return error
  if (error instanceof ManagementError) {
    const messages: Record<string, string> = {
      CONNECTION_DISABLED: 'The assigned provider connection is disabled.',
      CREDENTIAL_REQUIRED: 'The assigned provider has no credential.',
      AUTH_REJECTED: 'The provider rejected the credential.',
      RATE_LIMITED: 'The provider rate limit was reached. Try again later.',
      INSUFFICIENT_CREDITS: 'The provider account has insufficient credits.',
      MODEL_UNAVAILABLE: 'The assigned model is no longer available.',
      INCOMPATIBLE: 'The provider rejected the request shape.',
      REDIRECT_BLOCKED: 'The provider attempted a redirect, which is blocked.',
      RESPONSE_LIMIT: 'The provider response exceeded the size limit.',
      REQUEST_FAILED: 'The provider request failed.',
      PROBE_FAILED: 'The provider request failed.',
    }
    return new GatewayError(error.code, messages[error.code] ?? 'The provider request failed.')
  }
  if (error instanceof ProviderError) return new GatewayError(error.code, error.message)
  if (error instanceof Error && error.name === 'AbortError') return new GatewayError('CANCELLED', 'Request cancelled.')
  return new GatewayError('GATEWAY_ERROR', 'The model request failed.')
}

function turnsForProvider(messages: ChatTurn[]): { system: string; turns: { role: 'user' | 'assistant'; content: string }[] } {
  const system = messages.filter(message => message.role === 'system').map(message => message.content).join('\n\n')
  const turns: { role: 'user' | 'assistant'; content: string }[] = []
  for (const message of messages) {
    if (message.role === 'system') continue
    const role = message.role === 'assistant' ? 'assistant' : 'user'
    const prefix = message.role === 'tool' ? `TOOL RESULT${message.name ? ` (${message.name})` : ''}:\n` : ''
    const content = prefix + message.content
    const previous = turns.at(-1)
    if (previous && previous.role === role) previous.content += `\n\n${content}`
    else turns.push({ role, content })
  }
  return { system, turns }
}

export function requestBody(route: ModelRoute, messages: ChatTurn[], stream: boolean, maxTokens = 4000): Record<string, unknown> {
  const protocol = connectionAdapter(route.providerId).protocol
  const model = route.ref.nativeModelId
  const { system, turns } = turnsForProvider(messages)
  if (protocol === 'ollama-chat') {
    return { model, messages: messages.map(message => ({ role: message.role === 'tool' ? 'user' : message.role, content: message.content })), stream, options: { num_predict: maxTokens } }
  }
  if (protocol === 'anthropic-messages') {
    return { model, messages: turns, ...(system ? { system } : {}), max_tokens: maxTokens, ...(stream ? { stream: true } : {}) }
  }
  if (protocol === 'gemini-generate-content') {
    return {
      model,
      contents: turns.map(turn => ({ role: turn.role === 'assistant' ? 'model' : 'user', parts: [{ text: turn.content }] })),
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      generationConfig: { maxOutputTokens: maxTokens },
    }
  }
  return {
    model,
    messages: [
      ...(system ? [{ role: 'system', content: system }] : []),
      ...turns.map(turn => ({ role: turn.role, content: turn.content })),
    ],
    stream,
    max_tokens: maxTokens,
    ...(route.providerId === 'openrouter' ? { provider: { require_parameters: true } } : {}),
  }
}

export class AssignedGateway implements Gateway {
  private readonly manager: ConnectionManager
  private readonly assignments: AgentAssignments
  private readonly agentId: string
  private last: GatewayInfo | null = null

  constructor(manager: ConnectionManager, assignments: AgentAssignments, agentId = '01') {
    this.manager = manager
    this.assignments = assignments
    this.agentId = agentId
  }

  info(): GatewayInfo | null {
    return this.last
  }

  private async resolve(): Promise<ModelRoute> {
    let resolved: Awaited<ReturnType<AgentAssignments['resolve']>>
    try {
      resolved = await this.assignments.resolve(this.agentId)
    } catch (error) {
      throw friendly(error)
    }
    if (!resolved.primary) throw new GatewayError('NO_MODEL', 'No verified compatible model is assigned to Alex. Configure and verify one in AI Providers.')
    return resolved.primary
  }

  async *stream(messages: ChatTurn[], options: { signal?: AbortSignal; maxTokens?: number } = {}): AsyncGenerator<string> {
    const route = await this.resolve()
    this.last = { provider: route.providerId, model: route.ref.nativeModelId, transport: 'streaming' }
    const body = requestBody(route, messages, true, options.maxTokens)
    const protocol = connectionAdapter(route.providerId).protocol
    const parser = createParser(protocol)
    let emitted = false
    let raw = ''
    try {
      for await (const chunk of this.manager.streamInference(route.ref.connectionId, route.connectionRevision, body, options.signal)) {
        raw += chunk
        for (const delta of parser.push(chunk)) {
          if (delta) { emitted = true; yield delta }
        }
      }
      for (const delta of parser.flush()) {
        if (delta) { emitted = true; yield delta }
      }
    } catch (error) {
      throw friendly(error)
    }
    if (!emitted) {
      const text = fallbackText(raw, protocol)
      if (text) yield text
    }
  }
}

export class RouterGateway implements Gateway {
  private readonly router: { current(): ModelProvider | null }
  constructor(router: { current(): ModelProvider | null }) {
    this.router = router
  }

  info(): GatewayInfo | null {
    const provider = this.router.current()
    if (!provider) return null
    return { provider: provider.info.id, model: provider.info.model, transport: 'buffered' }
  }

  async *stream(messages: ChatTurn[], options: { signal?: AbortSignal } = {}): AsyncGenerator<string> {
    const provider = this.router.current()
    if (!provider) throw new GatewayError('NO_MODEL', 'No model provider is configured. Add a provider in AI Providers.')
    const mapped: ModelMessage[] = messages.map(message => ({ role: message.role === 'assistant' ? 'assistant' : message.role === 'system' ? 'system' : 'user', content: message.content }))
    let text: string
    try {
      if (options.signal?.aborted) throw new GatewayError('CANCELLED', 'Request cancelled.')
      text = await provider.complete(mapped)
    } catch (error) {
      throw friendly(error)
    }
    const pieces = text.match(/[\s\S]{1,120}/g) ?? []
    for (const piece of pieces) {
      if (options.signal?.aborted) throw new GatewayError('CANCELLED', 'Request cancelled.')
      yield piece
    }
  }
}

/** Prefer the verified saved Alex assignment; fall back to environment providers. */
export class AutoGateway implements Gateway {
  private readonly assigned: AssignedGateway | null
  private readonly router: RouterGateway
  private readonly hasAssignment: () => boolean

  constructor(assigned: AssignedGateway | null, router: RouterGateway, hasAssignment: () => boolean) {
    this.assigned = assigned
    this.router = router
    this.hasAssignment = hasAssignment
  }

  info(): GatewayInfo | null {
    if (this.assigned && this.hasAssignment()) {
      return this.assigned.info() ?? { provider: 'assigned', model: 'verified assignment', transport: 'streaming' }
    }
    return this.router.info()
  }

  async *stream(messages: ChatTurn[], options: { signal?: AbortSignal; maxTokens?: number } = {}): AsyncGenerator<string> {
    if (this.assigned && this.hasAssignment()) {
      yield* this.assigned.stream(messages, options)
      return
    }
    yield* this.router.stream(messages, options)
  }
}

type Protocol = 'openai-chat' | 'ollama-chat' | 'anthropic-messages' | 'gemini-generate-content'

interface DeltaParser {
  push(chunk: string): string[]
  flush(): string[]
}

function parsePayload(protocol: Protocol, payload: string): string {
  let data: unknown
  try { data = JSON.parse(payload) } catch { return '' }
  if (!data || typeof data !== 'object') return ''
  const value = data as Record<string, unknown>
  if (protocol === 'openai-chat') {
    const choices = value.choices as { delta?: { content?: unknown } }[] | undefined
    const content = choices?.[0]?.delta?.content
    return typeof content === 'string' ? content : ''
  }
  if (protocol === 'anthropic-messages') {
    const type = value.type
    if (type === 'content_block_delta') {
      const delta = value.delta as { text?: unknown } | undefined
      return typeof delta?.text === 'string' ? delta.text : ''
    }
    if (type === 'content_block_start') {
      const block = value.content_block as { text?: unknown } | undefined
      return typeof block?.text === 'string' ? block.text : ''
    }
    return ''
  }
  if (protocol === 'gemini-generate-content') {
    const candidates = value.candidates as { content?: { parts?: { text?: unknown }[] } }[] | undefined
    return (candidates?.[0]?.content?.parts ?? []).map(part => typeof part.text === 'string' ? part.text : '').join('')
  }
  const message = value.message as { content?: unknown } | undefined
  return typeof message?.content === 'string' ? message.content : ''
}

function createParser(protocol: Protocol): DeltaParser {
  let buffer = ''
  const isSse = protocol !== 'ollama-chat'
  return {
    push(chunk: string): string[] {
      buffer += chunk
      const results: string[] = []
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        let line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        if (line.endsWith('\r')) line = line.slice(0, -1)
        if (isSse) {
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trimStart()
          if (!payload || payload === '[DONE]') continue
          const delta = parsePayload(protocol, payload)
          if (delta) results.push(delta)
        } else {
          if (!line.trim()) continue
          const delta = parsePayload(protocol, line)
          if (delta) results.push(delta)
        }
      }
      return results
    },
    flush(): string[] {
      const remaining = buffer.trim()
      buffer = ''
      if (!remaining) return []
      if (isSse) {
        const lines = remaining.split('\n')
        const results: string[] = []
        for (let line of lines) {
          if (line.endsWith('\r')) line = line.slice(0, -1)
          if (line.startsWith('data:')) {
            const payload = line.slice(5).trimStart()
            if (payload && payload !== '[DONE]') {
              const delta = parsePayload(protocol, payload)
              if (delta) results.push(delta)
            }
          }
        }
        return results
      }
      const delta = parsePayload(protocol, remaining)
      return delta ? [delta] : []
    },
  }
}

function fallbackText(raw: string, protocol: Protocol): string {
  const trimmed = raw.trim()
  if (!trimmed) return ''
  try {
    const data = JSON.parse(trimmed) as Record<string, unknown>
    if (protocol === 'openai-chat') {
      const choices = data.choices as { message?: { content?: unknown } }[] | undefined
      const content = choices?.[0]?.message?.content
      return typeof content === 'string' ? content : ''
    }
    if (protocol === 'anthropic-messages') {
      const content = data.content as { type?: string; text?: unknown }[] | undefined
      return (content ?? []).filter(part => part.type === 'text').map(part => typeof part.text === 'string' ? part.text : '').join('')
    }
    if (protocol === 'gemini-generate-content') {
      const candidates = data.candidates as { content?: { parts?: { text?: unknown }[] } }[] | undefined
      return (candidates?.[0]?.content?.parts ?? []).map(part => typeof part.text === 'string' ? part.text : '').join('')
    }
    const message = data.message as { content?: unknown } | undefined
    return typeof message?.content === 'string' ? message.content : ''
  } catch {
    return ''
  }
}
