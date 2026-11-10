import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request as httpRequest } from 'node:http'
import { ConnectionManager } from '../server/ai/connection-manager.ts'
import { AiManagementApi } from '../server/ai/management-api.ts'
import { createApi } from '../server/http.ts'
import { AlexRuntime } from '../server/runtime.ts'
import { ModelRouter } from '../server/providers.ts'
import { MemoryStore } from '../server/memory.ts'
import { AiClient, AiRequestError } from '../src/ai-client.ts'
import { verificationLabel } from '../src/ai-display.ts'
import type { AiAction, AiSnapshot, AssignmentView, ModelSearch, ManagedConnection } from '../src/ai-contract.ts'
import type { Verification } from '../server/ai/verification-store.ts'

const secret = 'private-test-key-never-real'
const modelIds = ['Vendor/EXACT:日本語', 'Second:tag']
const input = { providerId: 'openai-compatible', label: 'Test account', baseUrl: 'https://provider.example/v1' }

function rawFetch(url: string, init: RequestInit = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: init.method ?? 'GET', headers: Object.fromEntries(new Headers(init.headers).entries()) }, res => {
      const chunks: Buffer[] = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => {
        const headers = new Headers()
        for (const [key, value] of Object.entries(res.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value)
        resolve(new Response(Buffer.concat(chunks), { status: res.statusCode!, headers }))
      })
    })
    req.on('error', reject); req.end(init.body ? String(init.body) : undefined)
  })
}
function probeAnswer(body: Record<string, unknown>) {
  const token = JSON.stringify(body).match(/[a-f0-9]{32}/)![0]
  if (body.stream) return 'data: ' + JSON.stringify({ choices: [{ delta: { content: token } }] }) + '\n\ndata: [DONE]\n\n'
  const content = body.response_format ? JSON.stringify({ value: token }) : token
  return { choices: [{ message: body.tools ? { tool_calls: [{ function: { name: 'verification_probe', arguments: JSON.stringify({ value: token }) } }] } : { content } }] }
}
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const directory = await mkdtemp(join(tmpdir(), 'nthn-ai-api-'))
  let failure = 0, probes = 0
  const manager = new ConnectionManager(join(directory, 'ai'), {
    resolver: async () => [{ address: '8.8.8.8', family: 4 }],
    transport: async (_endpoint, _path, key, options) => {
      assert.equal(key, secret)
      if (failure) return { status: failure, body: { error: { message: secret } } }
      if (options?.body) { probes++; return { status: 200, body: probeAnswer(options.body) } }
      return { status: 200, body: { data: modelIds.map(id => ({ id })) } }
    },
  })
  const ai = new AiManagementApi(manager)
  const store = new MemoryStore(join(directory, 'alex')); await store.load()
  const runtime = new AlexRuntime(store, new ModelRouter([]), join(directory, 'status.md'))
  const memoryBefore = JSON.stringify(store.state)
  const server = createApi(runtime, [], () => ai)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); assert.ok(address && typeof address === 'object')
  const base = `http://127.0.0.1:${address.port}`
  let cookie = ''
  const transport: typeof fetch = async (url, init) => {
    const headers = new Headers(init?.headers)
    headers.set('Host', 'localhost:3000'); headers.set('Origin', 'http://localhost:3000')
    if (cookie) headers.set('Cookie', cookie)
    const response = await rawFetch(base + url, { ...init, headers })
    if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie')!.split(';')[0]
    return response
  }
  const client = new AiClient(transport)
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); ai.close(); await rm(directory, { recursive: true, force: true }); assert.equal(JSON.stringify(store.state), memoryBefore, 'Provider operations must not change Alex memory') })
  return { directory, manager, ai, store, runtime, base, client, transport, get cookie() { return cookie }, fail: (status: number) => { failure = status }, probes: () => probes }
}

