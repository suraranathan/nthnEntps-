import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { AlexRuntime, InputError } from './runtime.ts'
import { ProviderError } from './providers.ts'
import { ManagementError } from './ai/management-types.ts'
import type { AiManagementApi } from './ai/management-api.ts'
import { AgentBusyError, type AlexAgent, type AgentEvent } from './agent/agent.ts'
import { PermissionError } from './agent/permissions.ts'
import { GatewayError } from './agent/gateway.ts'

const origins = new Set(['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000'])
const AGENT_BODY_LIMIT = 100_000
export function createApi(runtime: AlexRuntime, extraOrigins: string[] = [], ai?: () => AiManagementApi, agent?: AlexAgent) {
  const allowed = new Set([...origins, ...extraOrigins])
  const sessions = new Map<string, { csrf: string; expires: number }>()
  let nextMutation = 0
  function send(res: ServerResponse, status: number, data: unknown) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin' })
    res.end(JSON.stringify(data))
  }
  function sseOpen(res: ServerResponse) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
    })
    res.write(': connected\n\n')
  }
  function sseWrite(res: ServerResponse, event: AgentEvent | Record<string, unknown>) {
    res.write(`data: ${JSON.stringify(event)}\n\n`)
  }
  async function streamAgent(res: ServerResponse, conversationId: string, operation: (emit: (event: AgentEvent) => void) => Promise<void>) {
    sseOpen(res)
    const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n') }, 15_000)
    heartbeat.unref()
    res.on('close', () => agent?.cancel(conversationId))
    try {
      await operation(event => { if (!res.writableEnded) sseWrite(res, event) })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Agent request failed'
      const code = error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : 'AGENT_ERROR'
      if (!res.writableEnded) sseWrite(res, { type: 'error', conversationId, message, code })
    } finally {
      clearInterval(heartbeat)
      if (!res.writableEnded) res.end()
    }
  }
  async function handleAgent(path: string, input: unknown, res: ServerResponse): Promise<void> {
    if (!agent) throw new InputError('Not found', 404)
    const data = typeof input === 'object' && input !== null ? input as Record<string, unknown> : {}
    switch (path) {
      case '/api/agent/chat': {
        const conversationId = typeof data.conversationId === 'string' ? data.conversationId : ''
        const text = typeof data.text === 'string' ? data.text : ''
        if (!conversationId || !text.trim()) throw new InputError('conversationId and text are required')
        await streamAgent(res, conversationId, emit => agent!.run(conversationId, text, emit))
        return
      }
      case '/api/agent/approve': {
        const conversationId = typeof data.conversationId === 'string' ? data.conversationId : ''
        const approvalId = typeof data.approvalId === 'string' ? data.approvalId : ''
        if (!conversationId || !approvalId || typeof data.approved !== 'boolean') throw new InputError('conversationId, approvalId and approved are required')
        await streamAgent(res, conversationId, emit => agent!.approve(conversationId, approvalId, data.approved as boolean, emit))
        return
      }
      case '/api/agent/cancel': {
        const conversationId = typeof data.conversationId === 'string' ? data.conversationId : ''
        if (!conversationId) throw new InputError('conversationId is required')
        send(res, 200, { cancelled: agent.cancel(conversationId) })
        return
      }
      case '/api/agent/new': {
        const title = typeof data.title === 'string' ? data.title : undefined
        const conversation = await agent.newConversation(title)
        send(res, 200, { conversation, state: agent.state() })
        return
      }
      case '/api/agent/select': {
        const conversationId = typeof data.conversationId === 'string' ? data.conversationId : ''
        if (!conversationId) throw new InputError('conversationId is required')
        const conversation = await agent.select(conversationId)
        if (!conversation) throw new InputError('Conversation not found', 404)
        send(res, 200, agent.state())
        return
      }
      case '/api/agent/remove': {
        const conversationId = typeof data.conversationId === 'string' ? data.conversationId : ''
        if (!conversationId) throw new InputError('conversationId is required')
        await agent.remove(conversationId)
        send(res, 200, { removed: true, ...agent.state() })
        return
      }
      case '/api/agent/decide': {
        send(res, 200, agent.decide(data))
        return
      }
      default:
        throw new InputError('Not found', 404)
    }
  }
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const isAi = req.url === '/api/ai'
    const path = req.url?.split('?')[0] ?? ''
    const isAgent = path === '/api/agent' || path.startsWith('/api/agent/')
    const isAiRequest = path === '/api/ai' || path.startsWith('/api/ai/')
    try {
      if (!allowed.has(`http://${req.headers.host}`) || (req.headers.origin && !allowed.has(req.headers.origin)) || req.headers['sec-fetch-site'] === 'cross-site') throw new InputError('Alex API is restricted to the local dashboard origin', 403)
      if (req.url !== '/api/alex' && !(isAi && ai) && !(isAgent && agent)) throw new InputError('Not found', 404)
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
        if (isAgent) send(res, 200, { ...agent!.state(), csrf: session.csrf })
        else send(res, 200, isAi ? ai!().snapshot(session.csrf) : runtime.snapshot(session.csrf))
        return
      }
      if (req.method !== 'POST') throw new InputError('Method not allowed', 405)
      const csrf = req.headers['x-alex-csrf']
      if (!req.headers.origin || !session || typeof csrf !== 'string' || !/^[a-f0-9]{64}$/.test(csrf) || csrf.length !== session.csrf.length || !timingSafeEqual(Buffer.from(csrf), Buffer.from(session.csrf))) throw new InputError('Session expired or invalid CSRF token; reconnect the chat', 403)
      if (req.headers['content-type'] !== 'application/json') throw new InputError('Expected application/json', 415)
      if (!isAi && !isAgent) {
        if (Date.now() < nextMutation) throw new InputError('Please wait before sending another request', 429)
        nextMutation = Date.now() + 250
      }
      const limit = isAgent ? AGENT_BODY_LIMIT : 16000
      if (Number(req.headers['content-length']) > limit) { req.resume(); throw new InputError('Request too large', 413) }
      const chunks = await new Promise<Buffer[]>((resolve, reject) => {
        let size = 0, rejected = false
        const chunks: Buffer[] = []
        req.on('data', (chunk: Buffer) => {
          if (rejected) return
          size += chunk.length
          if (size > limit) { rejected = true; reject(new InputError('Request too large', 413)); return }
          chunks.push(chunk)
        })
        req.on('end', () => { if (!rejected) resolve(chunks) })
        req.on('error', reject)
      })
      let input: unknown
      try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new InputError('Invalid JSON') }
      if (isAgent) await handleAgent(path, input, res)
      else if (isAi) send(res, 200, await ai!().action(input))
      else {
        await runtime.action(input)
        send(res, 200, runtime.snapshot(session.csrf))
      }
    } catch (error) {
      const management = isAiRequest && error instanceof ManagementError ? error : null
      const known = error instanceof InputError || error instanceof ProviderError || error instanceof PermissionError || error instanceof AgentBusyError || error instanceof GatewayError
      const message = management?.message ?? (known ? error.message : isAiRequest ? 'Provider operation failed. Reload current state before retrying.' : 'Internal agent error; no action was executed')
      // Provider management must never write to Alex's memory/audit, including failures.
      if (!isAiRequest) {
        runtime.store.log('api.error', known ? message : 'internal failure')
        await runtime.store.save().catch(() => {})
      }
      const status = management ? management.code === 'NOT_FOUND' ? 404 : ['CONFLICT', 'TEST_BUSY', 'CATALOG_BUSY', 'CATALOG_CHANGED'].includes(management.code) ? 409 : ['STORE_FAILED', 'KEY_UNAVAILABLE', 'DECRYPT_FAILED'].includes(management.code) ? 503 : 400
        : error instanceof AgentBusyError ? 409
          : known ? (error as { status?: number }).status ?? 400 : 500
      if (!res.headersSent) send(res, status, { error: message, ...(management ? { code: management.code } : {}) })
      else res.end()
    }
  })
  server.requestTimeout = 15000
  server.headersTimeout = 15000
  server.maxConnections = 32
  return server
}
