import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { once } from 'node:events'
import { request as httpRequest } from 'node:http'
import { MemoryStore, conversationContext, defaultPreferences } from '../server/memory.ts'
import { AlexRuntime, validatePreferences } from '../server/runtime.ts'
import { HttpProvider, ModelRouter, ProviderError } from '../server/providers.ts'
import type { ModelMessage, ModelProvider } from '../server/providers.ts'
import { inQuietHours, notificationDue } from '../server/notifications.ts'
import { applySophiaUpdate, prepareRequest, UnavailableSophia } from '../server/sophia.ts'
import { createApi } from '../server/http.ts'

class FixtureProvider implements ModelProvider {
  info = { id: 'fixture', model: 'deterministic-test-only', configured: true, capabilities: { text: true, tools: false as const, streaming: false as const, images: false as const, discovery: true } }
  calls: ModelMessage[][] = []
  fail = false
  async discover() { return [this.info.model] }
  async complete(messages: ModelMessage[]) { this.calls.push(messages); if (this.fail) throw new ProviderError('Provider unreachable or request timed out'); return 'Deterministic test fixture response. Not a real model.' }
}
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const directory = await mkdtemp(join(tmpdir(), 'nthn-alex-test-'))
  t.after(async () => { await rm(directory, { recursive: true, force: true }) })
  const store = new MemoryStore(directory); await store.load()
  const project = join(directory, 'status.md'); await writeFile(project, 'Test project document: no real task activity.')
  const provider = new FixtureProvider()
  const runtime = new AlexRuntime(store, new ModelRouter([provider]), project)
  return { directory, store, provider, runtime }
}

test('persisted preferences, explicit categorized memory and conversation survive restart/provider change', async t => {
  const { directory, store, runtime, provider } = await fixture(t)
  await runtime.action({ action: 'preferences', value: { ...defaultPreferences, humor: 'serious', communication: 'Short responses' } })
  for (const category of ['project', 'relationships', 'insideJokes', 'temporary']) await runtime.action({ action: 'remember', category, text: `User fact: ${category}` })
  await runtime.action({ action: 'chat', text: 'Remember our actual conversation topic: compiler dragons' })
  const restored = new MemoryStore(directory); await restored.load()
  assert.equal(restored.state.messages.length, 2)
  assert.equal(restored.state.notes.insideJokes[0].source, 'user')
  assert.equal(restored.state.preferences.humor, 'serious')
  const other = new FixtureProvider(); other.info = { ...other.info, id: 'other-fixture' }
  const second = new AlexRuntime(restored, new ModelRouter([provider, other]), runtime.projectFile)
  await second.action({ action: 'provider', id: 'other-fixture' })
  assert.equal(second.status, 'offline')
  await second.action({ action: 'chat', text: 'Continue that conversation' })
  const prompt = other.calls[0]
  assert.match(prompt[0].content, /You are Alex, employee 01/)
  assert.match(prompt[0].content, /immediately stop jokes/)
  assert.match(prompt[0].content, /never a human/)
  assert.match(prompt[0].content, /USER REPORTS/)
  assert.match(prompt[0].content, /insideJokes/)
  assert.match(prompt[0].content, /seven TOTAL employees/)
  assert.match(prompt[0].content, /No camera vision/)
  assert.ok(prompt.some(x => x.content.includes('compiler dragons')))
  assert.equal(second.snapshot().model, other.info.model)
  assert.equal(second.status, 'online')
  assert.equal(store.state.notes.project.length, 1)
})

test('no provider never generates a canned assistant reply or fake online state', async t => {
  const { store, runtime } = await fixture(t)
  const offline = new AlexRuntime(store, new ModelRouter([]), runtime.projectFile)
  await assert.rejects(offline.action({ action: 'chat', text: 'Hello' }), /No model provider/)
  assert.equal(offline.status, 'offline'); assert.equal(store.state.messages.length, 0)
  await assert.rejects(offline.action({ action: 'provider', id: 'arbitrary-url' }), /Unknown or unconfigured/)
})

test('failure is observable; failed inference creates no fabricated reply and preserves the user turn', async t => {
  const { runtime, store, provider } = await fixture(t)
  provider.fail = true
  await assert.rejects(runtime.action({ action: 'chat', text: 'A real user message' }), /unreachable/)
  assert.equal(runtime.status, 'error')
  assert.deepEqual(store.state.messages.map(x => x.role), ['user'])
  assert.match(store.state.audit.at(-1)!.outcome, /unreachable/)
  provider.fail = false
  await runtime.action({ action: 'chat', text: 'Try again' })
  assert.equal(runtime.status, 'online')
})

