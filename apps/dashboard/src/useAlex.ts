import { useCallback, useEffect, useRef, useState } from 'react'
import type { AlexAction, AlexSnapshot } from './alex-contract'

export function useAlex() {
  const [snapshot, setSnapshot] = useState<AlexSnapshot | null>(null)
  const [error, setError] = useState('')
  const [connectionError, setConnectionError] = useState('')
  const [offline, setOffline] = useState(false)
  const [pending, setPending] = useState(false)
  const csrf = useRef('')
  const active = useRef(false)
  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch('/api/alex', { credentials: 'same-origin', cache: 'no-store', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000) })
      if (!response.ok) throw new Error('Agent server unavailable. Start the dashboard with npm run dev or npm run start.')
      const data = await response.json() as AlexSnapshot
      if (!data.identity || !Array.isArray(data.messages)) throw new Error('Agent server returned an invalid response.')
      csrf.current = data.csrf; setSnapshot(data); setOffline(false); setConnectionError('')
    } catch (cause) {
      if (signal?.aborted) return
      setOffline(true)
      setConnectionError(cause instanceof Error ? cause.message : 'Cannot reach the local agent server.')
    }
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    void refresh(controller.signal)
    const timer = window.setInterval(() => { void refresh(controller.signal) }, 5000)
    return () => { controller.abort(); window.clearInterval(timer) }
  }, [refresh])
  const send = useCallback(async (action: AlexAction) => {
    if (active.current) return false
    active.current = true; setPending(true); setError('')
    try {
      if (!csrf.current) throw new Error('Connect to the local agent server first.')
      const response = await fetch('/api/alex', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Alex-CSRF': csrf.current }, body: JSON.stringify(action), signal: AbortSignal.timeout(135000) })
      const data = await response.json()
      if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : 'Agent request failed.')
      csrf.current = data.csrf; setSnapshot(data); setOffline(false)
      return true
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Agent request failed.'); await refresh()
      return false
    } finally { active.current = false; setPending(false) }
  }, [refresh])
  return { snapshot, error: connectionError || error, pending, send, refresh: () => { setError(''); return refresh() }, status: offline ? 'offline' as const : snapshot?.status ?? 'offline' as const }
}
export type AlexClient = ReturnType<typeof useAlex>
