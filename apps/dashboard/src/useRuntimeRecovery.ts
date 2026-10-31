import { useCallback, useEffect, useRef, useState } from 'react'
import { RuntimeRecovery, type RecoveryState } from './runtime-recovery'

type Options = { healthyInterval?: number; offlineInterval?: number }

export function useRuntimeRecovery<T>(
  request: (signal: AbortSignal) => Promise<T>,
  onData: (data: T) => void,
  options: Options = {},
) {
  const latest = useRef({ request, onData })
  latest.current = { request, onData }
  const controller = useRef<RuntimeRecovery | null>(null)
  const [state, setState] = useState<RecoveryState>('connecting')
  const [error, setError] = useState('')
  const refresh = useCallback(() => controller.current?.refresh() ?? Promise.resolve(), [])

  useEffect(() => {
    const recovery = new RuntimeRecovery(async signal => {
      const data = await latest.current.request(signal)
      if (!signal.aborted) latest.current.onData(data)
    }, (next, reason) => {
      setState(next)
      setError(reason instanceof Error ? reason.message : reason ? 'Local dashboard backend is unreachable.' : '')
    }, options)
    controller.current = recovery
    void recovery.refresh().catch(() => {})

    let lastResume = Date.now()
    const resume = () => {
      if (document.visibilityState === 'hidden') return
      const now = Date.now()
      if (now - lastResume < 750) return
      lastResume = now
      void recovery.refresh().catch(() => {})
    }
    window.addEventListener('nthnentps:resume', resume)
    window.addEventListener('pageshow', resume)
    window.addEventListener('focus', resume)
    window.addEventListener('online', resume)
    document.addEventListener('visibilitychange', resume)
    return () => {
      recovery.stop()
      controller.current = null
      window.removeEventListener('nthnentps:resume', resume)
      window.removeEventListener('pageshow', resume)
      window.removeEventListener('focus', resume)
      window.removeEventListener('online', resume)
      document.removeEventListener('visibilitychange', resume)
    }
  // Options are fixed for each mounted data source.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return { refresh, state, error }
}
