import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, stat, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import { ConnectionManager } from '../server/ai/connection-manager.ts'
import { CatalogService } from '../server/ai/catalog-service.ts'
import { CatalogStore } from '../server/ai/catalog-store.ts'
import type { ProbeTransport } from '../server/ai/endpoint-policy.ts'
import { ManagementError } from '../server/ai/management-types.ts'
import { modelRouteKey } from '../server/ai/route-identity.ts'
import { parseDiscovery } from '../server/ai/discovery.ts'

const secret = 'fixture-only-private-key-never-a-real-credential'
const generic = { providerId: 'openai-compatible', label: 'same name', baseUrl: 'https://provider.example/v1', enabled: true }
const router = { providerId: 'openrouter', label: 'same name', baseUrl: 'https://openrouter.ai/api/v1', enabled: true }
const resolver = async () => [{ address: '8.8.8.8', family: 4 }]
const code = (value: string) => (error: unknown) => error instanceof ManagementError && error.code === value
async function fixture(t: { after: (fn: () => Promise<void>) => void }, transport: ProbeTransport) {
  const directory = await mkdtemp(join(tmpdir(), 'nthn-catalog-test-'))
  const manager = new ConnectionManager(directory, { resolver, transport })
  const catalog = new CatalogService(manager)
  t.after(async () => { catalog.close(); manager.close(); await rm(directory, { recursive: true, force: true }) })
  return { directory, manager, catalog }
}

test('OpenRouter exhausts offset pages beyond 1000 models and includes all modalities', async t => {
  const requests: string[] = [], models = Array.from({ length: 1203 }, (_, i) => ({ id: `vendor/Model-${i}`, name: 'Duplicate display name', architecture: { input_modalities: ['text'], output_modalities: i % 2 ? ['image'] : ['text'] } }))
  const { catalog, manager } = await fixture(t, async (_endpoint, path, key) => {
    assert.equal(key, secret); requests.push(path)
    const url = new URL(path, 'https://openrouter.ai'); assert.equal(url.pathname, '/models/user'); assert.equal(url.searchParams.get('output_modalities'), 'all')
    const offset = Number(url.searchParams.get('offset')); return { status: 200, body: { data: models.slice(offset, offset + 500) } }
  })
  const c = manager.add(router, secret)
  const status = await catalog.refresh(c.id)
  assert.equal(status.state, 'complete'); assert.equal(status.modelsSeen, 1203); assert.equal(requests.length, 3)
  let page = await catalog.search({ pageSize: 200 }), count = page.entries.length
  while (page.nextCursor) { page = await catalog.search({ pageSize: 200, cursor: page.nextCursor }); count += page.entries.length }
  assert.equal(count, 1203); assert.equal(page.total, 1203)
  assert.equal((await catalog.search({ outputModality: 'image' })).total, 601)
  assert.ok(page.entries.every(e => e.route.access.state === 'account-listed'))
  assert.ok(page.entries.every(e => e.route.access.state !== 'verified'))
  assert.equal(manager.get(c.id).health.inference, 'never-tested')
})

test('identical native IDs and names retain separate account/provider routes with exact IDs', async t => {
  const ids = ['vendor/Model:free', 'vendor/Model', 'vendor/model', ' spaced model /日本語 ']
  const { catalog, manager } = await fixture(t, async () => ({ status: 200, body: { data: ids.map(id => ({ id, name: 'Same' })) } }))
  const one = manager.add(generic), two = manager.add(generic), three = manager.add(router, secret)
  const results = await catalog.sync(true)
  assert.equal(results.length, 3)
  const entries = (await catalog.search()).entries
  assert.equal(entries.length, 12); assert.equal(new Set(entries.map(e => e.route.id)).size, 12)
  for (const c of [one, two, three]) {
    const filtered = await catalog.search({ connectionIds: [c.id] })
    assert.equal(filtered.total, 4)
    for (const id of ids) assert.ok(filtered.entries.some(e => e.route.ref.nativeModelId === id))
  }
  assert.equal((await catalog.search({ providerIds: ['openrouter'] })).total, 4)
})

