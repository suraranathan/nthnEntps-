import type { CatalogEntry } from '../ai/contracts.ts'

export type JefModelPreference = 'automatic' | 'low-cost'

function codingRank(entry: CatalogEntry): number {
  const name = `${entry.route.model.displayName} ${entry.route.ref.nativeModelId}`.toLowerCase()
  if (/\b(code|coder|coding|devstral)\b/.test(name)) return 0
  if (/\b(reason|thinking|opus|sonnet|gpt|gemini|deepseek|qwen)\b/.test(name)) return 1
  return 2
}

function listedPrice(entry: CatalogEntry): number {
  const free = entry.pricing.freeAccess.kind
  if (free === 'verified-zero-price' || free === 'local-no-api-fee') return 0
  const components = entry.pricing.components.filter(component =>
    ['input', 'output'].includes(component.dimension) && component.currency === 'USD')
  if (!components.length) return Infinity
  let total = 0
  for (const component of components) {
    const amount = Number(component.amount)
    const per = Number(component.per)
    if (!Number.isFinite(amount) || !Number.isFinite(per) || per <= 0) return Infinity
    total += amount / per
  }
  return total
}

export function compareJefCandidates(a: CatalogEntry, b: CatalogEntry, preference: JefModelPreference): number {
  if (preference === 'low-cost') {
    const price = listedPrice(a) - listedPrice(b)
    if (!Number.isNaN(price) && price !== 0) return price
    if (Number.isFinite(listedPrice(a)) !== Number.isFinite(listedPrice(b))) return Number.isFinite(listedPrice(a)) ? -1 : 1
  }
  return codingRank(a) - codingRank(b) || a.route.ref.nativeModelId.localeCompare(b.route.ref.nativeModelId)
}
