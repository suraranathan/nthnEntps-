import type { ModelRouteRef } from './contracts.ts'

/** Lossless tuple encoding prevents delimiter, case, account and upstream collisions. */
export function modelRouteKey(ref: ModelRouteRef): string {
  if (!ref || typeof ref !== 'object') throw new TypeError('Expected a model route reference')
  for (const value of [ref.connectionId, ref.nativeModelId]) {
    if (typeof value !== 'string' || !value.trim()) throw new TypeError('Route connection and native model IDs must be non-empty strings')
  }
  if (ref.upstreamEndpointId !== null && (typeof ref.upstreamEndpointId !== 'string' || !ref.upstreamEndpointId.trim())) throw new TypeError('Upstream endpoint ID must be null or a non-empty string')
  return `route:v1:${JSON.stringify([ref.connectionId, ref.nativeModelId, ref.upstreamEndpointId])}`
}
