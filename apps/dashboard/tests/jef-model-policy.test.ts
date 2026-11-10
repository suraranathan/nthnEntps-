import { test } from 'node:test'
import assert from 'node:assert/strict'
import { jefCanUse, jefProbeCapabilities, jefTransportSupportsTools } from '../server/ai/jef-model-policy.ts'
import type { Verification } from '../server/ai/verification-store.ts'

test('Jef accepts only a verified model with working tools and streaming', () => {
  const verified = { state: 'verified', capabilities: {
    text: { state: 'supported' }, tools: { state: 'supported' }, streaming: { state: 'supported' }, systemInstructions: { state: 'supported' },
  } } as Verification
  assert.deepEqual(jefProbeCapabilities, ['text', 'tools', 'streaming', 'systemInstructions'])
  assert.equal(jefCanUse(verified), true)
  assert.equal(jefCanUse({ ...verified, capabilities: { ...verified.capabilities, tools: { state: 'untested', checkedAt: null, code: null } } }), false)
  assert.equal(jefCanUse({ ...verified, capabilities: { ...verified.capabilities, streaming: { state: 'unsupported', checkedAt: null, code: null } } }), false)
  assert.equal(jefCanUse({ ...verified, state: 'unavailable' }), false)
  assert.equal(jefTransportSupportsTools('openai'), true)
  assert.equal(jefTransportSupportsTools('openrouter'), true)
  assert.equal(jefTransportSupportsTools('anthropic'), true)
  assert.equal(jefTransportSupportsTools('gemini'), true)
  assert.equal(jefTransportSupportsTools('ollama'), true)
})
