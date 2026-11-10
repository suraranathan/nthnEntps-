import { test } from 'node:test'
import assert from 'node:assert/strict'
import { providerKeyHint } from '../server/ai/provider-key-hints.ts'

test('provider hints recognize only distinctive key prefixes', () => {
  assert.equal(providerKeyHint('sk-or-v1-example'), 'openrouter')
  assert.equal(providerKeyHint('sk-ant-api03-example'), 'anthropic')
  assert.equal(providerKeyHint('AIzaExample'), 'gemini')
  assert.equal(providerKeyHint('sk-proj-example'), 'openai')
  assert.equal(providerKeyHint('gsk_example'), 'groq')
  assert.equal(providerKeyHint('sk-example'), null)
  assert.equal(providerKeyHint('unrecognized-key'), null)
})
