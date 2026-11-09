import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile, chmod, stat, symlink, readdir, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { ConnectionManager } from '../server/ai/connection-manager.ts'
import { CredentialVault } from '../server/ai/credential-vault.ts'
import { ManagementError } from '../server/ai/management-types.ts'
import { endpointRulesFromEnv, pinEndpoint, publicAddress, requestPinnedJson, validateEndpoint } from '../server/ai/endpoint-policy.ts'

const key = 'test-only-provider-credential-NotARealAPIKey'
const openrouter = { providerId: 'openrouter', label: 'Account', baseUrl: 'https://openrouter.ai/api/v1' }
const compatible = { providerId: 'openai-compatible', label: 'Gateway', baseUrl: 'https://provider.example/v1' }
const publicResolver = async () => [{ address: '8.8.8.8', family: 4 }]
function code(expected: string) { return (error: unknown) => error instanceof ManagementError && error.code === expected }
async function directory(t: { after: (fn: () => Promise<void>) => void }) {
  const path = await mkdtemp(join(tmpdir(), 'nthn-provider-test-'))
  t.after(async () => { await rm(path, { recursive: true, force: true }) })
  return path
}

// Fixtures never become operational providers or replace the existing Alex runtime.
test('multiple accounts persist independently with encrypted credentials and no plaintext in metadata/audit/database', async t => {
  const path = await directory(t)
  const manager = new ConnectionManager(path)
  const a = manager.add(openrouter, key), b = manager.add(openrouter, key)
  assert.notEqual(a.id, b.id); assert.equal(a.enabled, false); assert.equal(a.credentials.state, 'configured')
  assert.equal(manager.list().length, 2)
  for (const value of [manager.list(), manager.audit(), manager]) assert.ok(!JSON.stringify(value).includes(key))
  manager.close()
  const db = new DatabaseSync(join(path, 'providers.sqlite'), { readOnly: true })
  const rows = db.prepare('SELECT cipher FROM connections ORDER BY rowid').all() as { cipher: string }[]
  assert.notEqual(rows[0].cipher, rows[1].cipher); db.close()
  for (const file of await readdir(path)) assert.ok(!(await readFile(join(path, file))).includes(Buffer.from(key)), file)
  assert.equal((await stat(join(path, 'master.key'))).mode & 0o777, 0o600)
  assert.equal((await stat(join(path, 'providers.sqlite'))).mode & 0o777, 0o600)
  const restored = new ConnectionManager(path, { resolver: publicResolver, transport: async (_endpoint, _probe, actual) => { assert.equal(actual, key); return { status: 200, body: { data: { is_free_tier: false } } } } })
  t.after(async () => restored.close())
  assert.equal(restored.get(a.id).label, 'Account')
  assert.equal((await restored.test(a.id, a.revision)).ok, true)
})

test('edit, enable, disable, replace/clear credentials and remove are revision-checked and persistent', async t => {
  const path = await directory(t), manager = new ConnectionManager(path)
  t.after(async () => manager.close())
  let a = manager.add(openrouter, key)
  a = manager.edit(a.id, a.revision, { label: 'Renamed', scope: { account: 'A', project: 'P', region: null } })
  a = manager.setEnabled(a.id, a.revision, true); assert.equal(a.enabled, true)
  assert.throws(() => manager.setEnabled(a.id, 1, false), code('CONFLICT'))
  a = manager.setEnabled(a.id, a.revision, false); assert.equal(a.enabled, false)
  a = manager.setCredential(a.id, a.revision, 'replacement-test-only'); assert.equal(a.credentials.revision, 2)
  a = manager.setCredential(a.id, a.revision, null); assert.equal(a.credentials.state, 'missing')
  manager.remove(a.id, a.revision)
  assert.equal(manager.list().length, 0); assert.throws(() => manager.get(a.id), code('NOT_FOUND'))
  assert.equal(manager.audit()[0].action, 'remove')
})

test('a second process/store instance cannot overwrite a stale revision', async t => {
  const path = await directory(t), one = new ConnectionManager(path), two = new ConnectionManager(path)
  t.after(async () => { one.close(); two.close() })
  const original = one.add(compatible)
  one.edit(original.id, original.revision, { label: 'first writer' })
  assert.throws(() => two.edit(original.id, original.revision, { label: 'lost update' }), code('CONFLICT'))
  assert.equal(two.get(original.id).label, 'first writer')
})

