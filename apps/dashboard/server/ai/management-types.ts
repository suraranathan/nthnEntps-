import type { ProviderConnection } from './contracts.ts'

export type NetworkPolicy = 'public' | 'loopback'
export type ManagedConnection = ProviderConnection & { networkPolicy: NetworkPolicy }
export interface ConnectionInput {
  providerId: string
  label: string
  baseUrl: string
  networkPolicy?: NetworkPolicy
  enabled?: boolean
  scope?: ProviderConnection['scope']
}
export type ConnectionPatch = Partial<Omit<ConnectionInput, 'providerId'>>
export type TestResult = { connection: ManagedConnection; ok: boolean; code: string }
const messages: Record<string, string> = {
  INVALID_INPUT: 'Invalid connection input.', INVALID_ENDPOINT: 'Endpoint does not match the provider or network policy.',
  BLOCKED_ENDPOINT: 'Endpoint resolves to a prohibited network address.', DNS_FAILED: 'Endpoint resolution failed.',
  NOT_FOUND: 'Connection not found.', CONFLICT: 'Connection changed; reload its current revision.',
  CREDENTIAL_REQUIRED: 'This provider requires a credential.', INVALID_CREDENTIAL: 'Invalid credential format.',
  AUTH_REJECTED: 'Provider rejected credentials or access.', RATE_LIMITED: 'Provider rate limit reached.',
  REDIRECT_BLOCKED: 'Provider redirect rejected.', PROBE_FAILED: 'Provider connection test failed.',
  INVALID_RESPONSE: 'Provider response could not be validated.', RESPONSE_LIMIT: 'Provider response exceeded the test limit.',
  REQUEST_FAILED: 'Provider request failed or timed out.', STORE_FAILED: 'Provider storage operation failed.',
  KEY_UNAVAILABLE: 'Provider master key is missing, unsafe or invalid. Restore it from a private backup.',
  DECRYPT_FAILED: 'Credential integrity or master-key verification failed.', TEST_BUSY: 'A connection test is already running.',
}
export class ManagementError extends Error {
  readonly code: string
  constructor(code: string) { const safeCode = Object.hasOwn(messages, code) ? code : 'PROBE_FAILED'; super(messages[safeCode]); this.code = safeCode }
}
export function objectInput(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ManagementError('INVALID_INPUT')
  return value as Record<string, unknown>
}
export function exactFields(input: Record<string, unknown>, fields: readonly string[]) {
  if (Object.keys(input).some(key => !fields.includes(key))) throw new ManagementError('INVALID_INPUT')
}
export function credentialInput(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || !value.length || value.length > 8192 || /[\s\x00-\x1f\x7f]/.test(value)) throw new ManagementError('INVALID_CREDENTIAL')
  return value
}