test('generic has_more/after pagination, opaque cursors and response Link headers are followed', async t => {
  let mode = 0
  const { catalog, manager } = await fixture(t, async (_endpoint, path) => {
    const query = new URL(path, 'https://provider.example').searchParams
    if (!query.size) return mode === 0 ? { status: 200, body: { data: [{ id: 'opaque/id:ONE' }], has_more: true, last_id: 'opaque/id:ONE' } } : mode === 1 ? { status: 200, body: { data: [{ id: 'one' }], next_cursor: 'cursor +/= exact' } } : { status: 200, body: { data: [{ id: 'one' }] }, link: '<https://provider.example/v1/models?after=one>; rel="next"' }
    if (mode === 0) assert.equal(query.get('after'), 'opaque/id:ONE')
    if (mode === 1) assert.equal(query.get('cursor'), 'cursor +/= exact')
    return { status: 200, body: { data: [{ id: 'two' }], has_more: false } }
  })
  const c = manager.add(generic)
  for (mode = 0; mode < 3; mode++) {
    assert.equal((await catalog.refresh(c.id)).state, 'complete')
    assert.ok((await catalog.getRoute(modelRouteKey({ connectionId: c.id, nativeModelId: 'two', upstreamEndpointId: null }))))
  }
})

test('generic page tokens, next offsets, totals and same-origin next links finish enumeration', async t => {
  let mode = 0, calls = 0
  const { catalog, manager } = await fixture(t, async (_endpoint, path) => {
    calls++
    const query = new URL(path, 'https://provider.example').searchParams
    if (!query.size) return { status: 200, body: { data: [{ id: 'first' }], ...[
      { nextPageToken: 'token' }, { next_page_token: 'token' }, { next_page: '2' }, { next_offset: 1 }, { total: 2 }, { links: { next: 'https://provider.example/v1/models?after=first' } },
    ][mode] } }
    return { status: 200, body: { data: [{ id: 'last' }], has_more: false } }
  })
  const c = manager.add(generic)
  for (mode = 0; mode < 6; mode++) { calls = 0; assert.equal((await catalog.refresh(c.id)).state, 'complete'); assert.equal(calls, 2) }
})

