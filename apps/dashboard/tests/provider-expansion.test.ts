import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { ConnectionManager } from '../server/ai/connection-manager.ts'
import { CatalogService } from '../server/ai/catalog-service.ts'
import { VerificationService } from '../server/ai/verification-service.ts'
import { AgentAssignments } from '../server/ai/agent-assignments.ts'
import { AiManagementApi } from '../server/ai/management-api.ts'
import { availableProviders } from '../server/ai/connection-adapters.ts'
import { buildProbe, validateProbe } from '../server/ai/verification-probes.ts'
import { AlexAssignedProvider } from '../server/ai/alex-assigned-provider.ts'
import { MemoryStore } from '../server/memory.ts'
import type { ProbeTransport } from '../server/ai/endpoint-policy.ts'
import { requestPinnedJson } from '../server/ai/endpoint-policy.ts'

const secret = 'fixture-key-never-real'
const resolver = async () => [{ address: '8.8.8.8', family: 4 }]
async function fixture(t: { after: (fn: () => Promise<void>) => void }, transport: ProbeTransport) {
  const directory = await mkdtemp(join(tmpdir(), 'nthn-expansion-'))
  const manager = new ConnectionManager(directory, { resolver, transport })
  const catalog = new CatalogService(manager)
  const verification = new VerificationService(manager, catalog)
  const assignments = new AgentAssignments(manager, catalog)
  t.after(async () => { assignments.close(); verification.close(); catalog.close(); manager.close(); await rm(directory, { recursive: true, force: true }) })
  return { directory, manager, catalog, verification, assignments }
}

test('built-in registry, separate accounts and provider-specific connection checks', async t => {
  assert.deepEqual(new Set(availableProviders().map(p => p.id)), new Set(['openai', 'anthropic', 'gemini', 'openrouter', 'xkiro', 'ollama', 'openai-compatible']))
  const seen: string[] = []
  const f = await fixture(t, async (_endpoint, path, key, options) => {
    assert.equal(key, secret); seen.push(options?.authStyle ?? '')
    return { status: 200, body: path === '/key' ? { data: { is_free_tier: false } } : options?.authStyle === 'gemini' ? { models: [] } : { data: [] } }
  })
  for (const [providerId, baseUrl, style] of [
    ['openai', 'https://api.openai.com/v1', 'bearer'], ['anthropic', 'https://api.anthropic.com/v1', 'anthropic'],
    ['gemini', 'https://generativelanguage.googleapis.com/v1beta', 'gemini'], ['xkiro', 'https://api.xkiro.com/v1', 'bearer'],
  ] as const) {
    const a = f.manager.add({ providerId, label: 'A', baseUrl }, secret)
    const b = f.manager.add({ providerId, label: 'B', baseUrl }, secret)
    assert.notEqual(a.id, b.id)
    assert.equal((await f.manager.test(a.id, a.revision)).ok, true)
    assert.equal(seen.at(-1), style)
  }
  const custom = f.manager.add({ providerId: 'openai-compatible', label: 'Header variant', baseUrl: 'https://custom.example/v1', authStyle: 'x-api-key' }, secret)
  assert.equal((await f.manager.test(custom.id, custom.revision)).ok, true)
  assert.equal(seen.at(-1), 'x-api-key')
  assert.ok(!JSON.stringify(f.manager.list()).includes(secret))
})

