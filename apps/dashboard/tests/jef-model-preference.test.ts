import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compareJefCandidates, isFreeJefCandidate, jefModelPermitted, normalizeJefPreference } from '../server/agent/model-preference.ts'
import type { CatalogEntry } from '../server/ai/contracts.ts'
import { normalizeCommunicationMode } from '../server/agent/communication-mode.ts'

function entry(name: string, price: string | null): CatalogEntry {
  return { route: { model: { displayName: name }, ref: { nativeModelId: name } }, pricing: { freeAccess: { kind: price === '0' ? 'verified-zero-price' : 'paid' }, components: price === null ? [] : [{ dimension: 'input', amount: price, currency: 'USD', per: '1000000' }] } } as unknown as CatalogEntry
}

test('lower listed price ranks cheaper known-price models first', () => {
  const costly = entry('Great Coder', '5')
  const cheap = entry('General Model', '0.2')
  const unknown = entry('Unknown Model', null)
  assert.ok(compareJefCandidates(cheap, costly, 'low-cost') < 0)
  assert.ok(compareJefCandidates(costly, unknown, 'low-cost') < 0)
  assert.ok(compareJefCandidates(costly, cheap, 'automatic') < 0)
})

test('free-only selection rejects paid and unknown prices while accepting listed zero price', () => {
  assert.equal(isFreeJefCandidate(entry('Free Coder', '0')), true)
  assert.equal(isFreeJefCandidate(entry('Paid Coder', '0.001')), false)
  assert.equal(isFreeJefCandidate(entry('Unknown Coder', null)), false)
  assert.equal(jefModelPermitted(entry('Paid Coder', '0.001'), 'free-only'), false)
  assert.equal(jefModelPermitted(entry('Paid Coder', '0.001'), 'manual-free'), false)
  assert.equal(jefModelPermitted(entry('Free Coder', '0'), 'free-only'), true)
  assert.equal(jefModelPermitted(entry('Paid Coder', '0.001'), 'automatic'), true)
})

test('V2 migrates legacy model preferences to automatic free and supports manual free', () => {
  assert.equal(normalizeJefPreference('manual-free'), 'manual-free')
  assert.equal(normalizeJefPreference('free-only'), 'automatic-free')
  assert.equal(normalizeJefPreference('low-cost'), 'automatic-free')
  assert.equal(normalizeJefPreference('automatic'), 'automatic-free')
  assert.equal(normalizeJefPreference(undefined), 'automatic-free')
})

test('uncensored creator-direct communication is an explicit mode and standard remains default', () => {
  assert.equal(normalizeCommunicationMode('creator-direct'), 'creator-direct')
  assert.equal(normalizeCommunicationMode('standard'), 'standard')
  assert.equal(normalizeCommunicationMode('uncensored'), 'standard')
  assert.equal(normalizeCommunicationMode(undefined), 'standard')
})
