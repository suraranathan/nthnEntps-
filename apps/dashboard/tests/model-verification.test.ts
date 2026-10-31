import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { ConnectionManager } from '../server/ai/connection-manager.ts'
import { CatalogService } from '../server/ai/catalog-service.ts'
import { VerificationService } from '../server/ai/verification-service.ts'
import { AgentAssignments } from '../server/ai/agent-assignments.ts'
import { buildProbe, validateProbe } from '../server/ai/verification-probes.ts'
import { capabilityNames } from '../server/ai/verification-store.ts'
import type { ProbeTransport } from '../server/ai/endpoint-policy.ts'
import { ManagementError } from '../server/ai/management-types.ts'
import { AlexAssignedProvider, nearAllowance, nextSlowStreak, SLOW_REQUEST_MS } from '../server/ai/alex-assigned-provider.ts'
import { MemoryStore } from '../server/memory.ts'

const secret = 'fixture-secret-not-real'
const model = 'Vendor/EXACT:tag /日本語'
const generic = { providerId: 'openai-compatible', label: 'account', baseUrl: 'https://provider.example/v1', enabled: true, scope: { account: 'account-one', project: null, region: null } }
const code = (value: string) => (e: unknown) => e instanceof ManagementError && e.code === value
function answer(body: Record<string, unknown>, ollama = false): unknown {
  const token = JSON.stringify(body).match(/[a-f0-9]{32}/)![0]
  if (body.stream) return ollama ? JSON.stringify({ message: { content: token }, done: false }) + '\n' + JSON.stringify({ done: true }) + '\n' : 'data: ' + JSON.stringify({ choices: [{ delta: { content: token } }] }) + '\n\ndata: [DONE]\n\n'
  const content = body.format || body.response_format ? JSON.stringify({ value: token }) : token
  const message = body.tools ? { tool_calls: [{ function: { name: 'verification_probe', arguments: ollama ? { value: token } : JSON.stringify({ value: token }) } }] } : { content }
  return ollama ? { message, done: true } : { choices: [{ message }] }
}
async function fixture(t: { after: (fn: () => Promise<void>) => void }, handler?: ProbeTransport, config = generic, key: string | null = secret) {
  const directory = await mkdtemp(join(tmpdir(), 'nthn-model-test-'))
  const calls: { path: string; body?: Record<string, unknown> }[] = []
  const manager = new ConnectionManager(directory, { resolver: async () => [{ address: '8.8.8.8', family: 4 }], transport: async (endpoint, path, credential, options) => {
    calls.push({ path, body: options?.body })
    if (!options?.body) return { status: 200, body: config.providerId === 'ollama' ? { models: [{ name: model }] } : { data: [{ id: model }] } }
    assert.equal(credential, key)
    return handler ? handler(endpoint, path, credential, options) : { status: 200, body: answer(options.body, config.providerId === 'ollama') }
  } })
  const catalog = new CatalogService(manager), verification = new VerificationService(manager, catalog), assignments = new AgentAssignments(manager, catalog)
  t.after(async () => { assignments.close(); verification.close(); catalog.close(); manager.close(); await rm(directory, { recursive: true, force: true }) })
  const connection = manager.add(config, key)
  await catalog.refresh(connection.id)
  const route = (await catalog.search()).entries[0].route
  return { directory, manager, catalog, verification, assignments, connection, route, calls }
}

test('Alex switch signals require repeated slowness or observed remaining allowance', () => {
  assert.equal(nextSlowStreak(0, SLOW_REQUEST_MS - 1), 0)
  assert.equal(nextSlowStreak(nextSlowStreak(1, SLOW_REQUEST_MS), SLOW_REQUEST_MS), 3)
  assert.equal(nextSlowStreak(3, 100), 0)
  assert.equal(nearAllowance(100, 11), false)
  assert.equal(nearAllowance(100, 10), true)
  assert.equal(nearAllowance(0, 0), false)
})