test('source capabilities/context/vendor metadata persist while unknowns are never invented', async t => {
  const { catalog, manager } = await fixture(t, async () => ({ status: 200, body: { data: [
    { id: 'rich', name: 'Rich', context_length: 128000, supported_parameters: ['tools', 'response_format'], architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'], tokenizer: 'source-tokenizer' }, top_provider: { max_completion_tokens: 16000 }, pricing: { prompt: '0', completion: '0' }, owned_by: 'source-owner', api_key: 'unrelated-secret-field-must-not-be-persisted' },
    { id: 'unknown' },
  ] } }))
  const c = manager.add(generic); await catalog.refresh(c.id)
  const rich = (await catalog.search({ search: 'Rich' })).entries[0]
  assert.equal(rich.route.model.contextTokens, 128000); assert.equal(rich.route.model.maxOutputTokens, 16000)
  assert.equal(rich.route.model.capabilities.tools, 'supported'); assert.deepEqual(rich.route.model.capabilities.input, ['text', 'image'])
  assert.equal(rich.route.model.extensions.owned_by, 'source-owner')
  assert.deepEqual(rich.route.model.extensions.pricing, { prompt: '0', completion: '0' })
  assert.equal(rich.pricing.freeAccess.kind, 'unknown'); assert.equal(rich.pricing.freeAccess.eligibility, 'unknown')
  const unknown = (await catalog.search({ search: 'unknown' })).entries[0]
  assert.equal(unknown.route.model.capabilities.tools, 'unknown'); assert.equal(unknown.route.model.capabilities.input, null)
  assert.equal(unknown.route.model.contextTokens, null)
  assert.ok(!JSON.stringify(await catalog.search()).includes('unrelated-secret-field'))
})

test('Ollama tags retain exact quantized identities, digest, details and explicit capabilities', async t => {
  const { catalog, manager } = await fixture(t, async (_endpoint, path) => {
    assert.equal(path, '/api/tags'); return { status: 200, body: { models: [{ name: 'local/model:Q4', digest: 'fixture-digest', size: 1234, details: { family: 'source-family', quantization_level: 'Q4' }, capabilities: ['completion', 'vision', 'tools'] }] } }
  })
  const c = manager.add({ providerId: 'ollama', label: 'Ollama', baseUrl: 'http://127.0.0.1:11434', networkPolicy: 'loopback', enabled: true })
  assert.equal((await catalog.refresh(c.id)).state, 'complete')
  const entry = (await catalog.search()).entries[0]
  assert.equal(entry.route.ref.nativeModelId, 'local/model:Q4'); assert.equal(entry.route.model.extensions.digest, 'fixture-digest')
  assert.equal(entry.route.model.capabilities.tools, 'supported'); assert.deepEqual(entry.route.model.capabilities.input, ['text', 'image'])
  assert.equal(entry.route.access.state, 'listed')
})

test('failed/partial refresh retains the last complete catalog and exposes provider unavailability', async t => {
  let mode = 0
  const { catalog, manager } = await fixture(t, async (_e, path) => {
    if (mode === 0) return { status: 200, body: { data: [{ id: 'old' }] } }
    if (new URL(path, 'https://provider.example').searchParams.has('after')) return { status: 503, body: null }
    return { status: 200, body: { data: [{ id: 'new-uncommitted' }], has_more: true } }
  })
  const c = manager.add(generic); await catalog.refresh(c.id)
  mode = 1; const failed = await catalog.refresh(c.id)
  assert.equal(failed.state, 'partial'); assert.equal(failed.errorCode, 'PROBE_FAILED')
  const entries = (await catalog.search()).entries
  assert.equal(entries.length, 1); assert.equal(entries[0].route.ref.nativeModelId, 'old'); assert.equal(entries[0].route.access.state, 'unavailable')
  assert.equal(entries[0].route.lifecycle, 'active')
  mode = 0; await catalog.refresh(c.id)
  assert.equal((await catalog.search()).entries[0].route.access.state, 'listed')
})

test('only complete success retires missing models and preserves firstSeenAt on rediscovery', async t => {
  let models = [{ id: 'one' }, { id: 'two' }]
  const { catalog, manager } = await fixture(t, async () => ({ status: 200, body: { data: models } }))
  const c = manager.add(generic); await catalog.refresh(c.id)
  const first = (await catalog.search({ search: 'two' })).entries[0].firstSeenAt
  models = [{ id: 'one' }]; await catalog.refresh(c.id)
  const removed = (await catalog.search({ search: 'two' })).entries[0]
  assert.equal(removed.route.lifecycle, 'removed'); assert.equal(removed.route.access.state, 'unavailable')
  models = [{ id: 'two' }]; await catalog.refresh(c.id)
  const returned = (await catalog.search({ search: 'two' })).entries[0]
  assert.equal(returned.firstSeenAt, first); assert.equal(returned.route.lifecycle, 'active')
})

test('repeating cursors or ignored pagination fail rather than silently truncate or loop forever', async t => {
  let calls = 0
  const { catalog, manager } = await fixture(t, async () => { calls++; return { status: 200, body: { data: [{ id: 'one' }], next_cursor: String(calls) } } })
  const c = manager.add(generic)
  const result = await catalog.refresh(c.id)
  assert.equal(result.errorCode, 'PAGINATION_INVALID'); assert.equal(calls, 2)
  assert.equal((await catalog.search()).total, 0)
})

test('cross-origin/path pagination cannot leak credentials or escape the model-list endpoint', async t => {
  let next = 'https://169.254.169.254/metadata', calls = 0
  const { catalog, manager } = await fixture(t, async () => { calls++; return { status: 200, body: { data: [{ id: 'one' }], next } } })
  const c = manager.add(generic, secret)
  for (next of ['https://evil.example/v1/models?after=x', '/v1/chat/completions?after=x', '/v1/models?api_key=x', '/v1/models?after=x#fragment']) {
    calls = 0; const result = await catalog.refresh(c.id)
    assert.equal(result.errorCode, 'PAGINATION_INVALID'); assert.equal(calls, 1)
  }
})

test('credential echoes in model IDs, cursor links or errors are rejected before catalog persistence', async t => {
  let mode = 0
  const { catalog, manager, directory } = await fixture(t, async () => mode === 0 ? { status: 200, body: { data: [{ id: secret }] } } : mode === 1 ? { status: 200, body: { data: [{ id: 'normal' }] }, link: `<https://provider.example/v1/models?after=${secret}>; rel="next"` } : { status: 401, body: { error: secret } })
  const c = manager.add(generic, secret)
  for (mode = 0; mode < 3; mode++) {
    const result = await catalog.refresh(c.id)
    assert.notEqual(result.state, 'complete'); assert.ok(!JSON.stringify(result).includes(secret))
  }
  assert.equal((await catalog.search()).total, 0)
  assert.ok(!(await readFile(join(directory, 'catalog.sqlite'))).includes(Buffer.from(secret)))
  assert.ok(!JSON.stringify(manager.audit()).includes(secret))
})

test('automatic sync detects enabled additions/config changes, skips disabled and backs off failures independently', async t => {
  let calls = 0
  const { catalog, manager } = await fixture(t, async endpoint => { calls++; return endpoint.host === 'broken.example' ? { status: 503, body: null } : { status: 200, body: { data: [{ id: 'one' }] } } })
  manager.add({ ...generic, enabled: false })
  let good = manager.add(generic), bad = manager.add({ ...generic, baseUrl: 'https://broken.example/v1' })
  const first = await catalog.sync(); assert.equal(first.length, 2); assert.equal(calls, 2)
  assert.equal((await catalog.sync()).length, 0)
  const failure = catalog.statuses().find(s => s.connectionId === bad.id)!
  assert.equal(failure.state, 'failed'); assert.ok(failure.nextAttemptAt >= Date.parse(failure.completedAt!) + 60000)
  assert.equal((await catalog.sync(false, failure.nextAttemptAt + 1)).length, 1)
  good = manager.edit(good.id, good.revision, { label: 'Edited config' })
  assert.equal((await catalog.sync()).length, 1)
  bad = manager.setEnabled(bad.id, bad.revision, false)
  await assert.rejects(catalog.refresh(bad.id), code('CONNECTION_DISABLED'))
})

test('config changes/removal invalidate access immediately; in-flight stale results cannot publish', async t => {
  let release!: () => void, pause = false
  const { catalog, manager } = await fixture(t, async () => { if (pause) await new Promise<void>(resolve => { release = resolve }); return { status: 200, body: { data: [{ id: 'one' }] } } })
  let c = manager.add(generic); await catalog.refresh(c.id)
  pause = true; const pending = catalog.refresh(c.id)
  while (!release) await new Promise(resolve => setTimeout(resolve, 1))
  c = manager.setEnabled(c.id, c.revision, false); release()
  assert.equal((await pending).errorCode, 'CONFLICT')
  assert.equal((await catalog.search()).entries[0].route.access.state, 'unavailable')
  manager.remove(c.id, c.revision)
  assert.equal((await catalog.search()).entries[0].route.lifecycle, 'removed')
})

test('search is literal and paginated; changed catalogs/configuration reject old cursors', async t => {
  const { catalog, manager } = await fixture(t, async () => ({ status: 200, body: { data: [{ id: 'abc%_literal', name: 'Target' }, { id: 'other' }, { id: 'third' }] } }))
  let c = manager.add(generic); await catalog.refresh(c.id)
  assert.equal((await catalog.search({ search: '%_' })).total, 1)
  assert.equal((await catalog.search({ search: "' OR 1=1 --" })).total, 0)
  const first = await catalog.search({ pageSize: 1 }); assert.ok(first.nextCursor)
  assert.equal((await catalog.search({ pageSize: 1, cursor: first.nextCursor })).entries.length, 1)
  await catalog.refresh(c.id)
  await assert.rejects(catalog.search({ pageSize: 1, cursor: first.nextCursor }), code('CATALOG_CHANGED'))
  const fresh = await catalog.search({ pageSize: 1 }); c = manager.setEnabled(c.id, c.revision, false)
  await assert.rejects(catalog.search({ pageSize: 1, cursor: fresh.nextCursor! }), code('CATALOG_CHANGED'))
  await assert.rejects(catalog.search({ pageSize: 0 }), code('INVALID_INPUT'))
  await assert.rejects(catalog.search({ cursor: 'malformed' }), code('INVALID_INPUT'))
})

test('catalog persists across restarts with safe private permissions and independent schema', async t => {
  const { catalog, manager, directory } = await fixture(t, async () => ({ status: 200, body: { data: [{ id: 'persisted' }] } }))
  const c = manager.add(generic); await catalog.refresh(c.id)
  assert.equal((await stat(join(directory, 'catalog.sqlite'))).mode & 0o777, 0o600)
  const second = new CatalogService(manager)
  assert.equal((await second.search()).total, 1); assert.equal(second.statuses()[0].state, 'complete'); second.close()
  await chmod(join(directory, 'catalog.sqlite'), 0o644)
  assert.throws(() => new CatalogService(manager), code('STORE_FAILED'))
  await chmod(join(directory, 'catalog.sqlite'), 0o600)
})

test('refresh leases prevent concurrent writers and recover interrupted staging without publishing it', async t => {
  const { catalog, manager } = await fixture(t, async () => ({ status: 200, body: { data: [] } }))
  const c = manager.add(generic), store = new CatalogStore(manager)
  t.after(async () => store.close())
  const running = store.begin(c)
  await assert.rejects(catalog.refresh(c.id), code('CATALOG_BUSY'))
  const replacement = store.begin(c, running.leaseExpiresAt + 1)
  assert.notEqual(replacement.id, running.id)
  assert.throws(() => store.stage(running, [], null), code('CONFLICT'))
  store.finish(replacement, null, 300000)
  assert.equal((await catalog.search()).total, 0)
})

test('404 is explicitly unsupported; empty/malformed pages never manufacture models', async t => {
  let body: unknown = {}, status = 404
  const { catalog, manager } = await fixture(t, async () => ({ status, body }))
  const c = manager.add(generic)
  assert.equal((await catalog.refresh(c.id)).state, 'unsupported')
  status = 200; body = { data: [{ id: '' }] }
  assert.equal((await catalog.refresh(c.id)).state, 'failed')
  body = { data: [], has_more: true }; assert.equal((await catalog.refresh(c.id)).errorCode, 'PAGINATION_INVALID')
  body = { data: [] }; assert.equal((await catalog.refresh(c.id)).state, 'complete')
})

test('real local HTTP catalog and CLI share persisted routes without any paid inference', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nthn-catalog-http-')), server = createServer((req, res) => {
    assert.ok(req.url?.startsWith('/v1/models'))
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(req.url!.includes('after=') ? { data: [{ id: 'second' }], has_more: false } : { data: [{ id: 'first' }], has_more: true }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }) })
  const address = server.address(); assert.ok(address && typeof address === 'object')
  const manager = new ConnectionManager(directory, { rules: { localPorts: [address.port] } }), catalog = new CatalogService(manager)
  const c = manager.add({ ...generic, baseUrl: `http://127.0.0.1:${address.port}/v1`, networkPolicy: 'loopback' })
  assert.equal((await catalog.refresh(c.id)).modelsSeen, 2)
  catalog.close(); manager.close()
  const cli = new URL('../server/ai/catalog-cli.ts', import.meta.url).pathname
  const result = spawnSync(process.execPath, [cli, 'search', '{"search":"second"}'], { encoding: 'utf8', env: { ...process.env, AI_PROVIDER_DATA_DIR: directory } })
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).entries[0].route.ref.nativeModelId, 'second')
})

