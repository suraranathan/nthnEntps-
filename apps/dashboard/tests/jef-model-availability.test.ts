import { test } from 'node:test'
import assert from 'node:assert/strict'
import { jefAvailability } from '../server/ai/jef-model-availability.ts'
import type { CatalogEntry } from '../server/ai/contracts.ts'
import type { Verification } from '../server/ai/verification-store.ts'

test('availability distinguishes a listing from current verified Jef access', () => {
  const route = { id: 'r', connectionRevision: 3 } as CatalogEntry['route']
  const entry = { route } as CatalogEntry
  assert.equal(jefAvailability(entry, null, 100000), 'listed, untested')
  const supported = { state: 'supported' as const, checkedAt: '1970-01-01T00:00:50.000Z', code: null }
  const verified = { routeId: 'r', connectionRevision: 3, checkedAt: '1970-01-01T00:00:50.000Z', state: 'verified', capabilities: { text: supported, tools: supported, streaming: supported, systemInstructions: supported } } as Verification
  assert.equal(jefAvailability(entry, verified, 100000), 'verified for Jef')
  assert.equal(jefAvailability(entry, { ...verified, connectionRevision: 2 }, 100000), 'listed, untested')
  assert.equal(jefAvailability(entry, { ...verified, checkedAt: '1970-01-01T00:00:50.000Z' }, 100000000), 'listed, untested')
  assert.equal(jefAvailability(entry, { ...verified, state: 'incompatible' }, 100000), 'failed verification')
})
