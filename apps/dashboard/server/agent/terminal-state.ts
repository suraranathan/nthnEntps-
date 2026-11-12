import { lstat, readFile } from 'node:fs/promises'

export interface NativeTerminalState {
  title: string
  cwd: string | null
  running: boolean
  transcript: string
  observedAt: string
}

export async function readNativeTerminalState(path: string): Promise<NativeTerminalState> {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size < 10 || info.size > 64_000) throw new Error('NTHN terminal state is unavailable.')
  const value: unknown = JSON.parse(await readFile(path, 'utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('NTHN terminal state is invalid.')
  const state = value as Record<string, unknown>
  if (typeof state.title !== 'string' || state.title.length > 512 ||
    !(state.cwd === null || typeof state.cwd === 'string') || String(state.cwd ?? '').length > 4096 ||
    typeof state.running !== 'boolean' || typeof state.transcript !== 'string' || state.transcript.length > 16_384 ||
    typeof state.observedAt !== 'string' || !Number.isFinite(Date.parse(state.observedAt))) throw new Error('NTHN terminal state is invalid.')
  return { title: state.title, cwd: state.cwd as string | null, running: state.running, transcript: state.transcript, observedAt: state.observedAt }
}
