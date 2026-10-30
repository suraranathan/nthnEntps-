import type { ProviderDefinition, ProviderConnection } from './contracts.ts'
import type { ProbeResponse } from './endpoint-policy.ts'
import type { NetworkPolicy } from './management-types.ts'
import { ManagementError, objectInput } from './management-types.ts'

export interface ConnectionAdapter {
  definition: ProviderDefinition
  requiresCredential: boolean
  credentiallessState: 'missing' | 'not-required'
  probeKind: 'authentication' | 'discovery'
  validateBase(url: URL, network: NetworkPolicy): void
  probePath: string
  interpret(response: ProbeResponse): Pick<ProviderConnection['health'], 'authentication' | 'discovery'>
}
function success(response: ProbeResponse) {
  if (response.status === 401 || response.status === 403) throw new ManagementError('AUTH_REJECTED')
  if (response.status === 429) throw new ManagementError('RATE_LIMITED')
  if (response.status >= 300 && response.status < 400) throw new ManagementError('REDIRECT_BLOCKED')
  if (response.status < 200 || response.status >= 300) throw new ManagementError('PROBE_FAILED')
  try { return objectInput(response.body) } catch { throw new ManagementError('INVALID_RESPONSE') }
}
const adapters: readonly ConnectionAdapter[] = [
  {
    definition: { id: 'openrouter', name: 'OpenRouter', adapterId: 'openrouter', discovery: 'supported', accountMetadata: 'supported' },
    requiresCredential: true, credentiallessState: 'missing', probeKind: 'authentication', probePath: '/key',
    validateBase(url, network) {
      if (network !== 'public' || url.origin !== 'https://openrouter.ai' || url.pathname.replace(/\/$/, '') !== '/api/v1') throw new ManagementError('INVALID_ENDPOINT')
    },
    interpret(response) {
      const body = success(response)
      if (!body.data || typeof body.data !== 'object' || typeof (body.data as Record<string, unknown>).is_free_tier !== 'boolean') throw new ManagementError('INVALID_RESPONSE')
      return { authentication: 'accepted', discovery: 'never-tested' }
    },
  },
  {
    definition: { id: 'openai-compatible', name: 'OpenAI-compatible endpoint', adapterId: 'openai-compatible', discovery: 'unknown', accountMetadata: 'unknown' },
    requiresCredential: false, credentiallessState: 'missing', probeKind: 'discovery', probePath: '/models',
    validateBase() {},
    interpret(response) {
      const body = success(response)
      if (!Array.isArray(body.data) || !body.data.every(x => x && typeof x.id === 'string')) throw new ManagementError('INVALID_RESPONSE')
      // A publicly readable models endpoint does not establish authentication/inference.
      return { authentication: 'unknown', discovery: 'succeeded' }
    },
  },
  {
    definition: { id: 'ollama', name: 'Ollama', adapterId: 'ollama', discovery: 'supported', accountMetadata: 'unsupported' },
    requiresCredential: false, credentiallessState: 'not-required', probeKind: 'discovery', probePath: '/api/tags',
    validateBase(url) { if (url.pathname !== '/') throw new ManagementError('INVALID_ENDPOINT') },
    interpret(response) {
      const body = success(response)
      if (!Array.isArray(body.models) || !body.models.every(x => x && typeof x.name === 'string')) throw new ManagementError('INVALID_RESPONSE')
      return { authentication: 'unknown', discovery: 'succeeded' }
    },
  },
]
export function connectionAdapter(id: unknown): ConnectionAdapter {
  const adapter = adapters.find(item => item.definition.id === id)
  if (!adapter) throw new ManagementError('INVALID_INPUT')
  return adapter
}
export const availableProviders = () => adapters.map(adapter => ({ ...adapter.definition }))
