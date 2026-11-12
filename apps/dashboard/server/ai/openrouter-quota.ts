export interface OpenRouterKeyQuota {
  limit: number
  remaining: number
  unit: 'credit'
  estimatedTimeRemaining: null
}

/** Adds display semantics to values already fetched inside ConnectionManager's vault boundary. */
export function openRouterAllowanceSnapshot(value: { limit: number; remaining: number } | null): OpenRouterKeyQuota | null {
  if (!value || !Number.isFinite(value.limit) || !Number.isFinite(value.remaining) || value.limit <= 0 || value.remaining < 0) return null
  return { limit: value.limit, remaining: value.remaining, unit: 'credit', estimatedTimeRemaining: null }
}
