import { useCallback, useRef, useState } from 'react'
import type { JefAction, JefSnapshot } from './jef-contract'
import { useRuntimeRecovery } from './useRuntimeRecovery'

const recoveryOptions = { healthyInterval: 5000, offlineInterval: 30000 }

export function useJef() {
  const [snapshot, setSnapshot] = useState<JefSnapshot | null>(null)
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const csrf = useRef('')
  const active = useRef(false)
  const recovery = useRuntimeRecovery(async signal => {
    const response = await fetch('/api/jef', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) })
    if (!response.ok) throw new Error('Local agent server is unreachable. Reconnecting…')
    const data = await response.json() as JefSnapshot
    if (!data.identity || !Array.isArray(data.messages)) throw new Error('Agent server returned an invalid response.')
    return data
  }, data => { csrf.current = data.csrf; setSnapshot(data) }, recoveryOptions)
  const send = useCallback(async (action: JefAction) => {
    if (active.current) return false
    active.current = true; setPending(true); setError('')
    try {
      if (!csrf.current) throw new Error('Connect to the local agent server first.')
      const response = await fetch('/api/jef', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Jef-CSRF': csrf.current }, body: JSON.stringify(action), signal: AbortSignal.timeout(135000) })
      const data = await response.json()
      if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : 'Agent request failed.')
      csrf.current = data.csrf; setSnapshot(data)
      return true
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Agent request failed.'); await recovery.refresh().catch(() => {})
      return false
    } finally { active.current = false; setPending(false) }
  }, [recovery.refresh])
  const status = recovery.state === 'connected' ? snapshot?.status ?? 'offline' : recovery.state === 'offline' ? 'offline' : 'reconnecting'
  const connectionError = recovery.state === 'reconnecting' ? `Reconnecting to the local dashboard… ${recovery.error}` : recovery.state === 'offline' ? `Local dashboard is offline. ${recovery.error}` : ''
  return { snapshot, error: connectionError || error, pending, send, refresh: () => { setError(''); return recovery.refresh() }, status }
}
export type JefClient = ReturnType<typeof useJef>
