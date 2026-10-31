import { randomUUID } from 'node:crypto'
import type { Capability } from './verification-store.ts'
import { ManagementError } from './management-types.ts'

const schema = (token: string) => ({ type: 'object', properties: { value: { type: 'string', enum: [token] } }, required: ['value'], additionalProperties: false })
/** Provider-specific wire requests. Probes never execute returned tools. */
export function buildProbe(provider: string, model: string, capability: Capability) {
  const ollama = provider === 'ollama', token = randomUUID().replaceAll('-', '')
  const body: Record<string, unknown> = { model, messages: [{ role: 'user', content: `Reply with exactly ${token}` }], stream: capability === 'streaming', ...(ollama ? { options: { num_predict: 128 } } : { max_tokens: 128 }) }
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