test('endpoint edits clear old credentials before a different host/path can receive them', async t => {
  const path = await directory(t), manager = new ConnectionManager(path, { resolver: publicResolver, transport: async (_e, _p, secret) => { assert.equal(secret, null); return { status: 200, body: { data: [] } } } })
  t.after(async () => manager.close())
  let connection = manager.add(compatible, key)
  connection = manager.edit(connection.id, connection.revision, { baseUrl: 'https://other.example/v1' })
  assert.equal(connection.credentials.state, 'missing')
  assert.equal((await manager.test(connection.id, connection.revision)).ok, true)
})

test('vault uses randomized authenticated encryption bound to connection/revision; wrong keys and tampering fail', () => {
  const secret = randomBytes(32), vault = new CredentialVault(secret), wrong = new CredentialVault(randomBytes(32))
  const sealed = vault.seal(key, 'connection:1')
  assert.equal(vault.open(sealed, 'connection:1'), key)
  assert.notEqual(vault.seal(key, 'connection:1'), sealed)
  assert.throws(() => vault.open(sealed, 'connection:2'), code('DECRYPT_FAILED'))
  assert.throws(() => wrong.open(sealed, 'connection:1'), code('DECRYPT_FAILED'))
  const damaged = JSON.parse(sealed); damaged.tag = Buffer.alloc(16).toString('base64')
  assert.throws(() => vault.open(JSON.stringify(damaged), 'connection:1'), code('DECRYPT_FAILED'))
  vault.destroy(); wrong.destroy()
})

test('wrong or missing master keys never silently replace an existing encrypted store', async t => {
  const path = await directory(t), manager = new ConnectionManager(path)
  manager.add(openrouter, key); manager.close()
  const original = await readFile(join(path, 'master.key'))
  await writeFile(join(path, 'master.key'), randomBytes(32))
  assert.throws(() => new ConnectionManager(path), code('DECRYPT_FAILED'))
  await rm(join(path, 'master.key'))
  assert.throws(() => new ConnectionManager(path), code('KEY_UNAVAILABLE'))
  await writeFile(join(path, 'master.key'), original, { mode: 0o600 })
  const restored = new ConnectionManager(path); assert.equal(restored.list().length, 1); restored.close()
})

test('unsafe permissions, symlinked key/database and future schemas fail closed', async t => {
  const path = await directory(t), manager = new ConnectionManager(path)
  manager.close()
  const keyPath = join(path, 'master.key'), contents = await readFile(keyPath)
  await chmod(keyPath, 0o644); assert.throws(() => new ConnectionManager(path), code('KEY_UNAVAILABLE')); await chmod(keyPath, 0o600)
  await rm(keyPath); await writeFile(join(path, 'elsewhere.key'), contents, { mode: 0o600 }); await symlink(join(path, 'elsewhere.key'), keyPath)
  assert.throws(() => new ConnectionManager(path), code('KEY_UNAVAILABLE'))
  await rm(keyPath); await writeFile(keyPath, contents, { mode: 0o600 })
  const database = join(path, 'providers.sqlite')
  await rename(database, database + '.safe')
  await symlink(database + '.safe', database)
  assert.throws(() => new ConnectionManager(path), code('STORE_FAILED'))
  await rm(database); await rename(database + '.safe', database)
  const db = new DatabaseSync(database); db.exec('PRAGMA user_version=99'); db.close()
  assert.throws(() => new ConnectionManager(path), code('STORE_FAILED'))
})

test('strict connection input rejects unknown fields/providers, invalid booleans/scope, header injection and missing revisions', async t => {
  const path = await directory(t), manager = new ConnectionManager(path)
  t.after(async () => manager.close())
  for (const input of [{ ...openrouter, apiKey: key }, { ...openrouter, providerId: 'unknown' }, { ...openrouter, enabled: 'yes' }, { ...openrouter, scope: { account: 'x' } }, { ...openrouter, label: '\n' }]) assert.throws(() => manager.add(input), code('INVALID_INPUT'))
  assert.throws(() => manager.add(openrouter, 'key\r\nInjected: header'), code('INVALID_CREDENTIAL'))
  const a = manager.add(openrouter)
  assert.throws(() => manager.edit(a.id, NaN, { enabled: true }), code('INVALID_INPUT'))
  assert.throws(() => manager.edit(a.id, a.revision, { providerId: 'ollama' }), code('INVALID_INPUT'))
  assert.equal(manager.get(a.id).revision, 1)
})

