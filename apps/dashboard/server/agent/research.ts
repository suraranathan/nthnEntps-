import { lookup } from 'node:dns/promises'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { checkServerIdentity } from 'node:tls'
import { publicAddress } from '../ai/endpoint-policy.ts'

const MAX_BODY = 512_000
const MAX_REDIRECTS = 3
const MAX_RESULTS = 8
const TIMEOUT_MS = 12_000

export interface WebResponse { status: number; headers: Record<string, string | undefined>; body: string }
export interface WebSource { title: string; url: string; snippet: string }
export interface OpenedPage { title: string; url: string; text: string }
export type SearchConfig = { kind: 'searxng'; endpoint: string } | { kind: 'brave'; apiKey: string }
export type WebRequest = (url: URL, signal: AbortSignal, headers?: Record<string, string>) => Promise<WebResponse>

export function validatePublicUrl(value: string): URL {
  if (value.length > 2048 || /[\x00-\x1f\x7f\\]/.test(value)) throw new Error('Invalid research URL.')
  let url: URL
  try { url = new URL(value) } catch { throw new Error('Invalid research URL.') }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (url.protocol !== 'https:' || url.port && url.port !== '443' || url.username || url.password ||
    !host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') ||
    (isIP(host) && !publicAddress(host))) throw new Error('Research URL must use public HTTPS.')
  url.hash = ''
  return url
}

function decode(value: string): string {
  return value.replace(/&(#(?:x[0-9a-f]+|\d+)|amp|lt|gt|quot|apos|nbsp);/gi, (match, entity: string) => {
    const names: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
    if (entity[0] !== '#') return names[entity.toLowerCase()] ?? match
    const code = entity[1]?.toLowerCase() === 'x' ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10)
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match
  })
}

export function extractPage(html: string): { title: string; text: string } {
  const title = decode((/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').replace(/<[^>]*>/g, '').trim()).slice(0, 200)
  const cleaned = html.replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|nav|footer|header)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<(?:br|hr|\/p|\/div|\/h[1-6]|\/li|\/article|\/section)\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
  return { title, text: decode(cleaned).replace(/[\t ]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim().slice(0, 24_000) }
}

export async function publicHttpsRequest(url: URL, signal: AbortSignal, headers: Record<string, string> = {}): Promise<WebResponse> {
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true, verbatim: true })
  if (!addresses.length || addresses.some(item => !publicAddress(item.address))) throw new Error('Research address is not public.')
  const address = addresses[0]
  return await new Promise<WebResponse>((resolve, reject) => {
    const req = httpsRequest({
      hostname: address.address, family: address.family, port: 443, path: url.pathname + url.search,
      method: 'GET', agent: false, maxHeaderSize: 16_384, rejectUnauthorized: true,
      ...(isIP(host) ? {} : { servername: host }),
      checkServerIdentity: (_name, certificate) => checkServerIdentity(host, certificate),
      headers: { Host: url.host, Accept: 'text/html,application/json;q=0.9,text/plain;q=0.8', 'Accept-Encoding': 'identity', 'User-Agent': 'NTHN-Jef/1.9', ...headers },
    }, response => {
      const chunks: Buffer[] = []
      let size = 0
      response.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > MAX_BODY) { req.destroy(new Error('Research response is too large.')); return }
        chunks.push(chunk)
      })
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        headers: Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [key, Array.isArray(value) ? value[0] : value])),
        body: Buffer.concat(chunks).toString('utf8'),
      }))
      response.on('error', reject)
    })
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error('Research request timed out.')))
    signal.addEventListener('abort', () => req.destroy(new Error('Research request cancelled.')), { once: true })
    req.on('error', reject)
    req.end()
  })
}

export class ResearchService {
  readonly configuredSearch: boolean
  private readonly config?: SearchConfig
  private readonly request: WebRequest

  constructor(options: { search?: SearchConfig; request?: WebRequest } = {}) {
    this.config = options.search
    this.request = options.request ?? publicHttpsRequest
    this.configuredSearch = !!options.search
    if (options.search?.kind === 'searxng') validatePublicUrl(options.search.endpoint)
    if (options.search?.kind === 'brave' && (!options.search.apiKey || options.search.apiKey.length > 500)) throw new Error('Invalid Brave search key.')
  }

  private async get(value: string, signal: AbortSignal, headers?: Record<string, string>): Promise<{ response: WebResponse; url: URL }> {
    let url = validatePublicUrl(value)
    for (let count = 0; count <= MAX_REDIRECTS; count += 1) {
      const response = await this.request(url, signal, headers)
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (count === MAX_REDIRECTS || !response.headers.location) throw new Error('Too many research redirects.')
        const next = validatePublicUrl(new URL(response.headers.location, url).href)
        if (headers && next.origin !== url.origin) throw new Error('Authenticated search redirect to another origin was blocked.')
        url = next
        continue
      }
      if (response.status !== 200) throw new Error(`Research request failed (HTTP ${response.status}).`)
      return { response, url }
    }
    throw new Error('Too many research redirects.')
  }

  async open(value: string, signal: AbortSignal): Promise<OpenedPage> {
    const { response, url } = await this.get(value, signal)
    if (!/^text\/html\b|^text\/plain\b/i.test(response.headers['content-type'] ?? '')) throw new Error('Research URL is not an HTML or text page.')
    const page = extractPage(response.body)
    return { title: page.title || url.hostname, url: url.href, text: page.text }
  }

  async search(query: string, signal: AbortSignal): Promise<WebSource[]> {
    const term = query.trim()
    if (!term || term.length > 300) throw new Error('Search query must contain 1 to 300 characters.')
    if (!this.config) throw new Error('Web search is not configured.')
    const url = this.config.kind === 'brave' ? new URL('https://api.search.brave.com/res/v1/web/search') : validatePublicUrl(this.config.endpoint)
    if (this.config.kind === 'searxng') { url.pathname = url.pathname.replace(/\/$/, '') + '/search'; url.searchParams.set('format', 'json') }
    url.searchParams.set('q', term)
    const headers = this.config.kind === 'brave' ? { 'X-Subscription-Token': this.config.apiKey } : undefined
    const { response } = await this.get(url.href, signal, headers)
    if (!/^application\/json\b/i.test(response.headers['content-type'] ?? '')) throw new Error('Search provider returned a non-JSON response.')
    let parsed: unknown
    try { parsed = JSON.parse(response.body) } catch { throw new Error('Search provider returned invalid JSON.') }
    const data = parsed as Record<string, any>
    const raw = this.config.kind === 'brave' ? data?.web?.results : data?.results
    if (!Array.isArray(raw)) throw new Error('Search provider returned no result list.')
    const results: WebSource[] = []
    for (const item of raw) {
      if (!item || typeof item.url !== 'string' || typeof item.title !== 'string') continue
      try {
        const source = validatePublicUrl(item.url)
        results.push({ title: extractPage(`<title>${item.title}</title>`).title, url: source.href, snippet: String(item.description ?? item.content ?? '').replace(/<[^>]*>/g, '').slice(0, 500) })
      } catch { /* The search provider may include local or invalid links. */ }
      if (results.length >= MAX_RESULTS) break
    }
    return results
  }
}