test('only one generation at once; model text has no execution path', async t => {
  const { runtime, provider, store } = await fixture(t)
  let release!: (value: string) => void
  provider.complete = async () => new Promise<string>(resolve => { release = resolve })
  const pending = runtime.action({ action: 'chat', text: 'deploy everything' })
  while (!release) await new Promise(resolve => setTimeout(resolve, 1))
  await assert.rejects(runtime.action({ action: 'chat', text: 'second' }), /progress|thinking/)
  assert.equal(runtime.status, 'thinking')
  release('I cannot execute deployments.'); await pending
  await assert.rejects(runtime.action({ action: 'execute', command: 'rm -rf /' }), /execution tools are unavailable/)
  assert.equal(store.state.requests.length, 0)
})

test('Sophia queue requires explicit approval, preserves exact requirements, and is not operational', async t => {
  const { runtime, store } = await fixture(t)
  await assert.rejects(runtime.action({ action: 'handoff', text: 'Do X, only after review', type: 'request', approved: false }), /approval/)
  await runtime.action({ action: 'handoff', text: 'Do X, only after review', type: 'request', approved: true })
  assert.equal(store.state.requests[0].text, 'Do X, only after review')
  assert.equal(store.state.requests[0].state, 'awaiting_adapter')
  assert.deepEqual(store.state.requests[0].updates, [])
  assert.throws(() => prepareRequest('anything', 'clarification', false), /approval/)
  const adapter = new UnavailableSophia()
  assert.equal(adapter.available, false); assert.deepEqual(await adapter.updates(), [])
  await assert.rejects(adapter.submit(store.state.requests[0]), /not connected/)
})

test('quiet hours handle midnight, boundaries, daytime ranges and disabled quiet hours', () => {
  assert.equal(inQuietHours('22:00', defaultPreferences), true)
  assert.equal(inQuietHours('07:59', defaultPreferences), true)
  assert.equal(inQuietHours('08:00', defaultPreferences), false)
  assert.equal(inQuietHours('15:00', { ...defaultPreferences, quietStart: '12:00', quietEnd: '16:00' }), true)
  assert.equal(inQuietHours('12:00', { ...defaultPreferences, quietStart: '12:00', quietEnd: '12:00' }), false)
  assert.throws(() => validatePreferences({ ...defaultPreferences, timezone: 'Invalid/Nowhere' }), /timezone/)
  assert.throws(() => validatePreferences({ ...defaultPreferences, intervalMinutes: 0 }), /interval/)
  assert.throws(() => validatePreferences({ ...defaultPreferences, quietStart: '25:00' }), /HH:MM/)
})

test('proactive events are opt-in, throttled, quiet, deduplicated and retained after failures', async t => {
  const { store, runtime, provider } = await fixture(t)
  store.event('project_change', 'Actual local test document change; not task completion')
  const morning = new Date('2026-10-30T02:00:00Z') // 10:00 Manila
  assert.equal(notificationDue(store.state, morning), null)
  store.state.preferences.proactive = true
  assert.equal(notificationDue(store.state, morning), 'update')
  assert.equal(notificationDue(store.state, new Date('2026-10-30T15:00:00Z')), null)
  await runtime.generate('update')
  assert.equal(store.state.deliveredEvents.length, 1)
  assert.equal(notificationDue(store.state, new Date(Date.now() + 86400000)), null)
  store.state.preferences.dailyBriefing = true
  store.state.lastNotification = 0; store.state.lastBriefingDay = ''
  assert.equal(notificationDue(store.state, morning), 'briefing')
  store.state.lastBriefingDay = '2026-10-30'; assert.equal(notificationDue(store.state, morning), null)
  store.event('project_change', 'Another actual event')
  provider.fail = true
  const before = store.state.deliveredEvents.length
  await assert.rejects(runtime.generate('update'))
  assert.equal(store.state.deliveredEvents.length, before)
  assert.ok(provider.calls.at(-1)!.some(x => x.content.includes('Another actual event')))
})

test('memory edits validate categories/lengths and failed writes roll back changes', async t => {
  const { runtime, store } = await fixture(t)
  await assert.rejects(runtime.action({ action: 'remember', category: '__proto__', text: 'invalid' }), /category/)
  await assert.rejects(runtime.action({ action: 'remember', category: 'project', text: 'x'.repeat(1001) }), /1000/)
  const save = store.save.bind(store)
  store.save = async () => { throw new Error('storage failure') }
  await assert.rejects(runtime.action({ action: 'remember', category: 'project', text: 'must not be saved' }), /storage failure/)
  assert.equal(store.state.notes.project.length, 0)
  store.save = save
  await runtime.action({ action: 'remember', category: 'project', text: 'real note' })
  await runtime.action({ action: 'forget', category: 'project', id: store.state.notes.project[0].id })
  assert.equal(store.state.notes.project.length, 0)
})