test('endpoint syntax blocks credentials, query tokens, redirects-as-paths, non-HTTPS public hosts and unauthorized local ports', () => {
  for (const endpoint of ['http://provider.example/v1', 'https://user:secret@provider.example/v1', 'https://provider.example/v1?key=secret', 'https://provider.example/v1#key', 'https://provider.example/%2e%2e/', 'file:///etc/passwd', 'https://127.0.0.1/v1', 'https://169.254.169.254/v1', 'https://2130706433/v1', 'https://[::ffff:127.0.0.1]/v1', 'https://provider.local/v1']) assert.throws(() => validateEndpoint(endpoint, 'public', 'openai-compatible'), code('INVALID_ENDPOINT'))
  assert.throws(() => validateEndpoint('https://evil.example/api/v1', 'public', 'openrouter'), code('INVALID_ENDPOINT'))
  for (const port of [22, 3000, 3001, 9000]) assert.throws(() => validateEndpoint(`http://127.0.0.1:${port}`, 'loopback', 'ollama'), code('INVALID_ENDPOINT'))
  assert.equal(validateEndpoint('http://localhost:11434', 'loopback', 'ollama'), 'http://localhost:11434')
  assert.throws(() => endpointRulesFromEnv('3001'), code('INVALID_ENDPOINT'))
  assert.throws(() => endpointRulesFromEnv('1,not-a-port'), code('INVALID_ENDPOINT'))
})

test('DNS resolution rejects private, metadata, transition IPv6 and mixed public/private answers before sending any credential', async () => {
  const blocked = ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '100.64.1.1', '169.254.169.254', '168.63.129.16', '198.18.0.1', '192.0.2.1', '224.0.0.1', '::1', '::ffff:8.8.8.8', 'fd00:ec2::254', 'fe80::1', '2001:db8::1', '2001:2::1', '2002:7f00:1::1']
  for (const address of blocked) {
    assert.equal(publicAddress(address), false, address)
    await assert.rejects(pinEndpoint(compatible.baseUrl, 'public', compatible.providerId, async () => [{ address, family: address.includes(':') ? 6 : 4 }]), code('BLOCKED_ENDPOINT'))
  }
  await assert.rejects(pinEndpoint(compatible.baseUrl, 'public', compatible.providerId, async () => [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }]), code('BLOCKED_ENDPOINT'))
  assert.equal(publicAddress('2606:4700:4700::1111'), true)
})

test('temporary DNS failure is retried before a provider request', async () => {
  let attempts = 0
  const endpoint = await pinEndpoint(openrouter.baseUrl, 'public', 'openrouter', async () => {
    attempts++
    if (attempts === 1) throw new Error('temporary lookup failure')
    return [{ address: '8.8.8.8', family: 4 }]
  })
  assert.equal(attempts, 2)
  assert.equal(endpoint.address, '8.8.8.8')
})

test('provider-specific tests are explicit, credential-safe, persisted and never claim model inference', async t => {
  const path = await directory(t)
  let calls = 0, pathSeen = ''
  const manager = new ConnectionManager(path, { resolver: publicResolver, transport: async (_endpoint, path, secret) => { calls++; pathSeen = path; assert.equal(secret, key); return { status: 200, body: { data: { is_free_tier: true, label: key } } } } })
  t.after(async () => manager.close())
  const connection = manager.add(openrouter, key)
  assert.equal(calls, 0)
  const result = await manager.test(connection.id, connection.revision)
  assert.equal(calls, 1); assert.equal(pathSeen, '/key'); assert.equal(result.ok, true)
  assert.equal(result.connection.enabled, false)
  assert.equal(result.connection.health.authentication, 'accepted')
  assert.equal(result.connection.health.discovery, 'never-tested')
  assert.equal(result.connection.health.inference, 'never-tested')
  assert.ok(!JSON.stringify(result).includes(key)); assert.ok(!JSON.stringify(manager.audit()).includes(key))
})

test('request failures, unauthorized responses, malformed bodies and redirects produce sanitized, truthful results', async t => {
  const path = await directory(t)
  let mode = 0
  const manager = new ConnectionManager(path, { resolver: publicResolver, transport: async () => {
    if (mode === 0) throw new Error(`private failure: ${key}`)
    if (mode === 1) return { status: 401, body: { secret: key } }
    if (mode === 2) return { status: 302, body: { location: `https://evil.example/${key}` } }
    return { status: 200, body: {} }
  } })
  t.after(async () => manager.close())
  const c = manager.add(openrouter, key)
  for (const expected of ['REQUEST_FAILED', 'AUTH_REJECTED', 'REDIRECT_BLOCKED', 'INVALID_RESPONSE']) {
    const result = await manager.test(c.id, c.revision)
    assert.equal(result.ok, false); assert.equal(result.code, expected)
    assert.ok(!JSON.stringify(result).includes(key)); assert.ok(!JSON.stringify(manager.audit()).includes(key)); mode++
  }
})