test('Alex assigned transport uses exact verified route and switches only after a limit signal to saved fallback', async t => {
  let limitOnce = false
  let clock = 0, simulateSlowness = false
  const config = { providerId: 'openrouter', label: 'primary', baseUrl: 'https://openrouter.ai/api/v1', enabled: true, scope: { account: 'fixture', project: null, region: null } }
  const f = await fixture(t, async (_endpoint, _path, _key, options) => {
    if (JSON.stringify(options?.body?.messages).match(/[a-f0-9]{32}/)) return { status: 200, body: answer(options!.body!) }
    if (limitOnce) { limitOnce = false; return { status: 429, body: {} } }
    if (simulateSlowness) clock += SLOW_REQUEST_MS + 1
    return { status: 200, body: { choices: [{ message: { content: 'Fixture Alex reply.' } }] } }
  }, config)
  const verified = await f.verification.verify(f.route.id, ['text', 'systemInstructions'])
  assert.equal(verified.state, 'verified')
  const other = f.manager.add({ ...config, label: 'fallback' }, secret)
  await f.catalog.refresh(other.id)
  const fallback = (await f.catalog.search({ connectionIds: [other.id] })).entries[0].route
  assert.equal((await f.verification.verify(fallback.id, ['text', 'systemInstructions'])).state, 'verified')
  await f.assignments.set({ agentId: '01', candidateRouteIds: [f.route.id, fallback.id] }, 0)
  const store = new MemoryStore(join(f.directory, 'alex')); await store.load()
  const provider = new AlexAssignedProvider(f.manager, f.catalog, f.assignments, f.verification, store)
  await provider.prepare()
  assert.equal(await provider.complete([{ role: 'system', content: 'Identity' }]), 'Fixture Alex reply.')
  assert.equal(store.state.events.filter(e => e.type === 'alex_model_switched').length, 0)
  limitOnce = true
  await assert.rejects(provider.complete([{ role: 'system', content: 'Identity' }]), /rate limit/i)
  await provider.prepare()
  assert.equal(await provider.complete([{ role: 'system', content: 'Identity' }]), 'Fixture Alex reply.')
  assert.match(store.state.events.at(-1)!.text, /rate limit/)
  assert.equal(store.state.events.at(-1)!.type, 'alex_model_switched')
  assert.equal(f.calls.filter(c => c.body && !JSON.stringify(c.body.messages).match(/[a-f0-9]{32}/)).length, 3)
  const slow = new AlexAssignedProvider(f.manager, f.catalog, f.assignments, f.verification, store, () => clock)
  await slow.prepare(); simulateSlowness = true
  for (let i = 0; i < 3; i++) await slow.complete([{ role: 'system', content: 'Identity' }])
  assert.equal(store.state.events.filter(e => e.type === 'alex_model_switched').length, 1)
  await slow.prepare()
  assert.equal(store.state.events.filter(e => e.type === 'alex_model_switched').length, 2)
  assert.match(store.state.events.at(-1)!.text, /three consecutive responses/)
})

test('required-capability verification can qualify Alex after an unrelated tools route failure without claiming tools support', async t => {
  const f = await fixture(t, async (_endpoint, _path, _key, options) => options?.body?.tools ? { status: 404, body: {} } : { status: 200, body: answer(options!.body!) })
  const full = await f.verification.verify(f.route.id)
  assert.equal(full.code, 'MODEL_UNAVAILABLE')
  assert.equal(full.capabilities.text.state, 'supported')
  assert.equal((await f.assignments.assess(f.route.id, ['text', 'systemInstructions'])).compatible, false)
  const required = await f.verification.verify(f.route.id, ['text', 'systemInstructions'])
  assert.equal(required.state, 'verified')
  assert.equal(required.capabilities.tools.state, 'untested')
  assert.equal((await f.assignments.assess(f.route.id, ['text', 'systemInstructions'])).compatible, true)
  assert.equal((await f.assignments.assess(f.route.id, ['tools'])).compatible, false)
  assert.equal(f.verification.store.history(f.route.id)[1].code, 'MODEL_UNAVAILABLE')
})

