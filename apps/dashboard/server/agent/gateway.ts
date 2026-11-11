import { randomUUID } from 'node:crypto'
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
  toolCallId?: string
  toolCalls?: { id: string; name: string; arguments: Record<string, unknown> }[]
}

export interface NativeToolCall { kind: 'tool_call'; id: string; name: string; arguments: Record<string, unknown> }
export interface ToolSchema { name: string; description: string; arguments: Record<string, string> }

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
  stream(messages: ChatTurn[], options?: { signal?: AbortSignal; maxTokens?: number; tools?: ToolSchema[] }): AsyncGenerator<string | NativeToolCall>
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

function groupToolResults(items: Record<string, unknown>[], field: 'content' | 'parts'): Record<string, unknown>[] {
  const grouped: Record<string, unknown>[] = []
  for (const item of items) {
    const previous = grouped.at(-1)
    if (item.role === 'user' && previous?.role === 'user' && Array.isArray(item[field]) && Array.isArray(previous[field])) {
      previous[field] = [...previous[field], ...item[field] as unknown[]]
    } else grouped.push(item)
  }
  return grouped
}

export function requestBody(route: ModelRoute, messages: ChatTurn[], stream: boolean, maxTokens = 4000, tools: ToolSchema[] = []): Record<string, unknown> {
  const protocol = connectionAdapter(route.providerId).protocol
  const model = route.ref.nativeModelId
  const { system, turns } = turnsForProvider(messages)
  const parameters = (tool: ToolSchema) => ({ type: 'object', properties: Object.fromEntries(Object.entries(tool.arguments).map(([key, type]) => [key, type === 'string[]' ? { type: 'array', items: { type: 'string' } } : { type }])), additionalProperties: false })
  if (protocol === 'ollama-chat') {
    const native = tools.length > 0
    const names = new Map(messages.flatMap(turn => turn.toolCalls?.map(call => [call.id, call.name] as const) ?? []))
    return { model, messages: messages.map(message => {
      if (native && message.role === 'tool') return { role: 'tool', tool_name: names.get(message.toolCallId ?? '') ?? message.name ?? 'tool', content: message.content }
      if (native && message.role === 'assistant' && message.toolCalls?.length) return { role: 'assistant', content: message.content, tool_calls: message.toolCalls.map(call => ({ function: { name: call.name, arguments: call.arguments } })) }
      return { role: message.role === 'tool' ? 'user' : message.role, content: message.content }
    }), stream, options: { num_predict: maxTokens }, ...(native ? { tools: tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: parameters(tool) } })) } : {}) }
  }
  if (protocol === 'anthropic-messages') {
    const native = tools.length > 0
    const mapped = native ? groupToolResults(messages.filter(turn => turn.role !== 'system').map(turn => {
      if (turn.role === 'tool' && turn.toolCallId) return { role: 'user', content: [{ type: 'tool_result', tool_use_id: turn.toolCallId, content: turn.content }] }
      if (turn.role === 'assistant' && turn.toolCalls?.length) return { role: 'assistant', content: [
        ...(turn.content ? [{ type: 'text', text: turn.content }] : []),
        ...turn.toolCalls.map(call => ({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments })),
      ] }
      return { role: turn.role === 'tool' ? 'user' : turn.role, content: turn.content }
    }) as Record<string, unknown>[], 'content') : turns
    return { model, messages: mapped, ...(system ? { system } : {}), max_tokens: maxTokens, ...(stream ? { stream: true } : {}), ...(native ? { tools: tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: parameters(tool) })) } : {}) }
  }
  if (protocol === 'gemini-generate-content') {
    const native = tools.length > 0
    const names = new Map(messages.flatMap(turn => turn.toolCalls?.map(call => [call.id, call.name] as const) ?? []))
    const contents = native ? groupToolResults(messages.filter(turn => turn.role !== 'system').map(turn => {
      if (turn.role === 'tool' && turn.toolCallId) return { role: 'user', parts: [{ functionResponse: { ...(turn.toolCallId.startsWith('gemini-local-') ? {} : { id: turn.toolCallId }), name: names.get(turn.toolCallId) ?? turn.name ?? 'tool', response: { result: turn.content } } }] }
      if (turn.role === 'assistant' && turn.toolCalls?.length) return { role: 'model', parts: [
        ...(turn.content ? [{ text: turn.content }] : []),
        ...turn.toolCalls.map(call => ({ functionCall: { ...(call.id.startsWith('gemini-local-') ? {} : { id: call.id }), name: call.name, args: call.arguments } })),
      ] }
      return { role: turn.role === 'assistant' ? 'model' : 'user', parts: [{ text: turn.content }] }
    }) as Record<string, unknown>[], 'parts') : turns.map(turn => ({ role: turn.role === 'assistant' ? 'model' : 'user', parts: [{ text: turn.content }] }))
    return {
      model,
      contents,
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      generationConfig: { maxOutputTokens: maxTokens },
      ...(native ? { tools: [{ functionDeclarations: tools.map(tool => ({ name: tool.name, description: tool.description, parameters: parameters(tool) })) }], toolConfig: { functionCallingConfig: { mode: 'AUTO' } } } : {}),
    }
  }
  const native = protocol === 'openai-chat' && tools.length > 0
  const definitions = tools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: 'object',
        properties: Object.fromEntries(Object.entries(tool.arguments).map(([key, type]) => [key, type === 'string[]' ? { type: 'array', items: { type: 'string' } } : { type }])),
        additionalProperties: false,
      },
    },
  }))
  return {
    model,
    messages: native ? [
      ...(system ? [{ role: 'system', content: system }] : []),
      ...messages.filter(turn => turn.role !== 'system').map(turn => turn.role === 'tool' && turn.toolCallId
        ? { role: 'tool', tool_call_id: turn.toolCallId, content: turn.content }
        : turn.role === 'assistant' && turn.toolCalls?.length
          ? { role: 'assistant', content: turn.content || null, tool_calls: turn.toolCalls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) }
          : { role: turn.role === 'tool' ? 'user' : turn.role, content: turn.content }),
    ] : [
      ...(system ? [{ role: 'system', content: system }] : []),
      ...turns.map(turn => ({ role: turn.role, content: turn.content })),
    ],
    stream,
    ...(route.providerId === 'openai' ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens }),
    ...(native ? { tools: definitions, tool_choice: 'auto' } : {}),
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
    if (!resolved.primary) throw new GatewayError('NO_MODEL', 'No verified compatible model is assigned to Jef. Configure and verify one in AI Providers.')
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

