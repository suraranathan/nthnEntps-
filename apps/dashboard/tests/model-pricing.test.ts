import { test } from 'node:test'
import assert from 'node:assert/strict'
import { catalogPricing } from '../server/ai/model-pricing.ts'
import type { ModelDescriptor } from '../server/ai/contracts.ts'

const model = (pricing: unknown) => ({ nativeModelId: 'm', evidence: { source: 'provider-api', observedAt: '2026-01-01T00:00:00Z', reference: null }, extensions: { pricing } }) as unknown as ModelDescriptor

test('catalog pricing distinguishes listed zero prices, paid prices and unknown prices', () => {
  assert.equal(catalogPricing(model({ prompt: '0', completion: '0' }), 'openrouter').freeAccess.kind, 'verified-zero-price')
  assert.equal(catalogPricing(model({ prompt: '0.000001', completion: '0' }), 'openrouter').freeAccess.kind, 'paid')
  assert.equal(catalogPricing(model({ prompt: '0' }), 'openrouter').freeAccess.kind, 'unknown')
  assert.equal(catalogPricing(model({ prompt: 'not-a-price', completion: '0' }), 'openrouter').freeAccess.kind, 'unknown')
  assert.equal(catalogPricing(model({ prompt: '0', completion: '0' }), 'openai-compatible').freeAccess.kind, 'unknown')
})
