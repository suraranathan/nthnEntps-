import type { CatalogEntry } from '../server/ai/contracts.ts'

export const capabilityLabels = { text: 'Text', streaming: 'Streaming', tools: 'Tools', structuredOutput: 'Structured output', systemInstructions: 'System instructions' }
export function verificationLabel(entry: CatalogEntry, now = Date.now()): string {
  const v = entry.verification
  if (!v) return 'Untested'
  if (v.connectionRevision !== entry.route.connectionRevision || entry.route.access.state === 'unavailable' || entry.route.lifecycle === 'removed') return 'Unavailable / historical evidence'
  if (v.state === 'verified' && (now - Date.parse(v.checkedAt) > 86400000 || Date.parse(v.checkedAt) > now || !Number.isFinite(Date.parse(v.checkedAt)))) return 'Verification expired'
  return v.state === 'verified' && entry.route.access.state === 'verified' ? 'Verified' : v.state === 'verified' ? 'Historical verification' : v.state
}
const reasons: Record<string, string> = {
  OK: 'Compatible', MODEL_UNAVAILABLE: 'The route is removed or the provider could not serve a requested inference capability. Inspect verification details.', NOT_FOUND: 'Route no longer exists',
  CONNECTION_DISABLED: 'Enable this connection before verifying or assigning models.',
  CATALOG_STALE: 'Connection configuration changed; refresh discovery before verifying.',
  CATALOG_REFRESH_FAILED: 'Latest discovery failed; resolve the catalog error and refresh.',
  UNVERIFIED: 'Not verified for this connection revision. Verify the required capabilities before assignment.', VERIFICATION_EXPIRED: 'Verification expired; verify again',
  INVALID_RESPONSE: 'Inference response did not pass the verification probe; inspect the failed capability.',
  INCOMPATIBLE: 'The inference request or protocol was rejected as incompatible.',
  CREDENTIAL_REQUIRED: 'Configure a credential before verifying inference.',
  AUTH_REJECTED: 'Provider rejected inference authentication or access.',
  INSUFFICIENT_CREDITS: 'Provider credits or quota are insufficient for inference.',
  RATE_LIMITED: 'Provider rate limit reached during verification; try again later.',
  REQUEST_FAILED: 'Inference request failed or timed out; verification is required.',
  CAPABILITY_UNTESTED_OR_UNSUPPORTED: 'Required capabilities are untested or unsupported',
}
export const eligibilityReason = (code: string) => reasons[code] ?? code
export const displayTime = (value: string | null | undefined) => value ? new Date(value).toLocaleString() : 'Never'