test('management HTTP shares local session protections, rejects invalid input and never writes Alex memory', async t => {
  const f = await fixture(t)
  const get = await f.transport('/api/ai')
  assert.equal(get.status, 200); assert.equal(get.headers.get('cache-control'), 'no-store')
  assert.match(get.headers.get('set-cookie')!, /HttpOnly; SameSite=Strict; Path=\/api/)
  const data = await get.json() as AiSnapshot
  assert.deepEqual(data.providers.map(p => p.id), ['openrouter', 'openai', 'anthropic', 'gemini', 'xkiro', 'groq', 'openai-compatible', 'ollama'])
  assert.deepEqual(data.localPorts, [11434, 1234, 8000, 8080])
  const headers = { Host: 'localhost:3000', Origin: 'http://localhost:3000', Cookie: f.cookie, 'X-Alex-CSRF': data.csrf, 'Content-Type': 'application/json' }
  const post = (body: string, patch = {}) => rawFetch(f.base + '/api/ai', { method: 'POST', headers: { ...headers, ...patch }, body })
  assert.equal((await rawFetch(f.base + '/api/ai', { headers: { Host: 'attacker.example' } })).status, 403)
  assert.equal((await post('{}', { Origin: 'https://attacker.example' })).status, 403)
  assert.equal((await post('{}', { 'Sec-Fetch-Site': 'cross-site' })).status, 403)
  assert.equal((await post('{}', { Origin: '' })).status, 403)
  assert.equal((await post('{}', { 'X-Alex-CSRF': 'invalid' })).status, 403)
  assert.equal((await post('{}', { 'Content-Type': 'text/plain' })).status, 415)
  assert.equal((await post('x'.repeat(16001))).status, 413)
  assert.equal((await post('{')).status, 400)
  assert.equal((await post(JSON.stringify({ action: 'connection.add', connection: input, apiKey: secret, unexpected: secret }))).status, 400)
  assert.equal((await post(JSON.stringify({ action: '__proto__' }))).status, 400)
  assert.equal((await post(JSON.stringify({ action: 'connection.enable', id: 'x', revision: 1, enabled: 'true' }))).status, 400)
  assert.equal((await post(JSON.stringify({ action: 'connection.add', connection: { ...input, baseUrl: 'http://169.254.169.254/' }, apiKey: secret }))).status, 400)
  assert.equal(f.manager.list().length, 0)
  const alex = await f.transport('/api/alex')
  assert.equal(alex.status, 200); assert.equal((await alex.json()).identity.name, 'Alex')
  assert.equal((await f.transport('/api/ai/made-up')).status, 404)
})

test('dashboard client manages existing connections, write-only credentials and optimistic revisions', async t => {
  const f = await fixture(t)
  let c = await f.client.request<ManagedConnection>({ action: 'connection.add', connection: input, apiKey: secret })
  assert.equal(c.enabled, false); assert.equal(c.credentials.state, 'configured')
  assert.ok(!JSON.stringify(c).includes(secret))
  assert.ok(!(await readFile(join(f.directory, 'ai/providers.sqlite'))).includes(Buffer.from(secret)))
  c = await f.client.request({ action: 'connection.edit', id: c.id, revision: c.revision, patch: { label: 'Updated', scope: { account: 'account-a', project: 'project', region: null } } })
  assert.equal(c.label, 'Updated'); assert.equal(c.scope.account, 'account-a')
  await assert.rejects(f.client.request({ action: 'connection.edit', id: c.id, revision: 1, patch: { label: 'stale' } }), (e: unknown) => e instanceof AiRequestError && e.code === 'CONFLICT')
  c = await f.client.request({ action: 'connection.credential', id: c.id, revision: c.revision, apiKey: null })
  assert.equal(c.credentials.state, 'missing')
  c = await f.client.request({ action: 'connection.credential', id: c.id, revision: c.revision, apiKey: secret })
  assert.equal(c.credentials.state, 'configured')
  const successful = await f.client.request<{ ok: boolean; code: string }>({ action: 'connection.test', id: c.id, revision: c.revision })
  assert.equal(successful.ok, true); assert.equal(f.probes(), 0)
  f.fail(401)
  const failed = await f.client.request<{ ok: boolean; code: string }>({ action: 'connection.test', id: c.id, revision: c.revision })
  assert.equal(failed.ok, false); assert.equal(failed.code, 'AUTH_REJECTED')
  const snapshot = await f.client.snapshot()
  assert.equal(snapshot.testResults[c.id].code, 'AUTH_REJECTED')
  assert.match(snapshot.testResults[c.id].message, /rejected/)
  assert.ok(!JSON.stringify(snapshot).includes(secret)); assert.ok(!JSON.stringify(f.manager.audit()).includes(secret))
  c = await f.client.request({ action: 'connection.enable', id: c.id, revision: c.revision, enabled: true })
  assert.equal(c.enabled, true)
  c = await f.client.request({ action: 'connection.edit', id: c.id, revision: c.revision, patch: { baseUrl: 'https://other.example/v1' } })
  assert.equal(c.credentials.state, 'missing', 'Endpoint edits reuse existing credential clearing policy')
  await f.client.request({ action: 'connection.remove', id: c.id, revision: c.revision })
  assert.deepEqual((await f.client.snapshot()).connections, [])
})