/** Stream through an exact route resolved by an app-specific persisted selection. */
export class ResolvedRouteGateway implements Gateway {
  private readonly manager: Pick<ConnectionManager, 'streamInference'>
  private readonly resolver: (excluded?: Set<string>) => Promise<ModelRoute>
  private last: GatewayInfo | null

  constructor(manager: Pick<ConnectionManager, 'streamInference'>, resolver: (excluded?: Set<string>) => Promise<ModelRoute>, initial: GatewayInfo | null = null) {
    this.manager = manager
    this.resolver = resolver
    this.last = initial
  }

  info(): GatewayInfo | null { return this.last }

  async *stream(messages: ChatTurn[], options: { signal?: AbortSignal; maxTokens?: number; tools?: ToolSchema[] } = {}): AsyncGenerator<string | NativeToolCall> {
    const excluded = new Set<string>()
    let previousFailure: GatewayError | null = null
    for (;;) {
      let route: ModelRoute
      try { route = await this.resolver(excluded) } catch (error) { throw previousFailure ?? friendly(error) }
      if (excluded.has(route.id)) throw previousFailure ?? new GatewayError('MODEL_UNAVAILABLE', 'No other verified model is available.')
      this.last = { provider: route.providerId, model: route.ref.nativeModelId, transport: 'streaming' }
      const protocol = connectionAdapter(route.providerId).protocol
      const parser = createParser(protocol)
      const body = requestBody(route, messages, true, options.maxTokens, options.tools)
      const calls = new Map<number, { id: string; name: string; arguments: string }>()
      let toolBuffer = ''
      let emitted = false
      let raw = ''
      const bufferSeedText = route.providerId === 'openrouter' && /^bytedance-seed\/seed-2\.0-code(?:$|[-:])/i.test(route.ref.nativeModelId)
      let seedText = ''
      const collectToolLine = (line: string): void => {
        const payload = protocol === 'ollama-chat' ? line : line.startsWith('data:') ? line.slice(5) : ''
        if (!payload) return
        try {
          const data = JSON.parse(payload) as { type?: string; index?: number; content_block?: { type?: string; id?: string; name?: string; input?: Record<string, unknown> }; delta?: { type?: string; partial_json?: string }; message?: { tool_calls?: { function?: { name?: string; arguments?: Record<string, unknown> } }[] }; candidates?: { content?: { parts?: { functionCall?: { id?: string; name?: string; args?: Record<string, unknown> } }[] } }[]; choices?: { delta?: { tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] } }[] }
          for (const part of data.choices?.[0]?.delta?.tool_calls ?? []) {
            const call = calls.get(part.index) ?? { id: '', name: '', arguments: '' }
            call.id += part.id ?? ''; call.name += part.function?.name ?? ''; call.arguments += part.function?.arguments ?? ''
            calls.set(part.index, call)
          }
          if (protocol === 'anthropic-messages' && typeof data.index === 'number') {
            if (data.type === 'content_block_start' && data.content_block?.type === 'tool_use') {
              const block = data.content_block
              calls.set(data.index, { id: block.id ?? '', name: block.name ?? '', arguments: block.input && Object.keys(block.input).length ? JSON.stringify(block.input) : '' })
            } else if (data.type === 'content_block_delta' && data.delta?.type === 'input_json_delta') {
              const call = calls.get(data.index)
              if (call) call.arguments += data.delta.partial_json ?? ''
            }
          }
          if (protocol === 'gemini-generate-content') for (const part of data.candidates?.[0]?.content?.parts ?? []) {
            const call = part.functionCall
            if (call?.name && (call.args === undefined || (typeof call.args === 'object' && !Array.isArray(call.args)))) calls.set(calls.size, { id: call.id ?? `gemini-local-${randomUUID()}`, name: call.name, arguments: JSON.stringify(call.args ?? {}) })
          }
          if (protocol === 'ollama-chat') for (const part of data.message?.tool_calls ?? []) {
            const call = part.function
            if (call?.name && (call.arguments === undefined || (typeof call.arguments === 'object' && !Array.isArray(call.arguments)))) calls.set(calls.size, { id: `ollama-local-${randomUUID()}`, name: call.name, arguments: JSON.stringify(call.arguments ?? {}) })
          }
        } catch { /* Incomplete or non-JSON frames remain ordinary streamed text. */ }
      }
      try {
        for await (const chunk of this.manager.streamInference(route.ref.connectionId, route.connectionRevision, body, options.signal)) {
          raw += chunk
          toolBuffer += chunk
          let end: number
          while ((end = toolBuffer.indexOf('\n')) >= 0) {
            const line = toolBuffer.slice(0, end).trimEnd()
            toolBuffer = toolBuffer.slice(end + 1)
            collectToolLine(line)
          }
          for (const delta of parser.push(chunk)) if (delta) {
            emitted = true
            if (bufferSeedText) seedText += delta
            else yield delta
          }
        }
        if (toolBuffer.trim()) collectToolLine(toolBuffer.trimEnd())
        for (const delta of parser.flush()) if (delta) {
          emitted = true
          if (bufferSeedText) seedText += delta
          else yield delta
        }
      } catch (error) {
        const failure = friendly(error)
        if (!emitted && !options.signal?.aborted && ['REQUEST_FAILED', 'DNS_FAILED', 'RATE_LIMITED', 'PROBE_FAILED', 'MODEL_UNAVAILABLE', 'INSUFFICIENT_CREDITS', 'INCOMPATIBLE'].includes(failure.code)) {
          excluded.add(route.id)
          previousFailure = failure
          continue
        }
        throw failure
      }
      if (!emitted) {
        const text = fallbackText(raw, protocol)
        if (text) {
          if (bufferSeedText) seedText += text
          else yield text
        }
      }
      if (bufferSeedText && seedText) {
        const marker = /<\/think_never_used_[^>]*>/g
        let last: RegExpExecArray | null = null
        for (let match = marker.exec(seedText); match; match = marker.exec(seedText)) last = match
        const visible = last ? seedText.slice(last.index + last[0].length) : seedText
        if (visible) yield visible
      }
      for (const call of [...calls.entries()].sort(([a], [b]) => a - b).map(([, value]) => value)) {
        let args: unknown
        try { args = JSON.parse(call.arguments || '{}') } catch { throw new GatewayError('INVALID_TOOL_CALL', 'Model returned invalid tool arguments.') }
        if (!call.id || !call.name || !args || typeof args !== 'object' || Array.isArray(args)) throw new GatewayError('INVALID_TOOL_CALL', 'Model returned an invalid tool call.')
        yield { kind: 'tool_call', id: call.id, name: call.name, arguments: args as Record<string, unknown> }
      }
      return
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

/** Prefer the verified saved Jef assignment; fall back to environment providers. */
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
