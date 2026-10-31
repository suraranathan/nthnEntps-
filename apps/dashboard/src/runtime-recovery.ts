export type RecoveryState = 'connecting' | 'connected' | 'reconnecting' | 'offline'

type RecoveryOptions = {
  retryDelays?: readonly number[]
  healthyInterval?: number
  offlineInterval?: number
}

/** One request at a time; retries are finite and timers belong to this instance. */
export class RuntimeRecovery {
  private timer: ReturnType<typeof setTimeout> | undefined
  private active: Promise<void> | undefined
  private abort: AbortController | undefined
  private failures = 0
  private stopped = false
  private state: RecoveryState = 'connecting'
  private readonly delays: readonly number[]
  private readonly healthyInterval: number
  private readonly offlineInterval: number
  private readonly request: (signal: AbortSignal) => Promise<void>
  private readonly report: (state: RecoveryState, error?: unknown) => void

  constructor(
    request: (signal: AbortSignal) => Promise<void>,
    report: (state: RecoveryState, error?: unknown) => void,
    options: RecoveryOptions = {},
  ) {
    this.request = request
    this.report = report
    this.delays = options.retryDelays ?? [1000, 2000, 4000, 8000]
    this.healthyInterval = options.healthyInterval ?? 0
    this.offlineInterval = options.offlineInterval ?? 0
  }

  refresh(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    if (this.active) return this.active
    this.clearTimer()
    this.failures = 0
    return this.run()
  }

  private run(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    const abort = new AbortController()
    this.abort = abort
    if (this.state !== 'connected') {
      this.state = this.failures || this.state === 'offline' ? 'reconnecting' : 'connecting'
      this.report(this.state)
    }
    const work = Promise.resolve().then(() => this.request(abort.signal)).then(() => {
      if (this.stopped || abort.signal.aborted) return
      this.failures = 0
      this.state = 'connected'
      this.report('connected')
      if (this.healthyInterval) this.schedule(this.healthyInterval)
    }, error => {
      if (this.stopped || abort.signal.aborted) return
      if (this.failures < this.delays.length) {
        const delay = this.delays[this.failures++]
        this.state = 'reconnecting'
        this.report('reconnecting', error)
        this.schedule(delay)
      } else {
        this.state = 'offline'
        this.report('offline', error)
        if (this.offlineInterval) this.schedule(this.offlineInterval)
      }
      throw error
    }).finally(() => {
      if (this.abort === abort) this.abort = undefined
      if (this.active === work) this.active = undefined
    })
    this.active = work
    return work
  }

  private schedule(delay: number) {
    this.clearTimer()
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.run().catch(() => {})
    }, delay)
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }

  stop() {
    this.stopped = true
    this.clearTimer()
    this.abort?.abort()
  }
}
