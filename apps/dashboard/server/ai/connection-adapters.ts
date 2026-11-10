import type { ProviderDefinition, ProviderConnection } from './contracts.ts'
import type { ProbeResponse } from './endpoint-policy.ts'
import type { NetworkPolicy } from './management-types.ts'
import { ManagementError, objectInput } from './management-types.ts'

export interface ConnectionAdapter {
  definition: ProviderDefinition
  requiresCredential: boolean
  credentiallessState: 'missing' | 'not-required'
  probeKind: 'authentication' | 'discovery'
  protocol: 'openai-chat' | 'ollama-chat' | 'anthropic-messages' | 'gemini-generate-content'
  authStyle: 'bearer' | 'anthropic' | 'gemini'
  validateBase(url: URL, network: NetworkPolicy): void
  discoveryPath: string
  probePath: string
  inferencePath(model: string, stream: boolean): string
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
    requiresCredential: true, credentiallessState: 'missing', probeKind: 'authentication', protocol: 'openai-chat', authStyle: 'bearer', probePath: '/key', discoveryPath: '/models/user', inferencePath: () => '/chat/completions',
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
    definition: { id: 'openai', name: 'OpenAI', adapterId: 'openai', discovery: 'supported', accountMetadata: 'unknown' },
    requiresCredential: true, credentiallessState: 'missing', probeKind: 'discovery', protocol: 'openai-chat', authStyle: 'bearer', probePath: '/models', discoveryPath: '/models', inferencePath: () => '/chat/completions',
    validateBase(url, network) { if (network !== 'public' || url.origin !== 'https://api.openai.com' || url.pathname.replace(/\/$/, '') !== '/v1') throw new ManagementError('INVALID_ENDPOINT') },
    interpret(response) { const body = success(response); if (!Array.isArray(body.data) || !body.data.every(x => x && typeof x.id === 'string')) throw new ManagementError('INVALID_RESPONSE'); return { authentication: 'accepted', discovery: 'succeeded' } },
  },
  {
    definition: { id: 'anthropic', name: 'Anthropic', adapterId: 'anthropic', discovery: 'supported', accountMetadata: 'unknown' },
    requiresCredential: true, credentiallessState: 'missing', probeKind: 'discovery', protocol: 'anthropic-messages', authStyle: 'anthropic', probePath: '/models', discoveryPath: '/models', inferencePath: () => '/messages',
    validateBase(url, network) { if (network !== 'public' || url.origin !== 'https://api.anthropic.com' || url.pathname.replace(/\/$/, '') !== '/v1') throw new ManagementError('INVALID_ENDPOINT') },
    interpret(response) { const body = success(response); if (!Array.isArray(body.data) || !body.data.every(x => x && typeof x.id === 'string')) throw new ManagementError('INVALID_RESPONSE'); return { authentication: 'accepted', discovery: 'succeeded' } },
  },
  {
    definition: { id: 'gemini', name: 'Google Gemini', adapterId: 'gemini', discovery: 'supported', accountMetadata: 'unknown' },
    requiresCredential: true, credentiallessState: 'missing', probeKind: 'discovery', protocol: 'gemini-generate-content', authStyle: 'gemini', probePath: '/models', discoveryPath: '/models', inferencePath: (model, stream) => `/models/${encodeURIComponent(model.replace(/^models\//, ''))}:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`,
    validateBase(url, network) { if (network !== 'public' || url.origin !== 'https://generativelanguage.googleapis.com' || url.pathname.replace(/\/$/, '') !== '/v1beta') throw new ManagementError('INVALID_ENDPOINT') },
    interpret(response) { const body = success(response); if (!Array.isArray(body.models) || !body.models.every(x => x && typeof x.name === 'string')) throw new ManagementError('INVALID_RESPONSE'); return { authentication: 'accepted', discovery: 'succeeded' } },
  },
  {
    definition: { id: 'xkiro', name: 'xKiro', adapterId: 'xkiro', discovery: 'supported', accountMetadata: 'unknown' },
    requiresCredential: true, credentiallessState: 'missing', probeKind: 'discovery', protocol: 'openai-chat', authStyle: 'bearer', probePath: '/models', discoveryPath: '/models', inferencePath: () => '/chat/completions',
    validateBase(url, network) { if (network !== 'public' || url.origin !== 'https://api.xkiro.com' || url.pathname.replace(/\/$/, '') !== '/v1') throw new ManagementError('INVALID_ENDPOINT') },
    interpret(response) { const body = success(response); if (!Array.isArray(body.data) || !body.data.every(x => x && typeof x.id === 'string')) throw new ManagementError('INVALID_RESPONSE'); return { authentication: 'unknown', discovery: 'succeeded' } },
  },
  {
    definition: { id: 'groq', name: 'Groq', adapterId: 'groq', discovery: 'supported', accountMetadata: 'unknown' },
    requiresCredential: true, credentiallessState: 'missing', probeKind: 'discovery', protocol: 'openai-chat', authStyle: 'bearer', probePath: '/models', discoveryPath: '/models', inferencePath: () => '/chat/completions',
    validateBase(url, network) { if (network !== 'public' || url.origin !== 'https://api.groq.com' || url.pathname.replace(/\/$/, '') !== '/openai/v1') throw new ManagementError('INVALID_ENDPOINT') },
    interpret(response) { const body = success(response); if (!Array.isArray(body.data) || !body.data.every(x => x && typeof x.id === 'string')) throw new ManagementError('INVALID_RESPONSE'); return { authentication: 'accepted', discovery: 'succeeded' } },
  },
  {
    definition: { id: 'openai-compatible', name: 'Custom OpenAI-compatible endpoint', adapterId: 'openai-compatible', discovery: 'unknown', accountMetadata: 'unknown' },
    requiresCredential: false, credentiallessState: 'missing', probeKind: 'discovery', protocol: 'openai-chat', authStyle: 'bearer', probePath: '/models', discoveryPath: '/models', inferencePath: () => '/chat/completions',
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
    requiresCredential: false, credentiallessState: 'not-required', probeKind: 'discovery', protocol: 'ollama-chat', authStyle: 'bearer', probePath: '/api/tags', discoveryPath: '/api/tags', inferencePath: () => '/api/chat',
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