test('pagination parsers preserve null end markers and reject unsafe query continuations', async t => {
  const { manager } = await fixture(t, async () => ({ status: 200, body: {} })), c = manager.add(generic)
  assert.equal(parseDiscovery({ data: [{ id: 'one' }], next_cursor: null }, c, {}).nextQuery, null)
  assert.throws(() => parseDiscovery({ data: [{ id: 'one' }], next: 'https://user:password@provider.example/v1/models?after=x' }, c, {}), code('PAGINATION_INVALID'))
})


test('inconsistent pagination totals/end markers cannot be reported as complete', async t => {
  let mode = 0
  const { catalog, manager } = await fixture(t, async (_e, path) => ({ status: 200, body: path.includes('offset=') ? { data: [{ id: 'second' }], has_more: false } : { data: [{ id: 'first' }], ...(mode === 0 ? { total: 3 } : { has_more: true, next_cursor: null }) } }))
  const c = manager.add(generic)
  for (mode = 0; mode < 2; mode++) assert.equal((await catalog.refresh(c.id)).errorCode, 'PAGINATION_INVALID')
  assert.equal((await catalog.search()).total, 0)
})

test('source page counts and duplicate IDs within a page retain exact unique routes', async t => {
  const { catalog, manager } = await fixture(t, async (_e, path) => ({ status: 200, body: path.includes('page=2') ? { data: [{ id: 'second' }], pagination: { current_page: 2, total_pages: 2 } } : { data: [{ id: 'first' }, { id: 'first' }], pagination: { current_page: 1, total_pages: 2 } } }))
  const c = manager.add(generic)
  assert.equal((await catalog.refresh(c.id)).modelsSeen, 2); assert.equal((await catalog.search()).total, 2)
})