test('catalog search, pagination, explicit verification and compatible ordered fallbacks use Phase 2 services', async t => {
  const f = await fixture(t)
  let c = await f.client.request<ManagedConnection>({ action: 'connection.add', connection: { ...input, enabled: true }, apiKey: secret })
  await f.client.request({ action: 'catalog.refresh', id: c.id })
  const search: AiAction = { action: 'catalog.search', query: { providerIds: ['openai-compatible'], connectionIds: [c.id], pageSize: 1 }, agentId: '01', requiredCapabilities: ['text', 'systemInstructions'] }
  const first = await f.client.request<ModelSearch>(search)
  assert.equal(first.page.total, 2); assert.ok(first.page.nextCursor)
  const second = await f.client.request<ModelSearch>({ ...search, query: { ...search.query, cursor: first.page.nextCursor! } })
  assert.equal(second.page.entries.length, 1); assert.notEqual(first.page.entries[0].route.id, second.page.entries[0].route.id)
  const filtered = await f.client.request<ModelSearch>({ ...search, query: { search: modelIds[0] } })
  assert.equal(filtered.page.total, 1); assert.equal(filtered.page.entries[0].route.ref.nativeModelId, modelIds[0])
  assert.equal(f.probes(), 0, 'Discovery and search never infer')
  const routes = [...first.page.entries, ...second.page.entries].map(e => e.route.id)
  assert.ok(!first.eligibility[routes[0]].compatible)
  const assignment = { agentId: '01', candidateRouteIds: [routes[1], routes[0]], requiredCapabilities: ['text'] as ['text'] }
  await assert.rejects(f.client.request({ action: 'assignment.set', assignment, revision: 0 }), (e: unknown) => e instanceof AiRequestError && e.code === 'NO_COMPATIBLE_MODEL')
  await f.client.request({ action: 'model.verify', routeId: routes[0], capabilities: ['text'] })
  await assert.rejects(f.client.request({ action: 'assignment.set', assignment: { ...assignment, candidateRouteIds: [routes[0]] }, revision: 0 }), /compatible/)
  for (const routeId of routes) {
    const v = await f.client.request<Verification>({ action: 'model.verify', routeId, capabilities: ['text', 'systemInstructions', 'tools', 'streaming', 'structuredOutput'] })
    assert.equal(v.state, 'verified'); assert.ok(Object.values(v.capabilities).every(c => c.state === 'supported'))
    assert.ok(!JSON.stringify(v).includes(secret))
  }
  const current = await f.client.request<ModelSearch>(search)
  assert.equal(verificationLabel(current.page.entries[0]), 'Verified')
  assert.equal(verificationLabel(current.page.entries[0], Date.now() + 86400001), 'Verification expired')
  assert.ok(current.eligibility[current.page.entries[0].route.id].compatible)
  await assert.rejects(f.client.request({ ...search, query: { ...search.query, cursor: first.page.nextCursor! } }), (e: unknown) => e instanceof AiRequestError && e.code === 'CATALOG_CHANGED')
  await f.client.request({ action: 'assignment.set', assignment, revision: 0 })
  const view = await f.client.request<AssignmentView>({ action: 'assignment.get', agentId: '01' })
  assert.deepEqual(view.assignment!.candidateRouteIds, [routes[1], routes[0]])
  assert.ok(view.assignment!.requiredCapabilities.includes('systemInstructions'))
  assert.ok(view.candidates.every(c => c.compatible))
  await assert.rejects(f.client.request({ action: 'assignment.set', assignment, revision: 0 }), (e: unknown) => e instanceof AiRequestError && e.code === 'CONFLICT')
  c = await f.client.request({ action: 'connection.enable', id: c.id, revision: c.revision, enabled: false })
  const disabled = await f.client.request<ModelSearch>(search)
  assert.ok(!disabled.eligibility[disabled.page.entries[0].route.id].compatible)
  assert.equal(verificationLabel(disabled.page.entries[0]), 'Unavailable / historical evidence')
  await f.client.request({ action: 'connection.remove', id: c.id, revision: c.revision })
  const removed = await f.client.request<AssignmentView>({ action: 'assignment.get', agentId: '01' })
  assert.ok(removed.candidates.every(c => !c.compatible))
  assert.equal(f.runtime.status, 'offline', 'Saved assignments do not activate Alex or Nexus')
})