test('native model discovery and capability probes use distinct formats', async t => {
  const f = await fixture(t, async (_endpoint, path, _key, options) => {
    if (options?.authStyle === 'gemini') return { status: 200, body: path.includes('pageToken=next') ? { models: [{ name: 'models/gemini-b', supportedGenerationMethods: ['generateContent'] }] } : { models: [{ name: 'models/gemini-a', supportedGenerationMethods: ['generateContent'] }], nextPageToken: 'next' } }
    if (path.includes('modality=all')) return { status: 200, body: { data: [{ id: 'vendor/chat', modality: 'chat', capabilities: { tools: true } }] } }
    return { status: 200, body: path.includes('after=claude-a') ? { data: [{ id: 'claude-b' }], has_more: false } : { data: [{ id: 'claude-a' }], has_more: true, last_id: 'claude-a' } }
  })
  for (const [providerId, baseUrl, expected] of [
    ['gemini', 'https://generativelanguage.googleapis.com/v1beta', ['models/gemini-a', 'models/gemini-b']],
    ['anthropic', 'https://api.anthropic.com/v1', ['claude-a', 'claude-b']],
    ['xkiro', 'https://api.xkiro.com/v1', ['vendor/chat']],
  ] as const) {
    const connection = f.manager.add({ providerId, label: providerId, baseUrl, enabled: true }, secret)
    assert.equal((await f.catalog.refresh(connection.id)).state, 'complete')
    assert.deepEqual((await f.catalog.search({ connectionIds: [connection.id] })).entries.map(e => e.route.ref.nativeModelId).sort(), [...expected].sort())
    if (providerId !== 'xkiro') {
      const { body, token } = buildProbe(providerId, expected[0], 'systemInstructions')
      assert.ok(providerId === 'anthropic' ? body.system : body.systemInstruction)
      const response = providerId === 'anthropic' ? { content: [{ type: 'text', text: token }] } : { candidates: [{ content: { parts: [{ text: token }] } }] }
      assert.doesNotThrow(() => validateProbe(response, providerId, 'systemInstructions', token))
      assert.throws(() => validateProbe(response, providerId, 'systemInstructions', 'wrong'))
      const stream = providerId === 'anthropic' ? `data: ${JSON.stringify({ type: 'content_block_delta', delta: { text: token } })}\n\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n` : `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: token }] }, finishReason: 'STOP' }] })}\n\n`
      assert.doesNotThrow(() => validateProbe(stream, providerId, 'streaming', token))
      const incomplete = providerId === 'anthropic' ? stream.split('\n\n')[0] : `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: token }] } }] })}\n\n`
      assert.throws(() => validateProbe(incomplete, providerId, 'streaming', token))
    }
  }
})

test('manual models survive unsupported discovery and require verification before assignment', async t => {
  const f = await fixture(t, async (_endpoint, _path, _key, options) => {
    if (!options?.body) return { status: 404, body: null }
    const token = JSON.stringify(options.body).match(/[a-f0-9]{32}/)?.[0]
    assert.ok(token)
    return { status: 200, body: { choices: [{ message: { content: token } }] } }
  })
  const connection = f.manager.add({ providerId: 'openai-compatible', label: 'Custom', baseUrl: 'https://custom.example/v1', enabled: true }, secret)
  assert.equal((await f.catalog.refresh(connection.id)).state, 'unsupported')
  const manual = f.catalog.addManual(connection.id, 'private/model-v1', 'Private model')
  assert.equal((await f.assignments.assess(manual.route.id, ['text', 'systemInstructions'])).compatible, false)
  assert.equal((await f.verification.verify(manual.route.id, ['text', 'systemInstructions'])).state, 'verified')
  assert.equal((await f.assignments.assess(manual.route.id, ['text', 'systemInstructions'])).compatible, true)
  assert.deepEqual((await f.assignments.set({ agentId: '01', candidateRouteIds: [manual.route.id] }, 0)).candidateRouteIds, [manual.route.id])
  assert.equal((await f.catalog.refresh(connection.id)).state, 'unsupported')
  assert.equal((await f.catalog.getRoute(manual.route.id))?.route.lifecycle, 'active')
  const revised = f.manager.edit(connection.id, connection.revision, { label: 'Renamed custom endpoint' })
  assert.equal((await f.assignments.assess(manual.route.id, ['text', 'systemInstructions'])).compatible, false)
  const restored = f.catalog.addManual(connection.id, 'private/model-v1', 'Private model')
  assert.equal(restored.route.id, manual.route.id)
  assert.equal(restored.route.connectionRevision, revised.revision)
  assert.equal((await f.verification.verify(restored.route.id, ['text', 'systemInstructions'])).state, 'verified')
  assert.equal((await f.assignments.assess(manual.route.id, ['text', 'systemInstructions'])).compatible, true)
})