test('catalog writer locks do not admit stale refresh commits after a lease is replaced', async t => {
  const { catalog, manager } = await fixture(t, async () => ({ status: 200, body: { data: [] } })), c = manager.add(generic)
  const first = new CatalogStore(manager), second = new CatalogStore(manager)
  t.after(async () => { first.close(); second.close() })
  const old = first.begin(c), replacement = second.begin(c, old.leaseExpiresAt + 1)
  assert.throws(() => first.finish(old, null, 300000), code('CONFLICT'))
  second.finish(replacement, null, 300000)
  assert.equal(catalog.statuses()[0].state, 'complete')
})

test('real discovery responses larger than the old 1MB probe bound are cataloged without truncation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nthn-large-catalog-'))
  const models = Array.from({ length: 1800 }, (_, i) => ({ id: 'large-' + i, description: 'x'.repeat(650) }))
  const server = createServer((_req, res) => { res.end(JSON.stringify({ data: models })) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); assert.ok(address && typeof address === 'object')
  const manager = new ConnectionManager(directory, { rules: { localPorts: [address.port] } }), catalog = new CatalogService(manager)
  t.after(async () => { catalog.close(); manager.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }) })
  const c = manager.add({ ...generic, baseUrl: 'http://127.0.0.1:' + address.port + '/v1', networkPolicy: 'loopback' })
  assert.equal((await catalog.refresh(c.id)).modelsSeen, 1800)
  assert.equal((await catalog.search()).total, 1800)
})

