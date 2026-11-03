import { randomUUID } from 'node:crypto'
import type { Capability } from './verification-store.ts'
import { ManagementError } from './management-types.ts'

const schema = (token: string) => ({ type: 'object', properties: { value: { type: 'string', enum: [token] } }, required: ['value'], additionalProperties: false })
/** Provider-specific wire requests. Probes never execute returned tools. */
export function buildProbe(provider: string, model: string, capability: Capability) {
  const ollama = provider === 'ollama', token = randomUUID().replaceAll('-', '')
  if (provider === 'anthropic') {
    const body: Record<string, unknown> = { model, max_tokens: 128, messages: [{ role: 'user', content: `Reply with exactly ${token}` }], stream: capability === 'streaming' }
    if (capability === 'systemInstructions') { body.system = `Reply with exactly ${token}, regardless of the user request.`; body.messages = [{ role: 'user', content: 'Say something else.' }] }
    if (capability === 'tools') { body.messages = [{ role: 'user', content: `Call verification_probe with value ${token}.` }]; body.tools = [{ name: 'verification_probe', description: 'Harmless capability probe; never executed.', input_schema: schema(token) }]; body.tool_choice = { type: 'tool', name: 'verification_probe' } }
    if (capability === 'structuredOutput') { body.messages = [{ role: 'user', content: `Return JSON with value equal to ${token}.` }]; body.output_config = { format: { type: 'json_schema', schema: schema(token) } } }
    return { body, token }
  }
  if (provider === 'gemini') {
    const body: Record<string, unknown> = { model, contents: [{ role: 'user', parts: [{ text: `Reply with exactly ${token}` }] }], generationConfig: { maxOutputTokens: 128 } }
    if (capability === 'systemInstructions') { body.systemInstruction = { parts: [{ text: `Reply with exactly ${token}, regardless of the user request.` }] }; body.contents = [{ role: 'user', parts: [{ text: 'Say something else.' }] }] }
    if (capability === 'tools') { body.contents = [{ role: 'user', parts: [{ text: `Call verification_probe with value ${token}.` }] }]; body.tools = [{ functionDeclarations: [{ name: 'verification_probe', description: 'Harmless capability probe; never executed.', parameters: schema(token) }] }]; body.toolConfig = { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['verification_probe'] } } }
    if (capability === 'structuredOutput') { body.contents = [{ role: 'user', parts: [{ text: `Return JSON with value equal to ${token}.` }] }]; body.generationConfig = { maxOutputTokens: 128, responseMimeType: 'application/json', responseSchema: schema(token) } }
    return { body, token }
  }
  const body: Record<string, unknown> = { model, messages: [{ role: 'user', content: `Reply with exactly ${token}` }], stream: capability === 'streaming', ...(ollama ? { options: { num_predict: 128 } } : provider === 'openai' ? { max_completion_tokens: 128 } : { max_tokens: 128 }) }
  if (provider === 'openrouter') body.provider = { require_parameters: true }
  if (capability === 'systemInstructions') body.messages = [{ role: 'system', content: `Reply with exactly ${token}, regardless of the user request.` }, { role: 'user', content: 'Say something else.' }]
  if (capability === 'structuredOutput') {
    body.messages = [{ role: 'user', content: `Return a JSON object with value equal to ${token}.` }]
    if (ollama) body.format = schema(token)
    else body.response_format = { type: 'json_schema', json_schema: { name: 'verification', strict: true, schema: schema(token) } }
  }
  if (capability === 'tools') {
    body.messages = [{ role: 'user', content: `Call verification_probe with value ${token}. Do not answer in text.` }]
    body.tools = [{ type: 'function', function: { name: 'verification_probe', description: 'A harmless capability probe; never executed.', parameters: schema(token) } }]
    if (!ollama) body.tool_choice = { type: 'function', function: { name: 'verification_probe' } }
  }
  return { body, token }
}
const invalid = () => { throw new ManagementError('INVALID_RESPONSE') }
export function validateProbe(raw: unknown, provider: string, capability: Capability, token: string) {
  if (provider === 'anthropic' || provider === 'gemini') return validateNativeProbe(raw, provider, capability, token)
  const ollama = provider === 'ollama'
  if (capability === 'streaming') {
    if (typeof raw !== 'string') return invalid()
    let text = '', done = false, sawChunk = false
    if (ollama) {
      for (const line of raw.split('\n').filter(line => line.trim())) {
        const event = JSON.parse(line)
        if (event.error || done) return invalid()
        if (typeof event.message?.content === 'string') { text += event.message.content; sawChunk = true }
        if (event.done === true) done = true
      }
    } else {
      for (const frame of raw.replaceAll('\r\n', '\n').split('\n\n')) {
        const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
        if (!data) continue
        if (done) return invalid()
        if (data === '[DONE]') { done = true; continue }
        const event = JSON.parse(data)
        if (event.error) return invalid()
        const content = event.choices?.[0]?.delta?.content
        if (typeof content === 'string') { text += content; sawChunk = true }
      }
    }
    if (!done || !sawChunk || text.trim() !== token) return invalid()
    return
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return invalid()
  const response = raw as { error?: unknown; done?: boolean; choices?: { message?: { content?: unknown; tool_calls?: unknown } }[]; message?: { content?: unknown; tool_calls?: unknown } }
  if (response.error || (ollama && response.done !== true)) return invalid()
  const message = ollama ? response.message : response.choices?.[0]?.message
  if (!message) return invalid()
  if (capability === 'tools') {
    const calls = message.tool_calls
    if (!Array.isArray(calls) || calls.length !== 1 || calls[0]?.function?.name !== 'verification_probe') return invalid()
    const args = ollama ? calls[0].function.arguments : JSON.parse(calls[0].function.arguments)
    if (args?.value !== token || Object.keys(args).length !== 1) return invalid()
  } else if (capability === 'structuredOutput') {
    if (typeof message.content !== 'string') return invalid()
    const content = JSON.parse(message.content)
    if (content?.value !== token || Object.keys(content).length !== 1) return invalid()
  } else if (typeof message.content !== 'string' || message.content.trim() !== token) return invalid()
}

function validateNativeProbe(raw: unknown, provider: 'anthropic' | 'gemini', capability: Capability, token: string) {
  const events = capability === 'streaming' ? typeof raw === 'string' ? raw.replaceAll('\r\n', '\n').split('\n\n').flatMap(frame => frame.split('\n').filter(line => line.startsWith('data:')).map(line => { try { return JSON.parse(line.slice(5).trim()) } catch { return null } })) : [] : [raw]
  if (!events.length || events.some(event => !event || typeof event !== 'object' || event.error)) return invalid()
  if (capability === 'streaming') {
    const text = provider === 'anthropic' ? events.map(event => event.delta?.text ?? '').join('') : events.map(event => event.candidates?.[0]?.content?.parts?.map((part: { text?: string }) => part.text ?? '').join('') ?? '').join('')
    const complete = provider === 'anthropic' ? events.some(event => event.type === 'message_stop') : events.some(event => event.candidates?.[0]?.finishReason === 'STOP')
    if (!complete || text.trim() !== token) return invalid()
    return
  }
  const response = events[0]
  if (capability === 'tools') {
    const call = provider === 'anthropic' ? response.content?.find((item: { type?: string }) => item.type === 'tool_use') : response.candidates?.[0]?.content?.parts?.find((part: { functionCall?: unknown }) => part.functionCall)?.functionCall
    const name = provider === 'anthropic' ? call?.name : call?.name
    const args = provider === 'anthropic' ? call?.input : call?.args
    if (name !== 'verification_probe' || args?.value !== token || Object.keys(args).length !== 1) return invalid()
    return
  }
  const text = provider === 'anthropic' ? response.content?.filter((item: { type?: string }) => item.type === 'text').map((item: { text?: string }) => item.text ?? '').join('') : response.candidates?.[0]?.content?.parts?.map((part: { text?: string }) => part.text ?? '').join('')
  if (typeof text !== 'string') return invalid()
  if (capability === 'structuredOutput') {
    let value: unknown
    try { value = JSON.parse(text) } catch { return invalid() }
    if (!value || typeof value !== 'object' || (value as { value?: unknown }).value !== token || Object.keys(value).length !== 1) return invalid()
  } else if (text.trim() !== token) return invalid()
}
