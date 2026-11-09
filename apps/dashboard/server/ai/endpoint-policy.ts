import { isIP } from 'node:net'
import { lookup } from 'node:dns/promises'
import { request as httpsRequest } from 'node:https'
import { request as httpRequest } from 'node:http'
import { checkServerIdentity } from 'node:tls'
import type { RequestOptions } from 'node:https'
import type { NetworkPolicy } from './management-types.ts'
import { connectionAdapter } from './connection-adapters.ts'
import { ManagementError } from './management-types.ts'

export type Address = { address: string; family: number }
export type Resolver = (hostname: string) => Promise<Address[]>
export type EndpointRules = { localPorts: readonly number[] }
export const defaultEndpointRules: EndpointRules = { localPorts: [11434, 1234, 8000, 8080] }
export function endpointRulesFromEnv(value: string | undefined): EndpointRules {
  if (value === undefined) return defaultEndpointRules
  if (!/^\d+(,\d+)*$/.test(value)) throw new ManagementError('INVALID_ENDPOINT')
  const ports = value.split(',').map(Number)
  if (ports.some(port => !Number.isInteger(port) || port < 1 || port > 65535 || [22, 3000, 3001].includes(port))) throw new ManagementError('INVALID_ENDPOINT')
  return { localPorts: [...new Set([...defaultEndpointRules.localPorts, ...ports])] }
}
export const resolveAddresses: Resolver = hostname => lookup(hostname, { all: true, verbatim: true })
const hostOf = (url: URL) => url.hostname.replace(/^\[|\]$/g, '')

/** Conservative allowlist of globally routable IP ranges; mapped/transition IPv6 is denied. */
export function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number)
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && ((b === 168) || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113) ||
      address === '168.63.129.16')
  }
  if (isIP(address) === 6) {
    const parts = address.split(':'), first = parseInt(parts[0], 16), second = parseInt(parts[1] || '0', 16)
    return first >= 0x2000 && first < 0x3ff0 && !(first === 0x2001 && (second <= 0x1ff || second === 0xdb8)) && first !== 0x2002
  }
  return false
}
export function validateEndpoint(value: unknown, network: NetworkPolicy, providerId: string, rules = defaultEndpointRules): string {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\x00-\x1f\x7f%\\]/.test(value)) throw new ManagementError('INVALID_ENDPOINT')
  let url: URL
  try { url = new URL(value) } catch { throw new ManagementError('INVALID_ENDPOINT') }
  if (url.username || url.password || url.search || url.hash || !['http:', 'https:'].includes(url.protocol) || !/^\/(?:[A-Za-z0-9_-]+\/?)*$/.test(url.pathname)) throw new ManagementError('INVALID_ENDPOINT')
  const host = hostOf(url), port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
  connectionAdapter(providerId).validateBase(url, network)
  if (network === 'loopback') {
    if (!['localhost', '127.0.0.1', '::1'].includes(host) || !rules.localPorts.includes(port) || [22, 3000, 3001].includes(port)) throw new ManagementError('INVALID_ENDPOINT')
  } else if (network === 'public') {
    if (url.protocol !== 'https:' || port !== 443 || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || (isIP(host) && !publicAddress(host))) throw new ManagementError('INVALID_ENDPOINT')
  } else throw new ManagementError('INVALID_ENDPOINT')
  return url.toString().replace(/\/$/, '')
}
export async function pinEndpoint(base: string, network: NetworkPolicy, providerId: string, resolver: Resolver = resolveAddresses, rules = defaultEndpointRules) {
  const normalized = validateEndpoint(base, network, providerId, rules), url = new URL(normalized), host = hostOf(url)
  let addresses: Address[] | null = isIP(host) ? [{ address: host, family: isIP(host) }] : null
  for (let attempt = 0; addresses === null && attempt < 3; attempt++) {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      addresses = await Promise.race([
        resolver(host), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ManagementError('DNS_FAILED')), 5000); timer.unref() }),
      ])
    } catch {
      if (attempt === 2) throw new ManagementError('DNS_FAILED')
      await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)))
    } finally { if (timer) clearTimeout(timer) }
  }
  if (addresses === null) throw new ManagementError('DNS_FAILED')
  if (!addresses.length || addresses.some(item => !isIP(item.address) || (network === 'public' ? !publicAddress(item.address) : !['127.0.0.1', '::1'].includes(item.address)))) throw new ManagementError('BLOCKED_ENDPOINT')
  return { base: normalized, url, host, address: addresses[0].address }
}
export type PinnedEndpoint = Awaited<ReturnType<typeof pinEndpoint>>
export type ProbeResponse = { status: number; body: unknown; link?: string | null }
export type ProbeTransport = (endpoint: PinnedEndpoint, path: string, apiKey: string | null, options?: { maxBytes?: number; body?: Record<string, unknown>; stream?: boolean; readErrors?: boolean; authStyle?: 'bearer' | 'x-api-key' | 'anthropic' | 'gemini' }) => Promise<ProbeResponse>