test('discovery never verifies; five real-shaped probes persist route/account evidence and update catalog', async t => {
  const f = await fixture(t)
  assert.equal(f.verification.store.latest(f.route.id), null)
  assert.equal(f.route.access.state, 'listed')
  const v = await f.verification.verify(f.route.id)
  assert.equal(v.state, 'verified'); assert.equal(v.nativeModelId, model); assert.equal(v.account.account, 'account-one')
  assert.equal(v.connectionId, f.connection.id); assert.equal(v.providerId, 'openai-compatible'); assert.ok(Date.parse(v.checkedAt))
  assert.ok(Object.values(v.capabilities).every(c => c.state === 'supported' && c.checkedAt))
  assert.equal(f.calls.filter(c => c.body).length, 5)
  assert.ok(f.calls.filter(c => c.body).every(c => c.path === '/chat/completions' && c.body!.model === model))
  assert.equal((await f.catalog.getRoute(f.route.id))!.route.access.state, 'verified')
  assert.equal(f.manager.get(f.connection.id).health.inference, 'succeeded')
  await f.catalog.refresh(f.connection.id)
  assert.equal((await f.catalog.getRoute(f.route.id))!.verification!.id, v.id)
  const other = new VerificationService(f.manager, f.catalog)
  assert.equal(other.store.latest(f.route.id)!.id, v.id); other.close()
  assert.ok(!(await readFile(join(f.directory, 'catalog.sqlite'))).includes(Buffer.from(secret)))
  assert.ok(!JSON.stringify(v).includes(secret))
})

test('OpenRouter and Ollama use separate native request/stream/tool/schema formats', async t => {
  for (const providerId of ['openrouter', 'ollama']) {
    const f = await fixture(t, undefined, { ...generic, providerId, baseUrl: providerId === 'ollama' ? 'http://127.0.0.1:11434' : 'https://openrouter.ai/api/v1', ...(providerId === 'ollama' ? { networkPolicy: 'loopback' } : {}) })
    assert.equal((await f.verification.verify(f.route.id)).state, 'verified')
    const bodies = f.calls.filter(c => c.body)
    if (providerId === 'openrouter') assert.ok(bodies.every(c => (c.body!.provider as { require_parameters: boolean }).require_parameters))
    else { assert.ok(bodies.every(c => c.path === '/api/chat')); assert.ok(bodies.some(c => c.body!.format)); assert.ok(bodies.every(c => !c.body!.max_tokens)) }
  }
})

for (const [status, expected, state] of [[401, 'AUTH_REJECTED', 'unavailable'], [403, 'AUTH_REJECTED', 'unavailable'], [402, 'INSUFFICIENT_CREDITS', 'unavailable'], [429, 'RATE_LIMITED', 'unavailable'], [500, 'PROBE_FAILED', 'unavailable'], [404, 'MODEL_UNAVAILABLE', 'unavailable'], [400, 'INCOMPATIBLE', 'incompatible'], [422, 'INCOMPATIBLE', 'incompatible'], [501, 'CAPABILITY_UNSUPPORTED', 'incompatible'], [302, 'REDIRECT_BLOCKED', 'unavailable']] as const) {
  test(`HTTP ${status} is recorded honestly with no raw provider error`, async t => {
    const f = await fixture(t, async () => ({ status, body: { error: secret } }))
    const v = await f.verification.verify(f.route.id)
    assert.equal(v.code, expected); assert.equal(v.state, state)
    assert.notEqual((await f.catalog.getRoute(f.route.id))!.route.access.state, 'verified')
    assert.equal(v.capabilities.streaming.state, 'untested'); assert.equal(f.calls.filter(c => c.body).length, 1)
    assert.ok(!JSON.stringify(v).includes(secret))
  })
}

