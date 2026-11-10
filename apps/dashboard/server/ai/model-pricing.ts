import type { ModelDescriptor, Pricing, PriceComponent } from './contracts.ts'

const dimensions = ['prompt', 'completion', 'request', 'image', 'audio', 'input_cache_read', 'input_cache_write'] as const
const decimal = (value: unknown): string | null => {
  const text = typeof value === 'string' ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : ''
  return /^(?:0|[1-9]\d*)(?:\.\d+)?(?:e-?\d+)?$/i.test(text) ? text : null
}

/** Provider-listed prices are observations, never proof that an account has access. */
export function catalogPricing(model: ModelDescriptor, providerId: string): Pricing {
  // Other vendors may use different currency and units for similarly named fields.
  const raw = providerId === 'openrouter' ? model.extensions.pricing : undefined
  const values: Readonly<Record<string, unknown>> = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Readonly<Record<string, unknown>> : {}
  const components: PriceComponent[] = []
  for (const name of dimensions) {
    const amount = decimal(values[name])
    if (amount !== null) components.push({ dimension: name, amount, currency: 'USD', unit: name === 'request' ? 'request' : 'token', per: '1' })
  }
  const primary = ['prompt', 'completion'].every(name => components.some(item => item.dimension === name))
  const positive = components.some(item => Number(item.amount) > 0)
  const zero = primary && components.every(item => !/[1-9]/.test(item.amount.replace(/e.*/i, '')))
  const kind: Pricing['freeAccess']['kind'] = positive ? 'paid' : zero ? 'verified-zero-price' : 'unknown'
  return {
    components,
    completeness: primary ? 'complete' : components.length ? 'partial' : 'unknown',
    evidence: components.length ? model.evidence : null,
    freeAccess: { kind, eligibility: 'unknown', conditions: [], evidence: kind === 'unknown' ? null : model.evidence },
  }
}