test('older relevant context is retrieved while full history stays persisted', async t => {
  const { store, runtime } = await fixture(t)
  await runtime.action({ action: 'chat', text: 'Our preference is compiler dragons' })
  const original = store.state.messages[0]
  const long = [original, ...Array.from({ length: 80 }, (_, i) => ({ ...original, id: String(i), content: 'unrelated' }))]
  assert.ok(conversationContext(long, 'compiler dragons').some(x => x.content === original.content))
  assert.equal(long.length, 81)
})

test('corrupt memory is not silently overwritten', async t => {
  const { directory } = await fixture(t)
  await writeFile(join(directory, 'alex.json'), '{invalid')
  await assert.rejects(new MemoryStore(directory).load())
  assert.equal(await readFile(join(directory, 'alex.json'), 'utf8'), '{invalid')
})

test('provider transports use real request schemas; secrets never enter system prompts or returned errors', async () => {
  const calls: { url: string; body: Record<string, unknown>; authorization: string | null }[] = []
  const transport: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)), authorization: new Headers(init?.headers).get('Authorization') })
    return new Response(JSON.stringify(String(url).endsWith('/api/chat') ? { message: { content: 'Ollama test fixture' }, done: true } : { choices: [{ message: { content: 'Compatible test fixture' }, finish_reason: 'stop' }] }), { status: 200 })
  }
  const secret = 'test-only-secret-never-a-real-key'
  const compatible = new HttpProvider('compatible', 'test-model', 'https://provider.example/v1', secret, 'openai-compatible', transport)
  const ollama = new HttpProvider('ollama', 'local-test-model', 'http://127.0.0.1:11434', '', 'ollama', transport)
  await compatible.complete([{ role: 'system', content: 'Identity' }, { role: 'user', content: 'Hello' }])
  await ollama.complete([{ role: 'system', content: 'Identity' }])
  assert.equal(calls[0].url, 'https://provider.example/v1/chat/completions')
  assert.equal(calls[0].authorization, `Bearer ${secret}`)
  assert.equal(calls[0].body.stream, false)
  assert.equal(calls[1].url, 'http://127.0.0.1:11434/api/chat')
  assert.equal(calls[1].authorization, null)
  assert.ok(!JSON.stringify(calls[0].body).includes(secret))
  const badFetch: typeof fetch = async () => new Response(secret, { status: 401 })
  const bad = new HttpProvider('bad', 'test', 'https://provider.example', secret, 'openai-compatible', badFetch)
  await assert.rejects(bad.complete([]), e => e instanceof Error && !e.message.includes(secret) && /credentials/.test(e.message))
  assert.throws(() => new HttpProvider('bad', 'test', 'http://external.example', '', 'ollama'), /HTTPS or loopback/)
})

test('malformed, tool-only, oversized and truncated provider output is rejected', async () => {
  for (const output of ['not-json', JSON.stringify({ choices: [{ message: { tool_calls: [{}] } }] }), JSON.stringify({ choices: [{ message: { content: 'partial' }, finish_reason: 'length' }] }), 'x'.repeat(1_000_001)]) {
    const provider = new HttpProvider('test', 'test', 'https://provider.example', 'test-secret', 'openai-compatible', async () => new Response(output))
    await assert.rejects(provider.complete([]), ProviderError)
  }
})

async function rawFetch(url: string, init: RequestInit = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method: init.method ?? 'GET', headers: Object.fromEntries(new Headers(init.headers).entries()) }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => {
        const headers = new Headers()
        for (const [name, value] of Object.entries(response.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value)
        resolve(new Response(Buffer.concat(chunks), { status: response.statusCode!, headers }))
      })
    })
    request.on('error', reject)
    request.end(init.body ? String(init.body) : undefined)
  })
}