test('missing public credential records untested without any inference call', async t => {
  const f = await fixture(t, undefined, generic, null)
  const v = await f.verification.verify(f.route.id)
  assert.equal(v.state, 'untested'); assert.equal(v.code, 'CREDENTIAL_REQUIRED'); assert.equal(f.calls.filter(c => c.body).length, 0)
})

test('credentialless local services can verify', async t => {
  const f = await fixture(t, undefined, { ...generic, baseUrl: 'http://127.0.0.1:1234/v1', networkPolicy: 'loopback' } as typeof generic, null)
  assert.equal((await f.verification.verify(f.route.id, ['text'])).state, 'verified')
})

test('unrequested and ambiguous capabilities remain untested; explicit endpoint rejection is unsupported', async t => {
  const f = await fixture(t, async (_e, _p, _k, options) => {
    if (options!.body!.tools) return { status: 501, body: null }
    if (options!.body!.response_format) return { status: 400, body: null }
    return { status: 200, body: answer(options!.body!) }
  })
  const v = await f.verification.verify(f.route.id, ['tools', 'structuredOutput'])
  assert.equal(v.state, 'verified'); assert.equal(v.capabilities.tools.state, 'unsupported')
  assert.equal(v.capabilities.structuredOutput.state, 'untested'); assert.equal(v.capabilities.streaming.checkedAt, null)
  assert.equal((await f.assignments.assess(f.route.id, ['tools'])).compatible, false)
})

test('capability-time rate limit invalidates availability after successful text', async t => {
  const f = await fixture(t, async (_e, _p, _k, options) => options!.stream ? { status: 429, body: null } : { status: 200, body: answer(options!.body!) })
  const v = await f.verification.verify(f.route.id)
  assert.equal(v.state, 'unavailable'); assert.equal(v.capabilities.text.state, 'supported'); assert.equal(v.code, 'RATE_LIMITED')
})

for (const raw of [{ choices: [] }, { error: 'error' }, { choices: [{ message: { content: secret } }] }]) test('malformed responses and credential echoes never verify', async t => {
  const f = await fixture(t, async () => ({ status: 200, body: raw }))
  const v = await f.verification.verify(f.route.id)
  assert.equal(v.state, 'incompatible'); assert.equal(v.code, 'INVALID_RESPONSE'); assert.ok(!JSON.stringify(v).includes(secret))
})

test('timeouts and arbitrary transport errors are sanitized', async t => {
  const f = await fixture(t, async () => { throw new Error(secret) })
  const v = await f.verification.verify(f.route.id)
  assert.equal(v.code, 'REQUEST_FAILED'); assert.ok(!JSON.stringify(v).includes(secret))
})

test('stream parser rejects missing terminators, JSON masquerading as streaming, errors and invalid structured/tool responses', () => {
  for (const provider of ['ollama', 'openai-compatible']) {
    const { token } = buildProbe(provider, model, 'streaming')
    for (const raw of ['', JSON.stringify({ choices: [{ message: { content: token } }] }), 'data: {"error":"failed"}\n\n', '{"error":"failed"}\n']) assert.throws(() => validateProbe(raw, provider, 'streaming', token))
    for (const capability of ['structuredOutput', 'tools'] as const) assert.throws(() => validateProbe({ choices: [{ message: { content: '{"value":"wrong"}' } }], message: { content: '{}' }, done: true }, provider, capability, token))
  }
})

