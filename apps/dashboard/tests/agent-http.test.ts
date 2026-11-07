import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { once } from 'node:events'
import { MemoryStore } from '../server/memory.ts'
import { AlexRuntime } from '../server/runtime.ts'
import { ModelRouter, type ModelMessage, type ModelProvider } from '../server/providers.ts'
import { createApi } from '../server/http.ts'
import { AgentChatStore } from '../server/agent/store.ts'
import { AlexAgent } from '../server/agent/agent.ts'
import type { ChatTurn, Gateway, GatewayInfo } from '../server/agent/gateway.ts'

class EchoProvider implements ModelProvider {
  info = { id: 'fixture', model: 'fixture-model', configured: true, capabilities: { text: true, tools: false as const, streaming: false as const, images: false as const, discovery: true } }
  async discover() { return [this.info.model] }
  async complete(_messages: ModelMessage[]) { return 'fixture' }
}

class ScriptGateway implements Gateway {
  info(): GatewayInfo { return { provider: 'fake', model: 'fixture-model', transport: 'streaming' } }
  async *stream(_messages: ChatTurn[]): AsyncGenerator<string> {
    yield 'Hello '
    yield 'from Alex.'
  }
}

interface ResponseResult { status: number; headers: IncomingHttpHeaders; body: string }

function call(port: number, method: string, path: string, options: { cookie?: string; csrf?: string; body?: unknown } = {}): Promise<ResponseResult> {
  return new Promise((resolve, reject) => {
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body)
    const request = httpRequest({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        host: '127.0.0.1:3000',
        origin: 'http://127.0.0.1:3000',
        ...(options.cookie ? { cookie: options.cookie } : {}),
        ...(options.csrf ? { 'x-alex-csrf': options.csrf } : {}),
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
      },
    }, response => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    request.on('error', reject)
    request.end(payload)
  })
}

test('agent HTTP API issues a CSRF session, streams SSE deltas and persists the conversation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nthn-agent-http-'))
  const memory = new MemoryStore(join(directory, 'alex'))
  await memory.load()
  const runtime = new AlexRuntime(memory, new ModelRouter([new EchoProvider()]), join(directory, 'PROJECT_STATUS.md'))
  await runtime.initialize()
  const chatStore = new AgentChatStore(join(directory, 'agent'))
  await chatStore.load()
  const agent = new AlexAgent({ store: chatStore, gateway: new ScriptGateway(), workspace: directory })
  const server = createApi(runtime, [], undefined, agent)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No test port')
  const port = address.port
  t.after(async () => {
    server.close()
    await once(server, 'close')
    await rm(directory, { recursive: true, force: true })
  })

  const missing = await call(port, 'POST', '/api/agent/chat', { body: { conversationId: 'x', text: 'hi' } })
  assert.equal(missing.status, 403)

  const initial = await call(port, 'GET', '/api/agent')
  assert.equal(initial.status, 200)
  const state = JSON.parse(initial.body) as { csrf: string }
  const cookie = String(initial.headers['set-cookie']).split(';')[0]
  assert.match(state.csrf, /^[a-f0-9]{64}$/)

  const created = await call(port, 'POST', '/api/agent/new', { cookie, csrf: state.csrf, body: {} })
  assert.equal(created.status, 200)
  const conversation = (JSON.parse(created.body) as { conversation: { id: string } }).conversation
  assert.ok(conversation.id)

  const stream = await call(port, 'POST', '/api/agent/chat', { cookie, csrf: state.csrf, body: { conversationId: conversation.id, text: 'Say hello' } })
  assert.equal(stream.status, 200)
  assert.match(String(stream.headers['content-type']), /text\/event-stream/)
  const events = stream.body.split('\n\n').filter(Boolean).map(block => block.split('\n').find(line => line.startsWith('data:'))).filter(Boolean).map(line => JSON.parse((line as string).slice(5).trim()) as { type: string; text?: string })
  assert.ok(events.some(event => event.type === 'start'))
  assert.ok(events.some(event => event.type === 'delta' && event.text === 'Hello '))
  assert.ok(events.some(event => event.type === 'delta' && event.text === 'from Alex.'))
  assert.ok(events.some(event => event.type === 'done'))
  assert.ok(!stream.body.includes('NTHN_TOOL'))

  const settings = agent.state()
  const active = settings.active
  assert.equal(active?.messages.filter(message => message.role === 'assistant').length, 1)
  assert.equal(active?.messages.find(message => message.role === 'assistant')?.content, 'Hello from Alex.')

  const decision = await call(port, 'POST', '/api/agent/decide', { cookie, csrf: state.csrf, body: { kind: 'workflow', question: 'Add a regression test' } })
  assert.equal(decision.status, 200)
  const envelope = JSON.parse(decision.body) as { engine: { isJev: boolean }; advisoryOnly: boolean }
  assert.equal(envelope.engine.isJev, false)
  assert.equal(envelope.advisoryOnly, true)
})