test('verification and discovery errors are sanitized, persistent and invalidate eligibility', async t => {
  const f = await fixture(t)
  const c = await f.client.request<ManagedConnection>({ action: 'connection.add', connection: { ...input, enabled: true }, apiKey: secret })
  await f.client.request({ action: 'catalog.refresh', id: c.id })
  const search: AiAction = { action: 'catalog.search', query: {}, agentId: '02', requiredCapabilities: ['text'] }
  const routeId = (await f.client.request<ModelSearch>(search)).page.entries[0].route.id
  f.fail(429)
  const failed = await f.client.request<Verification>({ action: 'model.verify', routeId, capabilities: ['text'] })
  assert.equal(failed.state, 'unavailable'); assert.equal(failed.code, 'RATE_LIMITED')
  const result = await f.client.request<ModelSearch>(search)
  assert.equal(result.page.entries.find(e => e.route.id === routeId)!.verification!.code, 'RATE_LIMITED')
  assert.ok(!result.eligibility[routeId].compatible)
  f.fail(401)
  const refresh = await f.client.request<{ errorCode: string }>({ action: 'catalog.refresh', id: c.id })
  assert.equal(refresh.errorCode, 'AUTH_REJECTED')
  const snapshot = await f.client.snapshot()
  assert.equal(snapshot.refreshes[0].errorCode, 'AUTH_REJECTED')
  assert.ok(!JSON.stringify([failed, result, snapshot]).includes(secret))
})

test('provider initialization failure returns a safe error while Alex remains available', async t => {
  const f = await fixture(t)
  const api = createApi(f.runtime, [], () => { throw new Error(secret) })
  await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>(resolve => { api.closeAllConnections(); api.close(() => resolve()) }))
  const address = api.address(); assert.ok(address && typeof address === 'object')
  const url = `http://127.0.0.1:${address.port}`
  const response = await rawFetch(url + '/api/ai', { headers: { Host: 'localhost:3000' } })
  assert.equal(response.status, 500); assert.ok(!(await response.text()).includes(secret))
  assert.equal((await rawFetch(url + '/api/alex', { headers: { Host: 'localhost:3000' } })).status, 200)
})

test('discovered unverified routes are distinguished from per-model failures and disabled connections', async t => {
  const f = await fixture(t)
  let c = await f.client.request<ManagedConnection>({ action: 'connection.add', connection: { ...input, enabled: true }, apiKey: secret })
  await f.client.request({ action: 'catalog.refresh', id: c.id })
  const search: AiAction = { action: 'catalog.search', query: {}, agentId: '01', requiredCapabilities: ['text', 'systemInstructions'] }
  let result = await f.client.request<ModelSearch>(search)
  assert.ok(Object.values(result.eligibility).every(e => !e.compatible && e.code === 'UNVERIFIED'))
  const [first, second] = result.page.entries.map(e => e.route.id)
  f.fail(429)
  await f.client.request({ action: 'model.verify', routeId: first, capabilities: ['text'] })
  result = await f.client.request<ModelSearch>(search)
  assert.equal(result.eligibility[first].code, 'RATE_LIMITED')
  assert.equal(result.eligibility[second].code, 'UNVERIFIED')
  f.fail(0)
  c = await f.client.request({ action: 'connection.edit', id: c.id, revision: c.revision, patch: { label: 'Changed' } })
  assert.equal((await f.client.request<ModelSearch>(search)).eligibility[first].code, 'CATALOG_STALE')
  await f.client.request({ action: 'catalog.refresh', id: c.id })
  assert.equal((await f.client.request<ModelSearch>(search)).eligibility[first].code, 'UNVERIFIED')
  await f.client.request({ action: 'connection.enable', id: c.id, revision: c.revision, enabled: false })
  assert.equal((await f.client.request<ModelSearch>(search)).eligibility[first].code, 'CONNECTION_DISABLED')
})

