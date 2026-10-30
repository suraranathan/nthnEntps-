import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { AlexRuntime, InputError } from './runtime.ts'
import { ProviderError } from './providers.ts'

const origins = new Set(['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000'])
export function createApi(runtime: AlexRuntime, extraOrigins: string[] = []) {
  const allowed = new Set([...origins, ...extraOrigins])
  const sessions = new Map<string, { csrf: string; expires: number }>()
  let nextMutation = 0
  function send(res: ServerResponse, status: number, data: unknown) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin' })
    res.end(JSON.stringify(data))
  }
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (!allowed.has(`http://${req.headers.host}`) || (req.headers.origin && !allowed.has(req.headers.origin)) || req.headers['sec-fetch-site'] === 'cross-site') throw new InputError('Alex API is restricted to the local dashboard origin', 403)
      if (req.url !== '/api/alex') throw new InputError('Not found', 404)
      const cookie = /(?:^|;\s*)alex_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie ?? '')?.[1]
      let session = cookie ? sessions.get(cookie) : undefined
      if (session && session.expires < Date.now()) { sessions.delete(cookie!); session = undefined }
      if (req.method === 'GET') {
        if (!session) {
          for (const [key, value] of sessions) if (value.expires < Date.now()) sessions.delete(key)
          if (sessions.size >= 32) sessions.delete(sessions.keys().next().value!)
          const token = randomBytes(32).toString('hex')
          session = { csrf: randomBytes(32).toString('hex'), expires: Date.now() + 12 * 3600000 }
          sessions.set(token, session)
          res.setHeader('Set-Cookie', `alex_session=${token}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=43200`)
        }
        send(res, 200, runtime.snapshot(session.csrf)); return
      }
      if (req.method !== 'POST') throw new InputError('Method not allowed', 405)
      const csrf = req.headers['x-alex-csrf']
      if (!req.headers.origin || !session || typeof csrf !== 'string' || !/^[a-f0-9]{64}$/.test(csrf) || csrf.length !== session.csrf.length || !timingSafeEqual(Buffer.from(csrf), Buffer.from(session.csrf))) throw new InputError('Session expired or invalid CSRF token; reconnect the chat', 403)
      if (req.headers['content-type'] !== 'application/json') throw new InputError('Expected application/json', 415)
      if (Date.now() < nextMutation) throw new InputError('Please wait before sending another request', 429)
      nextMutation = Date.now() + 250
      if (Number(req.headers['content-length']) > 16000) { req.resume(); throw new InputError('Request too large', 413) }
      const chunks = await new Promise<Buffer[]>((resolve, reject) => {
        let size = 0, rejected = false
        const chunks: Buffer[] = []
        req.on('data', (chunk: Buffer) => {
          if (rejected) return
          size += chunk.length
          if (size > 16000) { rejected = true; reject(new InputError('Request too large', 413)); return }
          chunks.push(chunk)
        })
        req.on('end', () => { if (!rejected) resolve(chunks) })
        req.on('error', reject)
      })
      let input: unknown
      try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new InputError('Invalid JSON') }
      await runtime.action(input)
      send(res, 200, runtime.snapshot(session.csrf))
    } catch (error) {
      const known = error instanceof InputError || error instanceof ProviderError
      const message = known ? error.message : 'Internal agent error; no action was executed'
      runtime.store.log('api.error', known ? message : 'internal failure')
      await runtime.store.save().catch(() => {})
      if (!res.headersSent) send(res, known ? error.status : 500, { error: message })
      else res.end()
    }
  })
  server.requestTimeout = 15000
  server.headersTimeout = 15000
  server.maxConnections = 32
  return server
}