/**
 * Streaming variant of the pinned transport. Yields raw text chunks exactly as
 * the provider sent them; callers are responsible for protocol framing.
 * DNS is never resolved again after validation.
 */
export async function* requestPinnedStream(
  endpoint: PinnedEndpoint,
  path: string,
  apiKey: string | null,
  limits: { body?: Record<string, unknown>; maxBytes?: number; authStyle?: 'bearer' | 'x-api-key' | 'anthropic' | 'gemini'; signal?: AbortSignal; timeoutMs?: number } = {},
): AsyncGenerator<string> {
  const options: RequestOptions = {
    hostname: endpoint.address, port: endpoint.url.port || undefined, path: endpoint.url.pathname.replace(/\/$/, '') + path,
    method: 'POST', agent: false, maxHeaderSize: 16384, rejectUnauthorized: true,
    checkServerIdentity: (_hostname, certificate) => checkServerIdentity(endpoint.host, certificate),
    ...(endpoint.url.protocol === 'https:' && !isIP(endpoint.host) ? { servername: endpoint.host } : {}),
    headers: {
      Host: endpoint.url.host, Accept: 'text/event-stream', 'Accept-Encoding': 'identity', 'Content-Type': 'application/json',
      ...(limits.authStyle === 'anthropic' ? { 'anthropic-version': '2023-06-01' } : {}),
      ...(apiKey ? limits.authStyle === 'gemini' ? { 'x-goog-api-key': apiKey } : ['anthropic', 'x-api-key'].includes(limits.authStyle ?? '') ? { 'x-api-key': apiKey } : { Authorization: `Bearer ${apiKey}` } : {}),
    },
  }
  const queue: string[] = []
  let done = false
  let failure: Error | null = null
  let wake: (() => void) | null = null
  const notify = () => { wake?.(); wake = null }
  const request = (endpoint.url.protocol === 'https:' ? httpsRequest : httpRequest)(options, response => {
    const status = response.statusCode ?? 0
    if (status < 200 || status >= 300) {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => { if (chunks.length < 64) chunks.push(chunk) })
      response.on('end', () => {
        let code = 'PROBE_FAILED'
        if (status === 401 || status === 403) code = 'AUTH_REJECTED'
        else if (status === 429) code = 'RATE_LIMITED'
        else if (status === 404) code = 'MODEL_UNAVAILABLE'
        else if (status === 400 || status === 422) code = 'INCOMPATIBLE'
        else if (status >= 300 && status < 400) code = 'REDIRECT_BLOCKED'
        failure = new ManagementError(code)
        done = true; notify()
      })
      response.on('error', () => { failure = new ManagementError('REQUEST_FAILED'); done = true; notify() })
      return
    }
    let bytes = 0
    response.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > (limits.maxBytes ?? 8_000_000)) {
        failure = new ManagementError('RESPONSE_LIMIT'); request.destroy(); return
      }
      queue.push(chunk.toString('utf8')); notify()
    })
    response.on('end', () => { done = true; notify() })
    response.on('error', () => { failure = new ManagementError('REQUEST_FAILED'); done = true; notify() })
  })
  const timer = setTimeout(() => request.destroy(new Error('timeout')), limits.timeoutMs ?? 120_000)
  timer.unref()
  const abort = () => request.destroy(new Error('aborted'))
  limits.signal?.addEventListener('abort', abort, { once: true })
  request.on('close', () => clearTimeout(timer))
  request.on('error', () => { failure = new ManagementError('REQUEST_FAILED'); done = true; notify() })
  request.end(limits.body ? JSON.stringify(limits.body) : undefined)
  try {
    while (!done || queue.length > 0) {
      if (queue.length > 0) { yield queue.shift() as string; continue }
      if (failure) throw failure
      await new Promise<void>(resolve => { wake = resolve })
    }
    if (failure) throw failure
  } finally {
    limits.signal?.removeEventListener('abort', abort)
    clearTimeout(timer)
    if (!done) request.destroy()
  }
}