test('HTTP API protects host/origin, sessions/CSRF, content type and body limits', async t => {
  const { runtime } = await fixture(t)
  // Explicit ephemeral test origin, never enabled by production server.
  const api = createApi(runtime, ['http://127.0.0.1:0'])
  await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve))
  t.after(async () => { api.closeAllConnections(); api.close(); await once(api, 'close') })
  const address = api.address(); assert.ok(address && typeof address === 'object')
  const base = `http://127.0.0.1:${address.port}`
  const common = { Host: 'localhost:3000', Origin: 'http://localhost:3000' }
  assert.equal((await rawFetch(base + '/api/alex', { headers: { Host: 'attacker.example' } })).status, 403)
  const response = await rawFetch(base + '/api/alex', { headers: common })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('Cache-Control'), 'no-store')
  const cookie = response.headers.get('set-cookie')!.split(';')[0]
  const snapshot = await response.json()
  const headers = { ...common, Cookie: cookie, 'X-Alex-CSRF': snapshot.csrf, 'Content-Type': 'application/json' }
  assert.equal((await rawFetch(base + '/api/alex', { method: 'POST', headers: { ...headers, Origin: 'https://attacker.example' }, body: '{}' })).status, 403)
  assert.equal((await rawFetch(base + '/api/alex', { method: 'POST', headers: { ...headers, 'X-Alex-CSRF': 'invalid' }, body: '{}' })).status, 403)
  assert.equal((await rawFetch(base + '/api/alex', { method: 'POST', headers: { ...headers, 'Content-Type': 'text/plain' }, body: '{}' })).status, 415)
  assert.equal((await rawFetch(base + '/api/alex', { method: 'POST', headers, body: JSON.stringify({ action: 'remember', category: 'project', text: 'API test note' }) })).status, 200)
  await new Promise(resolve => setTimeout(resolve, 260))
  assert.equal((await rawFetch(base + '/api/alex', { method: 'POST', headers, body: 'x'.repeat(16001) })).status, 413)
  assert.equal((await rawFetch(base + '/api/tools', { headers: common })).status, 404)
})


test('future Sophia updates enforce correlation and cannot complete an undelivered request', () => {
  const request = prepareRequest('User exact requirement', 'request', true)
  assert.throws(() => applySophiaUpdate([request], { requestId: 'unknown', source: 'sophia', state: 'completed', text: 'Unverified' }), /correlation/)
  assert.throws(() => applySophiaUpdate([request], { requestId: request.id, source: 'sophia', state: 'completed', text: 'Unverified' }), /undelivered/)
  // Only an explicitly integrated, trusted server dispatcher may mark submitted.
  request.state = 'submitted'
  applySophiaUpdate([request], { requestId: request.id, source: 'sophia', state: 'in_progress', text: 'Trusted adapter update fixture' })
  assert.throws(() => applySophiaUpdate([request], { requestId: request.id, source: 'sophia', state: 'submitted', text: 'Backwards' }), /backwards/)
  applySophiaUpdate([request], { requestId: request.id, source: 'sophia', state: 'completed', text: 'Trusted adapter result fixture' })
  assert.equal(request.updates.length, 2)
  assert.throws(() => applySophiaUpdate([request], { requestId: request.id, source: 'sophia', state: 'in_progress', text: 'Late fixture' }), /terminal/)
})


test('structurally damaged valid JSON memory is rejected without overwriting it', async t => {
  const { directory, store } = await fixture(t)
  const damaged = { ...store.state, notes: { project: [] } }
  await writeFile(join(directory, 'alex.json'), JSON.stringify(damaged))
  await assert.rejects(new MemoryStore(directory).load(), /Invalid memory schema/)
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'alex.json'), 'utf8')), damaged)
})

test('dashboard Vite proxy preserves the browser host required by the local API boundary', async t => {
  const { runtime } = await fixture(t)
  const api = createApi(runtime)
  await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve))
  const address = api.address(); assert.ok(address && typeof address === 'object')
  const { createServer } = await import('vite')
  const vite = await createServer({
    configFile: new URL('../vite.config.ts', import.meta.url).pathname,
    logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0, strictPort: false, proxy: { '/api': { target: `http://127.0.0.1:${address.port}` } } },
  })
  t.after(async () => { await vite.close(); api.closeAllConnections(); await new Promise<void>(resolve => api.close(() => resolve())) })
  await vite.listen()
  const uiAddress = vite.httpServer!.address(); assert.ok(uiAddress && typeof uiAddress === 'object')
  const localRoot = new URL('../.local/', import.meta.url).pathname
  await mkdir(localRoot, { recursive: true, mode: 0o700 })
  const privateDirectory = await mkdtemp(join(localRoot, 'security-test-'))
  t.after(async () => { await rm(privateDirectory, { recursive: true, force: true }) })
  await writeFile(join(privateDirectory, 'fixture.json'), '{"private":true}')
  const privatePath = '/.local/' + privateDirectory.split('/').at(-1) + '/fixture.json'
  const denied = await rawFetch(`http://127.0.0.1:${uiAddress.port}${privatePath}`, { headers: { Host: 'localhost:3000' } })
  assert.equal(denied.status, 403, 'Private memory must not be served by Vite static middleware')
  const response = await rawFetch(`http://127.0.0.1:${uiAddress.port}/api/alex`, { headers: { Host: 'localhost:3000' } })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).identity.name, 'Alex')
})
