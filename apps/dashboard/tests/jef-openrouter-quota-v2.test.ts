import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openRouterAllowanceSnapshot } from '../server/ai/openrouter-quota.ts'

test('labels observed OpenRouter allowance as credit without estimating time or free requests', () => {
  assert.deepEqual(openRouterAllowanceSnapshot({ limit: 10, remaining: 6.5 }), {
    limit: 10, remaining: 6.5, unit: 'credit', estimatedTimeRemaining: null,
  })
  assert.equal(openRouterAllowanceSnapshot(null), null)
  assert.equal(openRouterAllowanceSnapshot({ limit: 0, remaining: 0 }), null)
})