test('explicit assignments require evidence; Alex profile cannot drop system requirements; candidates remain separate', async t => {
  const f = await fixture(t)
  const input = { agentId: '01', candidateRouteIds: [f.route.id] }
  await assert.rejects(f.assignments.set(input, 0), code('NO_COMPATIBLE_MODEL'))
  await f.verification.verify(f.route.id, ['text'])
  await assert.rejects(f.assignments.set({ ...input, requiredCapabilities: [] }, 0), code('NO_COMPATIBLE_MODEL'))
  await f.verification.verify(f.route.id)
  const second = f.manager.add({ ...generic, scope: { account: 'account-two', project: null, region: null } }, secret)
  await f.catalog.refresh(second.id)
  const secondRoute = (await f.catalog.search({ connectionIds: [second.id] })).entries[0].route
  assert.equal(f.verification.store.latest(secondRoute.id), null)
  await f.verification.verify(secondRoute.id)
  const assignment = await f.assignments.set({ ...input, candidateRouteIds: [f.route.id, secondRoute.id] }, 0)
  assert.equal(assignment.revision, 1); assert.ok(assignment.requiredCapabilities.includes('systemInstructions'))
  await assert.rejects(f.assignments.set(input, 0), code('CONFLICT'))
  const resolved = await f.assignments.resolve('01')
  assert.equal(resolved.primary!.id, f.route.id); assert.equal(resolved.fallbacks[0].id, secondRoute.id)
  f.manager.setEnabled(f.connection.id, f.connection.revision, false)
  const fallback = await f.assignments.resolve('01')
  assert.equal(fallback.primary!.id, secondRoute.id); assert.equal(fallback.candidates[0].compatible, false)
  const other = await f.assignments.set({ agentId: 'future-agent', candidateRouteIds: [secondRoute.id], requiredCapabilities: ['tools'] }, 0)
  assert.equal(other.agentId, 'future-agent')
})

test('configuration changes and expired evidence invalidate assignment eligibility', async t => {
  const f = await fixture(t)
  await f.verification.verify(f.route.id)
  assert.equal((await f.assignments.assess(f.route.id, [])).compatible, true)
  const v = f.verification.store.latest(f.route.id)!
  f.verification.store.save({ ...v, checkedAt: '2000-01-01T00:00:00.000Z' })
  assert.equal((await f.assignments.assess(f.route.id, [])).code, 'VERIFICATION_EXPIRED')
  await f.verification.verify(f.route.id)
  f.manager.setCredential(f.connection.id, 1, 'new-fixture-key')
  assert.equal((await f.assignments.assess(f.route.id, [])).compatible, false)
  assert.equal((await f.verification.verify(f.route.id)).code, 'CONFLICT')
})

test('mid-request edits invalidate successful responses; concurrent probes are rejected', async t => {
  let finish!: () => void
  const gate = new Promise<void>(resolve => { finish = resolve })
  const f = await fixture(t, async (_e, _p, _k, options) => { await gate; return { status: 200, body: answer(options!.body!) } })
  const pending = f.verification.verify(f.route.id)
  await new Promise(resolve => setTimeout(resolve, 10))
  await assert.rejects(f.verification.verify(f.route.id), code('TEST_BUSY'))
  f.manager.setCredential(f.connection.id, 1, 'replacement-fixture-key'); finish()
  const v = await pending
  assert.equal(v.code, 'CONFLICT'); assert.equal(v.state, 'unavailable')
})