test('blocked DNS never reaches transport; endpoint/credential edits during a test cannot accept stale success', async t => {
  const path = await directory(t)
  let calls = 0
  const blocked = new ConnectionManager(path, { resolver: async () => [{ address: '127.0.0.1', family: 4 }], transport: async () => { calls++; return { status: 200, body: {} } } })
  const c = blocked.add(openrouter, key)
  assert.equal((await blocked.test(c.id, c.revision)).code, 'BLOCKED_ENDPOINT'); assert.equal(calls, 0); blocked.close()
  let complete!: () => void
  const manager = new ConnectionManager(path, { resolver: publicResolver, transport: async () => { await new Promise<void>(resolve => { complete = resolve }); return { status: 200, body: { data: { is_free_tier: true } } } } })
  t.after(async () => manager.close())
  const pending = manager.test(c.id, c.revision)
  while (!complete) await new Promise(resolve => setTimeout(resolve, 1))
  await assert.rejects(manager.test(c.id, c.revision), code('TEST_BUSY'))
  const edited = manager.setCredential(c.id, c.revision, 'replacement-test-only')
  complete(); await assert.rejects(pending, code('CONFLICT'))
  assert.equal(manager.get(c.id).revision, edited.revision); assert.equal(manager.get(c.id).health.authentication, 'unknown')
})

