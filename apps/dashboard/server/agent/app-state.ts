import { lstat, readFile } from 'node:fs/promises'

export interface NativeDashboardState {
  title: string
  messageCount: number
  pendingApproval: boolean
  provider: string | null
  model: string | null
  workspace: string
}

export interface NativeAppScreen { screen: 'home' | 'ai' | 'terminal' | 'files' | 'settings'; updatedAt: string; dashboard?: NativeDashboardState }

function nullableText(value: unknown, max: number): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) throw new Error('NTHN dashboard state is invalid.')
  return value
}

export async function readNativeAppScreen(path: string): Promise<NativeAppScreen> {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size > 8192 || info.size < 10) throw new Error('NTHN app screen state is unavailable.')
  const value: unknown = JSON.parse(await readFile(path, 'utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('NTHN app screen state is invalid.')
  const state = value as Record<string, unknown>
  if (!['home', 'ai', 'terminal', 'files', 'settings'].includes(String(state.screen)) ||
    typeof state.updatedAt !== 'string' || !Number.isFinite(Date.parse(state.updatedAt))) throw new Error('NTHN app screen state is invalid.')
  let dashboard: NativeDashboardState | undefined
  if (state.dashboard !== undefined) {
    if (state.screen !== 'ai' || !state.dashboard || typeof state.dashboard !== 'object' || Array.isArray(state.dashboard)) throw new Error('NTHN dashboard state is invalid.')
    const value = state.dashboard as Record<string, unknown>
    const title = nullableText(value.title, 200), provider = nullableText(value.provider, 200), model = nullableText(value.model, 500), workspace = nullableText(value.workspace, 500)
    if (title === null || workspace === null || !Number.isInteger(value.messageCount) || Number(value.messageCount) < 0 || Number(value.messageCount) > 100_000 || typeof value.pendingApproval !== 'boolean') throw new Error('NTHN dashboard state is invalid.')
    dashboard = { title, messageCount: Number(value.messageCount), pendingApproval: value.pendingApproval, provider, model, workspace }
  }
  return { screen: state.screen as NativeAppScreen['screen'], updatedAt: state.updatedAt, ...(dashboard ? { dashboard } : {}) }
}
