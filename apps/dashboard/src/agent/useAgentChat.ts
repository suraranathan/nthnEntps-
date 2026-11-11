import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentEvent, AgentMessage, AgentState, Conversation, ToolCallRecord } from './types'

export interface PendingApproval {
  conversationId: string
  approvalId: string
  call: ToolCallRecord
}

function mergeCall(message: AgentMessage, call: ToolCallRecord): AgentMessage {
  const calls = message.toolCalls ? [...message.toolCalls] : []
  const index = calls.findIndex(item => item.id === call.id)
  if (index === -1) calls.push(call)
  else calls[index] = call
  return { ...message, toolCalls: calls }
}

function patchMessage(conversation: Conversation, messageId: string, patch: (message: AgentMessage) => AgentMessage): Conversation {
  return { ...conversation, messages: conversation.messages.map(message => message.id === messageId ? patch(message) : message) }
}

export function useAgentChat() {
  const [state, setState] = useState<AgentState | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null)
  const csrf = useRef('')
  const abortRef = useRef<AbortController | null>(null)

  const load = useCallback(async () => {
    const response = await fetch('/api/agent', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(10_000) })
    if (!response.ok) throw new Error('The local Jef agent server is unreachable.')
    const data = await response.json() as AgentState
    if (!Array.isArray(data.conversations)) throw new Error('The agent server returned an invalid response.')
    if (typeof data.csrf === 'string') csrf.current = data.csrf
    setState(data)
    return data
  }, [])

  useEffect(() => {
    load().catch(cause => setError(cause instanceof Error ? cause.message : 'Could not load Jef.'))
  }, [load])

  const post = useCallback(async (path: string, body: Record<string, unknown>) => {
    if (!csrf.current) await load()
    const response = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Jef-CSRF': csrf.current },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    })
    const data = await response.json().catch(() => ({})) as Record<string, unknown>
    if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : 'Agent request failed.')
    return data
  }, [load])

  const applyEvent = useCallback((event: AgentEvent, conversationId: string) => {
    setState(previous => {
      if (!previous) return previous
      const active = previous.active
      if (!active) return previous
      if (event.type === 'start') {
        if (active.messages.some(message => message.id === event.messageId)) return previous
        const message: AgentMessage = { id: event.messageId, role: 'assistant', content: '', createdAt: new Date().toISOString(), status: 'streaming', toolCalls: [] }
        return { ...previous, active: { ...active, messages: [...active.messages, message] } }
      }
      if (event.type === 'delta') {
        return { ...previous, active: patchMessage(active, event.messageId, message => ({ ...message, content: message.content + event.text, status: 'streaming' })) }
      }
      if (event.type === 'decision') {
        return { ...previous, active: patchMessage(active, event.messageId, message => ({ ...message, decision: event.decision })) }
      }
      if (event.type === 'tool' || event.type === 'tool-output' || event.type === 'approval') {
        return { ...previous, active: patchMessage(active, event.messageId, message => mergeCall(message, event.call)) }
      }
      if (event.type === 'done') {
        return { ...previous, active: patchMessage(active, event.messageId, message => ({ ...message, status: 'complete' })) }
      }
      if (event.type === 'cancelled') {
        if (!event.messageId) return previous
        return { ...previous, active: patchMessage(active, event.messageId, message => ({ ...message, status: 'cancelled' })) }
      }
      return previous
    })
    if (event.type === 'approval') {
      setPendingApproval({ conversationId, approvalId: event.approvalId, call: event.call })
    }
    if (event.type === 'error') {
      setError(event.message)
    }
  }, [])

  const consume = useCallback(async (response: Response, conversationId: string) => {
    const reader = response.body?.getReader()
    if (!reader) throw new Error('The agent stream was empty.')
    const decoder = new TextDecoder()
    let buffer = ''
    const handle = (raw: string) => {
      for (const line of raw.split('\n')) {
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (!payload || payload === '[DONE]') continue
        try {
          applyEvent(JSON.parse(payload) as AgentEvent, conversationId)
        } catch {
          // Ignore malformed events; the connection remains usable.
        }
      }
    }
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let index = buffer.indexOf('\n\n')
      while (index !== -1) {
        handle(buffer.slice(0, index))
        buffer = buffer.slice(index + 2)
        index = buffer.indexOf('\n\n')
      }
    }
    if (buffer.trim()) handle(buffer)
  }, [applyEvent])

  const send = useCallback(async (text: string) => {
    if (busy) return false
    const trimmed = text.trim()
    if (!trimmed) return false
    setError('')
    setPendingApproval(null)
    let conversationId = state?.active?.id ?? state?.activeId ?? ''
    try {
      if (!conversationId) {
        const created = await post('/api/agent/new', {})
        const conversation = created.conversation as Conversation
        conversationId = conversation.id
        const createdState = created.state as AgentState | undefined
        if (createdState) setState(previous => ({ ...createdState, csrf: previous?.csrf ?? csrf.current }))
      }
      setBusy(true)
      setState(previous => {
        if (!previous?.active) return previous
        const message: AgentMessage = { id: `local-${Date.now()}`, role: 'user', content: trimmed, createdAt: new Date().toISOString(), status: 'complete' }
        return { ...previous, active: { ...previous.active, messages: [...previous.active.messages, message] } }
      })
      const controller = new AbortController()
      abortRef.current = controller
      const response = await fetch('/api/agent/chat', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Jef-CSRF': csrf.current },
        body: JSON.stringify({ conversationId, text: trimmed }),
        signal: controller.signal,
      })
      if (!response.ok) {
        const data = await response.json().catch(() => ({})) as { error?: string }
        throw new Error(data.error ?? 'Jef could not start the request.')
      }
      await consume(response, conversationId)
      await load().catch(() => undefined)
      return true
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === 'AbortError')) {
        setError(cause instanceof Error ? cause.message : 'Jef request failed.')
      }
      return false
    } finally {
      setBusy(false)
      abortRef.current = null
    }
  }, [busy, consume, load, post, state])

  const stop = useCallback(async () => {
    abortRef.current?.abort()
    const conversationId = state?.active?.id ?? state?.activeId
    if (conversationId) void post('/api/agent/cancel', { conversationId }).catch(() => undefined)
    setBusy(false)
  }, [post, state])

  const approve = useCallback(async (approved: boolean) => {
    const pending = pendingApproval
    if (!pending || busy) return
    setError('')
    setPendingApproval(null)
    setBusy(true)
    try {
      const controller = new AbortController()
      abortRef.current = controller
      const response = await fetch('/api/agent/approve', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Jef-CSRF': csrf.current },
        body: JSON.stringify({ conversationId: pending.conversationId, approvalId: pending.approvalId, approved }),
        signal: controller.signal,
      })
      if (!response.ok) {
        const data = await response.json().catch(() => ({})) as { error?: string }
        throw new Error(data.error ?? 'The approval request failed.')
      }
      await consume(response, pending.conversationId)
      await load().catch(() => undefined)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The approval request failed.')
    } finally {
      setBusy(false)
      abortRef.current = null
    }
  }, [busy, consume, load, pendingApproval])

  const newConversation = useCallback(async () => {
    if (busy) return
    try {
      const data = await post('/api/agent/new', {})
      const conversation = data.conversation as Conversation
      setState(previous => previous ? { ...previous, active: conversation, activeId: conversation.id, conversations: [{ id: conversation.id, title: conversation.title, createdAt: conversation.createdAt, updatedAt: conversation.updatedAt, messageCount: 0 }, ...previous.conversations.filter(item => item.id !== conversation.id)] } : previous)
      setPendingApproval(null)
      setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not start a new conversation.')
    }
  }, [busy, post])

  const selectConversation = useCallback(async (id: string) => {
    if (busy || id === state?.active?.id) return
    try {
      const data = await post('/api/agent/select', { conversationId: id })
      setState(previous => previous ? { ...(data as unknown as AgentState), csrf: previous.csrf } : data as unknown as AgentState)
      setPendingApproval(null)
      setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not open that conversation.')
    }
  }, [busy, post, state])

  const removeConversation = useCallback(async (id: string) => {
    if (busy) return
    try {
      const data = await post('/api/agent/remove', { conversationId: id })
      setState(previous => previous ? { ...(data as unknown as AgentState), csrf: previous.csrf } : data as unknown as AgentState)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not remove that conversation.')
    }
  }, [busy, post])

  return {
    state,
    error,
    busy,
    pendingApproval,
    send,
    stop,
    approve,
    newConversation,
    selectConversation,
    removeConversation,
    reload: load,
    dismissError: () => setError(''),
  }
}

export type AgentChat = ReturnType<typeof useAgentChat>