test('browser client refreshes a rejected session once, uses no-store and never places keys in URLs', async () => {
  const calls: { url: string; init?: RequestInit }[] = []
  let posts = 0, gets = 0
  const client = new AiClient(async (url, init) => {
    calls.push({ url: String(url), init })
    if (init?.method === 'POST') { posts++; return new Response(JSON.stringify(posts === 1 ? { error: 'CSRF expired' } : { saved: true }), { status: posts === 1 ? 403 : 200 }) }
    gets++; return new Response(JSON.stringify({ csrf: 'csrf-' + gets, connections: [], providers: [] }))
  })
  await client.request({ action: 'connection.add', connection: input, apiKey: secret })
  assert.equal(posts, 2); assert.equal(gets, 2)
  assert.ok(calls.every(c => c.url === '/api/ai' && c.init?.cache === 'no-store' && c.init.credentials === 'same-origin'))
  assert.equal(new Headers(calls.at(-1)!.init!.headers).get('X-Alex-CSRF'), 'csrf-2')
  const invalid = new AiClient(async () => new Response('<html>Dashboard shell</html>'))
  await assert.rejects(invalid.snapshot(), /Provider API unavailable/)
})

test('browser fetch receiver is preserved for default and injected transports through the protected API', async t => {
  const f = await fixture(t)
  const originalFetch = globalThis.fetch
  let calls = 0
  const browserFetch: typeof fetch = function (this: unknown, input, init) {
    if (this !== globalThis) throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation")
    calls++
    return f.transport(input, init)
  }
  // Reproduce the previous private-field method call's receiver without relying
  // on Node fetch, which does not enforce the browser's Window brand check.
  const oldClient = { fetch: browserFetch }
  assert.throws(() => oldClient.fetch('/api/ai'), /Illegal invocation/)
  assert.equal(calls, 0, 'The failure occurs before any HTTP request')
  globalThis.fetch = browserFetch
  try {
    const client = new AiClient()
    const snapshot = await client.snapshot()
    assert.ok(Array.isArray(snapshot.connections)); assert.equal(snapshot.providers.length, 8)
    const c = await client.request<ManagedConnection>({ action: 'connection.add', connection: input, apiKey: secret })
    assert.equal(c.credentials.state, 'configured')
    assert.equal((await client.snapshot()).connections.length, 1)
    const injected = new AiClient(browserFetch)
    const assignment = await injected.request<AssignmentView>({ action: 'assignment.get', agentId: '01' })
    assert.equal(assignment.assignment, null)
    assert.ok(calls >= 5, 'GET, CSRF-protected POST and injected bootstrap all reached the API')
  } finally { globalThis.fetch = originalFetch }
})

test('Vite forwards provider reads and protected writes to the existing local API', async t => {
  const f = await fixture(t)
  const { createServer } = await import('vite')
  const vite = await createServer({
    configFile: new URL('../vite.config.ts', import.meta.url).pathname, logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0, strictPort: false, proxy: { '/api': { target: f.base } } },
  })
  t.after(() => vite.close())
  await vite.listen()
  const address = vite.httpServer!.address(); assert.ok(address && typeof address === 'object')
  const url = `http://127.0.0.1:${address.port}`
  const response = await rawFetch(url + '/api/ai', { headers: { Host: 'localhost:3000' } })
  assert.equal(response.status, 200)
  const data = await response.json() as AiSnapshot
  const headers = { Host: 'localhost:3000', Origin: 'http://localhost:3000', Cookie: response.headers.get('set-cookie')!.split(';')[0], 'X-Alex-CSRF': data.csrf, 'Content-Type': 'application/json' }
  const saved = await rawFetch(url + '/api/ai', { method: 'POST', headers, body: JSON.stringify({ action: 'connection.add', connection: input, apiKey: secret }) })
  assert.equal(saved.status, 200); assert.ok(!(await saved.text()).includes(secret))
  assert.equal(f.manager.list().length, 1)
  assert.equal(f.probes(), 0)
})