test('real pinned HTTP probe supports local Ollama and compatible endpoints, refuses redirects and bounds responses', async t => {
  const path = await directory(t)
  let redirectHits = 0, mode = 0, authorization: string | undefined
  const server = createServer((req, res) => {
    authorization = req.headers.authorization
    if (req.url === '/redirect-target') { redirectHits++; res.end('{}'); return }
    if (mode === 1) { res.writeHead(302, { Location: '/redirect-target' }); res.end(); return }
    if (mode === 2) { res.end('not-json'); return }
    if (mode === 3) { res.end('x'.repeat(1_000_001)); return }
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(req.url === '/api/tags' ? { models: [{ name: 'fixture' }] } : { data: [{ id: 'fixture' }] }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const address = server.address(); assert.ok(address && typeof address === 'object')
  const rules = { localPorts: [address.port] }, base = `http://127.0.0.1:${address.port}`
  const manager = new ConnectionManager(path, { rules })
  t.after(async () => manager.close())
  const local = manager.add({ providerId: 'ollama', label: 'local', baseUrl: base, networkPolicy: 'loopback' })
  assert.equal((await manager.test(local.id, local.revision)).ok, true)
  const generic = manager.add({ ...compatible, baseUrl: base + '/v1', networkPolicy: 'loopback' }, key)
  assert.equal((await manager.test(generic.id, generic.revision)).ok, true); assert.equal(authorization, `Bearer ${key}`)
  mode = 1; assert.equal((await manager.test(local.id, local.revision)).code, 'REDIRECT_BLOCKED'); assert.equal(redirectHits, 0)
  mode = 2; assert.equal((await manager.test(local.id, local.revision)).code, 'INVALID_RESPONSE')
  mode = 3; assert.equal((await manager.test(local.id, local.revision)).code, 'RESPONSE_LIMIT')
  const pinned = await pinEndpoint(base, 'loopback', 'ollama', undefined, rules)
  assert.equal(pinned.address, '127.0.0.1')
  assert.equal(typeof requestPinnedJson, 'function')
})

test('CLI supports persistent management using stdin only, with no key in stdout/stderr or process arguments', async t => {
  const path = await directory(t), cli = new URL('../server/ai/provider-cli.ts', import.meta.url).pathname
  const run = (args: string[], input?: unknown) => spawnSync(process.execPath, [cli, ...args], { env: { ...process.env, AI_PROVIDER_DATA_DIR: path }, encoding: 'utf8', input: input === undefined ? undefined : JSON.stringify(input) })
  const added = run(['add'], { connection: openrouter, apiKey: key })
  assert.equal(added.status, 0, added.stderr); assert.ok(!added.stdout.includes(key)); assert.ok(!added.stderr.includes(key))
  const c = JSON.parse(added.stdout)
  const listed = run(['list']); assert.equal(JSON.parse(listed.stdout).length, 1)
  const enabled = run(['enable', c.id, '1']); assert.equal(JSON.parse(enabled.stdout).enabled, true)
  const credential = run(['credential', c.id, '2'], { apiKey: 'replacement-test-only' }); assert.equal(credential.status, 0)
  assert.equal(run(['disable', c.id, '3']).status, 0)
  assert.equal(run(['remove', c.id, '4']).status, 0)
  assert.equal(JSON.parse(run(['list']).stdout).length, 0)
  const invalid = run(['add', key]); assert.equal(invalid.status, 1); assert.ok(!invalid.stderr.includes(key))
})


test('metadata edits preserve credential decryption, and replacement survives a restart', async t => {
  const path = await directory(t)
  let manager = new ConnectionManager(path)
  let c = manager.add(openrouter, key)
  c = manager.edit(c.id, c.revision, { label: 'new label' })
  c = manager.setCredential(c.id, c.revision, 'rotated-fixture-key')
  manager.close()
  manager = new ConnectionManager(path, { resolver: publicResolver, transport: async (_endpoint, _path, secret) => { assert.equal(secret, 'rotated-fixture-key'); return { status: 200, body: { data: { is_free_tier: true } } } } })
  t.after(async () => manager.close())
  assert.equal((await manager.test(c.id, c.revision)).ok, true)
})

test('failed SQLite writes roll back metadata, ciphertext and audit together without exposing errors', async t => {
  const path = await directory(t), manager = new ConnectionManager(path)
  t.after(async () => manager.close())
  const c = manager.add(openrouter, key)
  const db = new DatabaseSync(join(path, 'providers.sqlite'))
  db.exec("CREATE TRIGGER reject_change BEFORE UPDATE ON connections BEGIN SELECT RAISE(ABORT, 'private database failure'); END")
  db.close()
  assert.throws(() => manager.setCredential(c.id, c.revision, 'replacement-fixture'), error => error instanceof ManagementError && error.code === 'STORE_FAILED' && !error.message.includes('private database'))
  assert.deepEqual(manager.get(c.id), c)
  assert.equal(manager.audit().length, 1)
})

test('DNS answers are pinned once per request and revalidated on the next explicit test', async t => {
  const path = await directory(t)
  let requests = 0, resolutions = 0
  const server = createServer((_req, res) => { requests++; res.end(JSON.stringify({ models: [] })) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const address = server.address(); assert.ok(address && typeof address === 'object')
  const manager = new ConnectionManager(path, { rules: { localPorts: [address.port] }, resolver: async () => { resolutions++; return [{ address: resolutions === 1 ? '127.0.0.1' : '169.254.169.254', family: 4 }] } })
  t.after(async () => manager.close())
  const c = manager.add({ providerId: 'ollama', label: 'local DNS', baseUrl: 'http://localhost:' + address.port, networkPolicy: 'loopback' })
  assert.equal((await manager.test(c.id, c.revision)).ok, true)
  assert.equal(resolutions, 1); assert.equal(requests, 1)
  assert.equal((await manager.test(c.id, c.revision)).code, 'BLOCKED_ENDPOINT')
  assert.equal(resolutions, 2); assert.equal(requests, 1)
})

test('backend data directory cannot be placed in frontend source, public files or the project root', () => {
  for (const relativePath of ['public/provider-data', 'src/provider-data', '../../provider-data']) {
    const path = new URL(relativePath, new URL('../', import.meta.url)).pathname
    assert.throws(() => new ConnectionManager(path), code('STORE_FAILED'))
  }
})


test('missing required credentials do not cause HTTP requests; unknown generic authentication is not advertised as verified', async t => {
  const path = await directory(t)
  let calls = 0
  const manager = new ConnectionManager(path, { resolver: publicResolver, transport: async () => { calls++; return { status: 200, body: { data: [] } } } })
  t.after(async () => manager.close())
  const missing = manager.add(openrouter)
  assert.equal((await manager.test(missing.id, missing.revision)).code, 'CREDENTIAL_REQUIRED'); assert.equal(calls, 0)
  let generic = manager.add(compatible)
  generic = manager.setCredential(generic.id, generic.revision, key)
  generic = manager.setCredential(generic.id, generic.revision, null)
  assert.equal(generic.credentials.state, 'missing')
  const result = await manager.test(generic.id, generic.revision)
  assert.equal(result.ok, true); assert.equal(result.connection.health.authentication, 'unknown'); assert.equal(result.connection.health.inference, 'never-tested')
})


test('unknown error codes are never echoed or eligible for secret-bearing audit records', () => {
  const error = new ManagementError(key)
  assert.equal(error.code, 'PROBE_FAILED')
  assert.ok(!error.message.includes(key)); assert.ok(!JSON.stringify(error).includes(key))
})