test('watch discovers newly enabled connections and later revisions without manual refresh', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nthn-watch-catalog-'))
  let requests = 0
  const server = createServer((_req, res) => { requests++; res.end(JSON.stringify({ data: [{ id: 'watch-model' }] })) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); assert.ok(address && typeof address === 'object')
  const manager = new ConnectionManager(directory, { rules: { localPorts: [address.port] } }), catalog = new CatalogService(manager)
  let c = manager.add({ ...generic, baseUrl: 'http://127.0.0.1:' + address.port + '/v1', networkPolicy: 'loopback', enabled: false })
  const cli = new URL('../server/ai/catalog-cli.ts', import.meta.url).pathname
  const child = spawn(process.execPath, [cli, 'watch'], { env: { ...process.env, AI_PROVIDER_DATA_DIR: directory, AI_PROVIDER_LOCAL_PORTS: String(address.port), AI_CATALOG_REFRESH_MS: '60000' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let errors = ''; child.stderr.on('data', chunk => { errors += chunk.toString() }); child.stdout.resume()
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await new Promise(resolve => child.once('exit', resolve)) }
    catalog.close(); manager.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true })
  })
  assert.equal(requests, 0)
  const wait = async (condition: () => boolean) => {
    const deadline = Date.now() + 15000
    while (!condition()) {
      if (child.exitCode !== null || Date.now() > deadline) assert.fail('Watch did not refresh: ' + errors)
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  c = manager.setEnabled(c.id, c.revision, true)
  await wait(() => catalog.statuses().some(status => status.state === 'complete'))
  assert.equal((await catalog.search()).total, 1)
  const before = requests; c = manager.edit(c.id, c.revision, { label: 'changed while watching' })
  await wait(() => requests > before && catalog.statuses().some(status => status.state === 'complete' && status.connectionRevision === c.revision))
  assert.equal((await catalog.search()).entries[0].route.access.state, 'listed')
  child.kill('SIGTERM')
  await new Promise(resolve => child.once('exit', resolve))
  assert.equal(child.exitCode, 0)
})

