import type { AiAction, AiSnapshot } from './ai-contract.ts'

export class AiRequestError extends Error {
  readonly code: string
  constructor(message: string, code = '') { super(message); this.code = code }
}

/** No credential cache or browser persistence. Keys exist only in the outgoing request. */
export class AiClient {
  #csrf = ''
  #fetch: typeof fetch
  constructor(transport: typeof fetch = globalThis.fetch) {
    // Window.fetch requires its browser receiver; calling a stored function as
    // this.#fetch would otherwise pass the AiClient instance as `this`.
    this.#fetch = transport.bind(globalThis)
  }
  async #read(response: Response) {
    let data
    try { data = await response.json() }
    catch { throw new AiRequestError('Provider API unavailable. Start the dashboard with npm run dev or npm run start.') }
    if (!response.ok) throw new AiRequestError(typeof data.error === 'string' ? data.error : 'Provider request failed.', typeof data.code === 'string' ? data.code : '')
    return data
  }
  async snapshot(signal?: AbortSignal): Promise<AiSnapshot> {
    const data = await this.#read(await this.#fetch('/api/ai', { credentials: 'same-origin', cache: 'no-store', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000) })) as AiSnapshot
    if (!data.csrf || !Array.isArray(data.connections) || !Array.isArray(data.providers)) throw new AiRequestError('Provider API returned an invalid response.')
    this.#csrf = data.csrf
    return data
  }
  async request<T>(action: AiAction, signal?: AbortSignal): Promise<T> {
    if (!this.#csrf) await this.snapshot(signal)
    const send = () => this.#fetch('/api/ai', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-Jef-CSRF': this.#csrf },
      body: JSON.stringify(action), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(135000)]) : AbortSignal.timeout(135000),
    })
    let response = await send()
    // A rejected CSRF request has not executed; refresh the shared local session once.
    if (response.status === 403) { await this.snapshot(signal); response = await send() }
    return this.#read(response) as Promise<T>
  }
}
