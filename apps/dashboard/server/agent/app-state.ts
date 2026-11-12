import { lstat, readFile } from 'node:fs/promises'

export interface NativeAppScreen { screen: 'home' | 'ai' | 'terminal' | 'files' | 'settings'; updatedAt: string }

export async function readNativeAppScreen(path: string): Promise<NativeAppScreen> {
  const info = await lstat(path)
  if (!info.isFile() || info.size > 4096 || info.size < 10) throw new Error('NTHN app screen state is unavailable.')
  const value: unknown = JSON.parse(await readFile(path, 'utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('NTHN app screen state is invalid.')
  const state = value as Record<string, unknown>
  if (!['home', 'ai', 'terminal', 'files', 'settings'].includes(String(state.screen)) ||
    typeof state.updatedAt !== 'string' || !Number.isFinite(Date.parse(state.updatedAt))) throw new Error('NTHN app screen state is invalid.')
  return { screen: state.screen as NativeAppScreen['screen'], updatedAt: state.updatedAt }
}