test('real loopback HTTP transport sends POST JSON and validates SSE/NDJSON with no mocks', async t => {
  let errorMode = ''
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk))
    assert.equal(req.method, 'POST'); assert.ok(['/v1/chat/completions', '/api/chat'].includes(req.url!))
    const body = JSON.parse(Buffer.concat(chunks).toString())
    if (errorMode) { res.statusCode = 429; res.end(errorMode === 'quota' ? JSON.stringify({ error: { code: 'insufficient_quota' } }) : '<html>unavailable</html>'); return }
    res.setHeader('Content-Type', body.stream ? 'text/event-stream' : 'application/json')
    const response = answer(body, req.url === '/api/chat'); res.end(typeof response === 'string' ? response : JSON.stringify(response))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const directory = await mkdtemp(join(tmpdir(), 'nthn-wire-test-'))
  const manager = new ConnectionManager(directory, { rules: { localPorts: [port] } })
  t.after(async () => { manager.close(); server.close(); await rm(directory, { recursive: true, force: true }) })
  const c = manager.add({ ...generic, baseUrl: `http://127.0.0.1:${port}/v1`, networkPolicy: 'loopback' })
  const o = manager.add({ providerId: 'ollama', label: 'local', baseUrl: `http://127.0.0.1:${port}`, networkPolicy: 'loopback', enabled: true })
  for (const connection of [c, o]) for (const capability of capabilityNames) {
    const { body, token } = buildProbe(connection.providerId, model, capability)
    validateProbe(await manager.inferenceProbe(connection.id, 1, body, capability === 'streaming'), connection.providerId, capability, token)
  }
  const { body } = buildProbe('openai-compatible', model, 'streaming')
  errorMode = 'quota'
  await assert.rejects(manager.inferenceProbe(c.id, 1, body, true), code('INSUFFICIENT_CREDITS'))
  errorMode = 'html'
  await assert.rejects(manager.inferenceProbe(c.id, 1, body), code('RATE_LIMITED'))
})

test('429 insufficient_quota is distinguished from a transient rate limit', async t => {
  const f = await fixture(t, async () => ({ status: 429, body: { error: { code: 'insufficient_quota', message: secret } } }))
  const v = await f.verification.verify(f.route.id)
  assert.equal(v.code, 'INSUFFICIENT_CREDITS'); assert.equal(v.state, 'unavailable')
})

test('disabled routes are not contacted; account removal during inference retains unavailable history', async t => {
  const f = await fixture(t)
  f.manager.setEnabled(f.connection.id, 1, false)
  const before = f.calls.length
  assert.equal((await f.verification.verify(f.route.id)).code, 'CONNECTION_DISABLED')
  assert.equal(f.calls.length, before)
  let entered!: () => void, finish!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { finish = resolve })
  const g = await fixture(t, async (_e, _p, _k, options) => { entered(); await gate; return { status: 200, body: answer(options!.body!) } })
  const pending = g.verification.verify(g.route.id)
  await started; g.manager.remove(g.connection.id, 1); finish()
  const v = await pending
  assert.equal(v.state, 'unavailable'); assert.equal(v.code, 'MODEL_UNAVAILABLE')
  assert.equal(g.verification.store.history(g.route.id).length, 1)
})

test('verification updates invalidate catalog paging snapshots and unknown capability input is rejected', async t => {
  const f = await fixture(t)
  const second = f.manager.add(generic, secret); await f.catalog.refresh(second.id)
  const page = await f.catalog.search({ pageSize: 1 }); assert.ok(page.nextCursor)
  await f.verification.verify(f.route.id)
  await assert.rejects(f.catalog.search({ pageSize: 1, cursor: page.nextCursor! }), code('CATALOG_CHANGED'))
  await assert.rejects(f.verification.verify(f.route.id, ['imaginary' as 'text']), code('INVALID_INPUT'))
  await assert.rejects(f.assignments.set({ agentId: '01', candidateRouteIds: [f.route.id, f.route.id] }, 0), code('INVALID_INPUT'))
  await assert.rejects(f.assignments.set({ agentId: '01', candidateRouteIds: [], personality: 'override' }, 0), code('INVALID_INPUT'))
})

test('a later failed probe revokes assignment eligibility while preserving historical success', async t => {
  let fail = false
  const f = await fixture(t, async (_e, _p, _k, options) => fail ? { status: 503, body: null } : { status: 200, body: answer(options!.body!) })
  await f.verification.verify(f.route.id)
  await f.assignments.set({ agentId: '01', candidateRouteIds: [f.route.id] }, 0)
  fail = true
  await f.verification.verify(f.route.id)
  assert.equal((await f.assignments.resolve('01')).primary, null)
  const history = f.verification.store.history(f.route.id)
  assert.equal(history[0].state, 'unavailable'); assert.equal(history[1].state, 'verified')
})
