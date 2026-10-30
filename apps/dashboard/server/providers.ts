import type { ProviderInfo } from '../src/alex-contract.ts'
export type ModelMessage = { role: 'system' | 'user' | 'assistant'; content: string }
export interface ModelProvider {
  info: ProviderInfo
  complete(messages: ModelMessage[]): Promise<string>
  discover(): Promise<string[] | null>
}
export class ProviderError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, status = 502) { super(code); this.code = code; this.status = status }
}
export class HttpProvider implements ModelProvider {
  info: ProviderInfo
  readonly id: string
  readonly model: string
  private base: string
  private key: string
  private kind: 'openai-compatible' | 'ollama'
  private fetcher: typeof fetch
  private timeout: number
  constructor(id: string, model: string, base: string, key: string, kind: 'openai-compatible' | 'ollama', fetcher: typeof fetch = fetch, timeout = 60000) {
    this.id = id; this.model = model; this.base = base; this.key = key; this.kind = kind; this.fetcher = fetcher; this.timeout = timeout
    const url = new URL(base)
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) || url.username || url.password || url.search || url.hash) throw new Error('Provider base URL requires HTTPS or loopback HTTP, with no embedded credentials/query')
    this.base = base.replace(/\/$/, '')
    this.info = { id, model, configured: Boolean(model && (kind === 'ollama' || key || url.protocol === 'http:')), capabilities: { text: true, tools: false, streaming: false, images: false, discovery: true } }
  }
  private async request(path: string, body?: unknown) {
    if (!this.info.configured) throw new ProviderError('Provider is not configured', 503)
    let response: Response
    try {
      response = await this.fetcher(this.base + path, { method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(this.timeout), headers: { ...(this.key ? { Authorization: `Bearer ${this.key}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
    } catch { throw new ProviderError('Provider unreachable or request timed out') }
    // Never forward raw provider errors: they may include secrets, prompts or URLs.
    if (!response.ok) {
      await response.body?.cancel()
      if (response.status === 401 || response.status === 403) throw new ProviderError('Provider rejected credentials or model access')
      if (response.status === 429) throw new ProviderError('Provider rate limit reached', 429)
      if (response.status === 404) throw new ProviderError('Provider endpoint or model not found', 404)
      throw new ProviderError('Provider request failed')
    }
    let text = ''
    const reader = response.body?.getReader()
    if (!reader) throw new ProviderError('Provider returned no body')
    const decoder = new TextDecoder()
    let bytes = 0
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        bytes += chunk.value.byteLength
        if (bytes > 1_000_000) { await reader.cancel(); throw new ProviderError('Provider response exceeded limit') }
        text += decoder.decode(chunk.value, { stream: true })
      }
      text += decoder.decode()
    } catch (error) { throw error instanceof ProviderError ? error : new ProviderError('Provider response interrupted or timed out') }
    try { return JSON.parse(text) } catch { throw new ProviderError('Provider returned invalid JSON') }
  }
  async complete(messages: ModelMessage[]) {
    const body = this.kind === 'ollama' ? { model: this.model, messages, stream: false, options: { num_predict: 1600 } } : { model: this.model, messages, stream: false, max_completion_tokens: 1600 }
    const data = await this.request(this.kind === 'ollama' ? '/api/chat' : '/chat/completions', body)
    const choice = data?.choices?.[0]
    const text = this.kind === 'ollama' ? data?.message?.content : choice?.message?.content
    if (choice?.message?.tool_calls?.length) throw new ProviderError('Model requested unsupported tools')
    if (choice?.finish_reason === 'length' || data?.done_reason === 'length') throw new ProviderError('Model response was truncated; try a shorter request')
    if (typeof text !== 'string' || !text.trim()) throw new ProviderError('Provider returned no usable text')
    return text.trim().slice(0, 16000)
  }
  async discover() {
    try {
      const data = await this.request(this.kind === 'ollama' ? '/api/tags' : '/models')
      const list = this.kind === 'ollama' ? data?.models?.map((x: { name: string }) => x.name) : data?.data?.map((x: { id: string }) => x.id)
      return Array.isArray(list) && list.every((x: unknown) => typeof x === 'string') ? list : null
    } catch (error) {
      if (error instanceof ProviderError && error.status === 404) return null
      throw error
    }
  }
}
// Future Nexus can call select() with an allowlisted provider ID; secrets remain here.
export class ModelRouter {
  private active: string | null
  readonly providers: ModelProvider[]
  constructor(providers: ModelProvider[], selected: string | null = null) {
    this.providers = providers
    this.active = providers.some(x => x.info.id === selected && x.info.configured) ? selected : providers.find(x => x.info.configured)?.info.id ?? null
  }
  current() { return this.providers.find(x => x.info.id === this.active) ?? null }
  select(id: string) {
    const provider = this.providers.find(x => x.info.id === id && x.info.configured)
    if (!provider) throw new ProviderError('Unknown or unconfigured provider', 400)
    this.active = id
    return provider
  }
}
export function providersFromEnv(env: NodeJS.ProcessEnv): ModelProvider[] {
  const providers: ModelProvider[] = []
  if (env.ALEX_BASE_URL || env.ALEX_API_KEY || env.OPENAI_API_KEY || env.ALEX_MODEL) providers.push(new HttpProvider('openai-compatible', env.ALEX_MODEL ?? '', env.ALEX_BASE_URL || 'https://api.openai.com/v1', env.ALEX_API_KEY || env.OPENAI_API_KEY || '', 'openai-compatible'))
  if (env.ALEX_OLLAMA_MODEL) providers.push(new HttpProvider('ollama', env.ALEX_OLLAMA_MODEL, env.ALEX_OLLAMA_URL || 'http://127.0.0.1:11434', '', 'ollama'))
  return providers
}
