import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HttpProvider, ModelRouter } from '../server/providers.ts'
import { AI_CONTRACT_VERSION } from '../server/ai/contracts.ts'
import type { LegacyProviderBinding, ProviderConnection, ServerConnection } from '../server/ai/contracts.ts'
import { modelRouteKey } from '../server/ai/route-identity.ts'

const ref = (connectionId: string, nativeModelId = 'vendor/model', upstreamEndpointId: string | null = null) => ({ connectionId, nativeModelId, upstreamEndpointId })

test('same model retains distinct access routes across accounts and gateways', () => {
  const keys = ['direct-account-a', 'direct-account-b', 'openrouter', 'local-ollama'].map(id => modelRouteKey(ref(id)))
  assert.equal(new Set(keys).size, 4)
  assert.equal(modelRouteKey(ref('openrouter')), modelRouteKey(ref('openrouter')))
})

test('route identity is lossless for delimiters, case and native model variants', () => {
  const routes = [ref('a/b', 'c'), ref('a', 'b/c'), ref('a', 'Model'), ref('a', 'model'), ref('a', 'model:latest'), ref('a', 'model:quantized'), ref('a', 'model /_日本語'), ref('a', ' model ')]
  assert.equal(new Set(routes.map(modelRouteKey)).size, routes.length)
})

test('automatic gateway routing and each explicit upstream remain independent', () => {
  const routes = [ref('gateway'), ref('gateway', 'vendor/model', 'upstream-a'), ref('gateway', 'vendor/model', 'upstream-b')]
  assert.equal(new Set(routes.map(modelRouteKey)).size, 3)
})

test('malformed route identities fail without accepting missing upstream semantics', () => {
  for (const input of [ref(''), ref('a', ' '), ref('a', 'b', ''), { connectionId: 'a', nativeModelId: 'b' }, null]) {
    assert.throws(() => modelRouteKey(input as Parameters<typeof modelRouteKey>[0]), TypeError)
  }
})

test('route identity imposes no total-model ceiling or maximum native-ID length', () => {
  const keys = Array.from({ length: 2500 }, (_, i) => modelRouteKey(ref('one-account', `native-${i}`)))
  assert.equal(new Set(keys).size, 2500)
  assert.notEqual(modelRouteKey(ref('one-account', 'x'.repeat(4096))), modelRouteKey(ref('one-account', 'x'.repeat(4097))))
})

test('compatibility contract accepts existing HttpProvider and ModelRouter unchanged', () => {
  let networkCalls = 0
  const transport: typeof fetch = async () => { networkCalls++; throw new Error('Contracts must not perform network requests') }
  const provider = new HttpProvider('legacy-id', 'native-model', 'http://127.0.0.1:11434', '', 'ollama', transport)
  const router = new ModelRouter([provider], 'legacy-id')
  const binding = { provider, router, route: ref('new-connection-id', 'native-model') } satisfies LegacyProviderBinding
  assert.equal(binding.router.current(), binding.provider)
  assert.equal(binding.provider.info.id, 'legacy-id')
  assert.equal(binding.provider.info.model, binding.route.nativeModelId)
  assert.equal(networkCalls, 0)
  assert.equal(AI_CONTRACT_VERSION, 1)
})

test('safe connection metadata and server-only credential reference are separate contracts', () => {
  const connection = {
    id: 'connection-a', providerId: 'provider-a', label: 'Account A', baseUrl: 'https://provider.example/v1',
    scope: { account: null, project: null, region: null }, enabled: false, revision: 1,
    credentials: { state: 'missing', revision: 0 },
    health: { authentication: 'unknown', discovery: 'never-tested', inference: 'never-tested', checkedAt: null },
  } satisfies ProviderConnection
  const server = { connection, credentialRef: 'opaque-secret-store-reference' } satisfies ServerConnection
  assert.equal(server.connection, connection)
  assert.ok(!JSON.stringify(connection).includes(server.credentialRef))
  // Compile-time guard: safe metadata must not acquire plaintext credential fields.
  const rejected: ProviderConnection = {
    ...connection,
    // @ts-expect-error API keys are deliberately outside ProviderConnection.
    apiKey: 'test-only-not-a-real-key',
  }
  void rejected
})