/** Connect directly to the approved IP: DNS is never resolved again after validation. */
export const requestPinnedJson: ProbeTransport = (endpoint, path, apiKey, limits = {}) => new Promise((resolve, reject) => {
  const options: RequestOptions = {
    hostname: endpoint.address, port: endpoint.url.port || undefined, path: endpoint.url.pathname.replace(/\/$/, '') + path,
    method: limits.body ? 'POST' : 'GET', agent: false, maxHeaderSize: 16384, rejectUnauthorized: true,
    checkServerIdentity: (_hostname, certificate) => checkServerIdentity(endpoint.host, certificate),
    ...(endpoint.url.protocol === 'https:' && !isIP(endpoint.host) ? { servername: endpoint.host } : {}),
    headers: { Host: endpoint.url.host, Accept: 'application/json', 'Accept-Encoding': 'identity', ...(limits.body ? { 'Content-Type': 'application/json' } : {}), ...(limits.authStyle === 'anthropic' ? { 'anthropic-version': '2023-06-01' } : {}), ...(apiKey ? limits.authStyle === 'gemini' ? { 'x-goog-api-key': apiKey } : ['anthropic', 'x-api-key'].includes(limits.authStyle ?? '') ? { 'x-api-key': apiKey } : { Authorization: `Bearer ${apiKey}` } : {}) },
  }
  const request = (endpoint.url.protocol === 'https:' ? httpsRequest : httpRequest)(options, response => {
    const status = response.statusCode ?? 0
    if ((status < 200 || status >= 300) && !limits.readErrors) { response.destroy(); resolve({ status, body: null }); return }
    let bytes = 0
    const chunks: Buffer[] = []
    response.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > (limits.maxBytes ?? 1_000_000)) { request.destroy(); reject(new ManagementError('RESPONSE_LIMIT')); return }
      chunks.push(chunk)
    })
    response.on('error', () => reject(new ManagementError('REQUEST_FAILED')))
    response.on('end', () => {
      try { resolve({ status, body: limits.stream && status >= 200 && status < 300 ? Buffer.concat(chunks).toString('utf8') : JSON.parse(Buffer.concat(chunks).toString('utf8')), link: Array.isArray(response.headers.link) ? response.headers.link.join(', ') : response.headers.link ?? null }) }
      catch { if (status < 200 || status >= 300) resolve({ status, body: null }); else reject(new ManagementError('INVALID_RESPONSE')) }
    })
  })
  const timer = setTimeout(() => request.destroy(new Error('timeout')), 15000)
  timer.unref()
  request.on('close', () => clearTimeout(timer))
  request.on('error', () => reject(new ManagementError('REQUEST_FAILED')))
  request.end(limits.body ? JSON.stringify(limits.body) : undefined)
})
