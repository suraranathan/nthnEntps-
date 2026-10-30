import type { DiscoveryPage, ModelDescriptor, ModelCapabilities, JsonValue } from './contracts.ts'
import type { ManagedConnection } from './management-types.ts'
import { ManagementError, objectInput } from './management-types.ts'
import { connectionAdapter } from './connection-adapters.ts'

export const DISCOVERY_PAGE_SIZE = 500
export type DiscoveryQuery = Record<string, string>
export type ParsedDiscovery = DiscoveryPage & { nextQuery: DiscoveryQuery | null; declaredTotal: number | null }
function providerObject(value: unknown) { try { return objectInput(value) } catch { throw new ManagementError('INVALID_RESPONSE') } }
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const strings = (value: unknown): string[] | null => Array.isArray(value) && value.every(x => typeof x === 'string') ? value : null
const tokens = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
const support = (value: unknown) => typeof value === 'boolean' ? value ? 'supported' as const : 'unsupported' as const : 'unknown' as const
export function initialDiscoveryQuery(providerId: string): DiscoveryQuery {
  return providerId === 'openrouter' ? { offset: '0', limit: String(DISCOVERY_PAGE_SIZE), output_modalities: 'all' } : {}
}
export function modelDescriptor(value: unknown, connection: ManagedConnection, at: string): ModelDescriptor {
  const raw = providerObject(value), architecture = record(raw.architecture), capabilities = record(raw.capabilities)
  const nativeId = connection.providerId === 'ollama' ? raw.name : raw.id
  if (typeof nativeId !== 'string' || !nativeId.trim()) throw new ManagementError('INVALID_RESPONSE')
  const parameters = strings(raw.supported_parameters), features = strings(raw.capabilities)
  let input = strings(architecture.input_modalities) ?? strings(raw.input_modalities) ?? strings(capabilities.input)
  let output = strings(architecture.output_modalities) ?? strings(raw.output_modalities) ?? strings(capabilities.output)
  if (features) {
    if (features.includes('completion')) { input ??= ['text', ...(features.includes('vision') ? ['image'] : [])]; output ??= ['text'] }
    if (features.includes('embedding')) { input ??= ['text']; output ??= ['embedding']; if (features.includes('completion') && !strings(architecture.output_modalities) && !strings(raw.output_modalities) && !strings(capabilities.output)) output = ['text', 'embedding'] }
  }
  const caps: ModelCapabilities = {
    input, output,
    tools: support(capabilities.tools ?? raw.supports_tools),
    streaming: support(capabilities.streaming ?? raw.supports_streaming),
    structuredOutput: support(capabilities.structured_output ?? raw.supports_structured_output),
    systemInstructions: support(capabilities.system_instructions ?? raw.supports_system_instructions),
  }
  if (caps.tools === 'unknown' && parameters) caps.tools = parameters.includes('tools') ? 'supported' : 'unsupported'
  if (caps.tools === 'unknown' && features) caps.tools = features.includes('tools') ? 'supported' : 'unsupported'
  if (caps.structuredOutput === 'unknown' && parameters) caps.structuredOutput = parameters.includes('response_format') || parameters.includes('structured_outputs') ? 'supported' : 'unsupported'
  const extensions: Record<string, JsonValue> = {}
  // No raw response dumping: preserve only source fields with understood, non-secret shapes.
  for (const name of ['owned_by', 'object', 'created', 'lifecycle', 'license', 'version', 'canonical_slug', 'digest', 'size', 'modified_at', 'expiration_date', 'knowledge_cutoff', 'description']) {
    const value = raw[name]
    if (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) extensions[name] = value
  }
  if (typeof raw.deprecated === 'boolean') extensions.deprecated = raw.deprecated
  if (Object.keys(capabilities).length) {
    const flags: Record<string, JsonValue> = {}
    for (const name of ['tools', 'streaming', 'structured_output', 'system_instructions', 'thinking', 'reasoning', 'vision']) if (typeof capabilities[name] === 'boolean') flags[name] = capabilities[name] as boolean
    if (Object.keys(flags).length) extensions.capability_flags = flags
  }
  if (parameters) extensions.supported_parameters = parameters
  if (features) extensions.capabilities = features
  for (const name of ['details', 'pricing', 'architecture', 'top_provider']) {
    const source = record(raw[name]), safe: Record<string, JsonValue> = {}
    const allowed = name === 'pricing' ? ['prompt', 'completion', 'request', 'image', 'audio', 'input_cache_read', 'input_cache_write'] : name === 'details' ? ['format', 'family', 'families', 'parameter_size', 'quantization_level'] : name === 'architecture' ? ['input_modalities', 'output_modalities', 'modality', 'tokenizer', 'instruct_type'] : ['context_length', 'max_completion_tokens', 'is_moderated']
    for (const field of allowed) {
      const value = source[field]
      if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) safe[field] = value
      else if (strings(value)) safe[field] = value as string[]
    }
    if (Object.keys(safe).length) extensions[name] = safe
  }
  return {
    nativeModelId: nativeId, displayName: typeof raw.name === 'string' && raw.name.trim() ? raw.name : nativeId,
    capabilities: caps, contextTokens: tokens(raw.context_length) ?? tokens(raw.context_window) ?? tokens(record(raw.top_provider).context_length),
    maxOutputTokens: tokens(raw.max_output_tokens) ?? tokens(record(raw.top_provider).max_completion_tokens),
    evidence: { source: 'provider-api', observedAt: at, reference: connection.providerId + ':' + connection.id }, extensions,
  }
}
function nextLink(value: unknown, connection: ManagedConnection): DiscoveryQuery | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string') throw new ManagementError('PAGINATION_INVALID')
  let url: URL
  try { url = new URL(value, connection.baseUrl + connectionAdapter(connection.providerId).discoveryPath) } catch { throw new ManagementError('PAGINATION_INVALID') }
  const expected = new URL(connection.baseUrl + connectionAdapter(connection.providerId).discoveryPath)
  if (url.origin !== expected.origin || url.pathname !== expected.pathname || url.username || url.password || url.hash) throw new ManagementError('PAGINATION_INVALID')
  const result: DiscoveryQuery = {}
  for (const [key, item] of url.searchParams) {
    if (!['after', 'offset', 'limit', 'cursor', 'page', 'page_token', 'pageToken', 'output_modalities'].includes(key) || key in result) throw new ManagementError('PAGINATION_INVALID')
    result[key] = item
  }
  return result
}
export function parseDiscovery(body: unknown, connection: ManagedConnection, query: DiscoveryQuery, link: string | null = null): ParsedDiscovery {
  const data = providerObject(body)
  const items = connection.providerId === 'ollama' ? data.models : data.data
  if (!Array.isArray(items)) throw new ManagementError('INVALID_RESPONSE')
  const at = new Date().toISOString(), models = items.map(item => modelDescriptor(item, connection, at))
  let next: DiscoveryQuery | null = null, specified = false
  const pagination = { ...record(data.meta), ...record(data.pagination), ...data }
  for (const [source, target] of [['next_cursor', 'cursor'], ['nextPageToken', 'pageToken'], ['next_page_token', 'page_token'], ['next_page', 'page'], ['next_offset', 'offset']] as const) {
    if (!(source in pagination)) continue
    specified = true
    const value = pagination[source]
    if (value === null || value === '') break
    if ((typeof value !== 'string' && !(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0))) throw new ManagementError('PAGINATION_INVALID')
    next = { ...query, [target]: String(value) }; break
  }
  if (!specified && 'has_more' in pagination) {
    specified = true
    if (typeof pagination.has_more !== 'boolean') throw new ManagementError('PAGINATION_INVALID')
    if (pagination.has_more) {
      const last = pagination.last_id ?? models.at(-1)?.nativeModelId
      if (typeof last !== 'string' || !last) throw new ManagementError('PAGINATION_INVALID')
      next = { ...query, after: last, limit: String(DISCOVERY_PAGE_SIZE) }
    }
  }
  const advertised = pagination.next ?? pagination.next_url ?? record(data.links).next
  if (!specified && advertised !== undefined) { specified = true; next = nextLink(advertised, connection) }
  if (!specified && link) {
    for (const segment of link.split(/,(?=\s*<)/)) {
      const target = /^\s*<([^>]+)>/.exec(segment), relation = /;\s*rel=(?:"([^"]*)"|'([^']*)'|([^;\s,]+))/i.exec(segment)
      if (target && relation && (relation[1] ?? relation[2] ?? relation[3]).split(/\s+/).includes('next')) { specified = true; next = nextLink(target[1], connection); break }
    }
  }
  if (specified && !next && pagination.has_more === true) throw new ManagementError('PAGINATION_INVALID')
  if (!specified && typeof pagination.total_pages === 'number') {
    const totalPages = tokens(pagination.total_pages), current = tokens(pagination.current_page ?? Number(query.page ?? 1))
    if (totalPages === null || current === null || current < 1) throw new ManagementError('PAGINATION_INVALID')
    if (current < totalPages) next = { ...query, page: String(current + 1) }
    specified = true
  }
  if (!specified && typeof pagination.total === 'number') {
    const total = tokens(pagination.total), offset = Number(query.offset ?? 0)
    if (total === null || !Number.isSafeInteger(offset)) throw new ManagementError('PAGINATION_INVALID')
    if (offset + items.length < total) next = { ...query, offset: String(offset + items.length), limit: String(DISCOVERY_PAGE_SIZE) }
    specified = true
  }
  if (!specified && connection.providerId === 'openrouter' && items.length >= DISCOVERY_PAGE_SIZE) next = { ...query, offset: String(Number(query.offset ?? 0) + items.length) }
  if (next && !items.length) throw new ManagementError('PAGINATION_INVALID')
  if (connection.providerId === 'openrouter' && next) next.output_modalities = 'all'
  return { models, visibility: connection.providerId === 'openrouter' ? 'account-filtered' : connection.providerId === 'ollama' ? 'local' : 'unknown', nextQuery: next, nextCursor: next ? JSON.stringify(next) : null, declaredTotal: tokens(pagination.total) }
}
