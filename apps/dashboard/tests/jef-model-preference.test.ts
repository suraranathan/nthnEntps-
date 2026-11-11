import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compareJefCandidates } from '../server/agent/model-preference.ts'
import type { CatalogEntry } from '../server/ai/contracts.ts'

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
