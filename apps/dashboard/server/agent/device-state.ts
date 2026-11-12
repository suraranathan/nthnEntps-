import { lstat, readFile } from 'node:fs/promises'

export async function readNativeDeviceContext(path: string): Promise<Record<string, unknown>> {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size < 10 || info.size > 64_000) throw new Error('NTHN device context is unavailable.')
  const value: unknown = JSON.parse(await readFile(path, 'utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('NTHN device context is invalid.')
  const state = value as Record<string, unknown>
  if (!['camera', 'file', 'location', 'speech'].includes(String(state.kind)) ||
    typeof state.observedAt !== 'string' || !Number.isFinite(Date.parse(state.observedAt))) throw new Error('NTHN device context is invalid.')
  return state
}