test('combined startup keeps the existing API/UI alive if the catalog worker fails, and cleans up on shutdown', async t => {
  const { mkdir, writeFile } = await import('node:fs/promises')
  const directory = await mkdtemp(join(tmpdir(), 'nthn-runner-test-'))
  await mkdir(join(directory, 'scripts')); await mkdir(join(directory, 'server', 'ai'), { recursive: true }); await mkdir(join(directory, 'node_modules', 'vite', 'bin'), { recursive: true })
  await writeFile(join(directory, 'scripts', 'serve.mjs'), await readFile(new URL('../scripts/serve.mjs', import.meta.url)))
  const stayAlive = `console.log('fixture-process:' + process.pid); process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000);`
  await writeFile(join(directory, 'server', 'index.ts'), stayAlive + "process.send?.('ready');")
  await writeFile(join(directory, 'node_modules', 'vite', 'bin', 'vite.js'), stayAlive)
  await writeFile(join(directory, 'server', 'ai', 'catalog-cli.ts'), 'process.exit(1)')
  const child = spawn(process.execPath, [join(directory, 'scripts', 'serve.mjs'), 'dev'], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk.toString() }); child.stderr.on('data', chunk => { stderr += chunk.toString() })
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)) }
    for (const match of stdout.matchAll(/fixture-process:(\d+)/g)) { try { process.kill(Number(match[1]), 'SIGTERM') } catch { /* Fixture already exited. */ } }
    await rm(directory, { recursive: true, force: true })
  })
  const deadline = Date.now() + 10000
  while (!stderr.includes('Catalog worker stopped') || [...stdout.matchAll(/fixture-process:/g)].length < 2) {
    if (child.exitCode !== null || Date.now() > deadline) assert.fail('Runner startup fixture failed: ' + stderr)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.equal(child.exitCode, null)
  const pids = [...stdout.matchAll(/fixture-process:(\d+)/g)].map(match => Number(match[1]))
  for (const pid of pids) assert.doesNotThrow(() => process.kill(pid, 0))
  child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve))
  assert.equal(child.exitCode, 0)
  for (const pid of pids) assert.throws(() => process.kill(pid, 0))
})