test('connection creation checks status automatically without returning secrets', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nthn-auto-check-'))
  let calls = 0
  const manager = new ConnectionManager(directory, { resolver, transport: async (_endpoint, path, key) => { calls++; assert.equal(path, '/models'); assert.equal(key, secret); return { status: 200, body: { data: [] } } } })
  const api = new AiManagementApi(manager)
  t.after(async () => { api.close(); await rm(directory, { recursive: true, force: true }) })
  const added = await api.action({ action: 'connection.add', connection: { providerId: 'openai', label: 'Primary', baseUrl: 'https://api.openai.com/v1' }, apiKey: secret }) as { id: string; revision: number }
  assert.equal(calls, 1)
  await api.action({ action: 'connection.edit', id: added.id, revision: added.revision, patch: { label: 'Renamed' } })
  assert.equal(calls, 1)
  assert.ok(!JSON.stringify(api.snapshot('csrf')).includes(secret))
})

test('Alex can use an explicitly assigned native Anthropic or Gemini route', async t => {
  for (const providerId of ['anthropic', 'gemini'] as const) {
    const f = await fixture(t, async (_endpoint, _path, _key, options) => {
      if (!options?.body) return { status: 200, body: providerId === 'anthropic' ? { data: [{ id: 'fixture-model' }] } : { models: [{ name: 'models/fixture-model', supportedGenerationMethods: ['generateContent'] }] } }
      const token = JSON.stringify(options.body).match(/[a-f0-9]{32}/)?.[0]
      const content = token ?? 'Native Alex reply.'
      return { status: 200, body: providerId === 'anthropic' ? { content: [{ type: 'text', text: content }] } : { candidates: [{ content: { parts: [{ text: content }] } }] } }
    })
    const baseUrl = providerId === 'anthropic' ? 'https://api.anthropic.com/v1' : 'https://generativelanguage.googleapis.com/v1beta'
    const connection = f.manager.add({ providerId, label: providerId, baseUrl, enabled: true }, secret)
    await f.catalog.refresh(connection.id)
    const route = (await f.catalog.search({ connectionIds: [connection.id] })).entries[0].route
    assert.equal((await f.verification.verify(route.id, ['text', 'systemInstructions'])).state, 'verified')
    await f.assignments.set({ agentId: '01', candidateRouteIds: [route.id] }, 0)
    const memory = new MemoryStore(join(f.directory, 'alex')); await memory.load()
    const alex = new AlexAssignedProvider(f.manager, f.catalog, f.assignments, f.verification, memory)
    await alex.prepare()
    assert.equal(await alex.complete([{ role: 'system', content: 'Identity' }, { role: 'user', content: 'Hello' }]), 'Native Alex reply.')
  }
})

test('protected transport sends only the selected credential header', async t => {
  const headers: Record<string, string | string[] | undefined>[] = []
  const server = createServer((request, response) => { headers.push(request.headers); response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{"data":[]}') })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}`
  const endpoint = { base, url: new URL(base), host: '127.0.0.1', address: '127.0.0.1' }
  for (const style of ['bearer', 'x-api-key', 'anthropic', 'gemini'] as const) await requestPinnedJson(endpoint, '/models', secret, { authStyle: style })
  assert.equal(headers[0].authorization, `Bearer ${secret}`)
  assert.equal(headers[1]['x-api-key'], secret); assert.equal(headers[1].authorization, undefined)
  assert.equal(headers[2]['x-api-key'], secret); assert.equal(headers[2]['anthropic-version'], '2023-06-01')
  assert.equal(headers[3]['x-goog-api-key'], secret); assert.equal(headers[3].authorization, undefined)
})
