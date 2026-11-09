import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

export interface MobileWorkspace {
  workspace: string
  storeDirectory: string
  relative: string
}

function resolveChoice(home: string, stateDirectory: string, input: string): MobileWorkspace {
  if (!input || isAbsolute(input)) throw new Error('Choose a relative project folder inside Linux home.')
  const segments = input.split(/[\\/]+/)
  if (segments.some(segment => segment === '..' || (segment.startsWith('.') && segment !== '.'))) {
    throw new Error('Private and parent folders cannot be selected as a project.')
  }
  const root = realpathSync(home)
  let target: string
  try { target = realpathSync(resolve(root, input)) }
  catch { throw new Error('Project folder does not exist inside Linux home.') }
  const path = relative(root, target)
  if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) throw new Error('Project folder escapes Linux home.')
  if (path.split(sep).some(segment => segment.startsWith('.'))) throw new Error('Private folders cannot be selected as a project.')
  if (!statSync(target).isDirectory()) throw new Error('Choose a project directory.')
  const selected = path || '.'
  const storeDirectory = selected === '.' ? stateDirectory : join(stateDirectory, 'workspaces', createHash('sha256').update(selected).digest('hex').slice(0, 24))
  return { workspace: target, storeDirectory, relative: selected }
}

export function loadMobileWorkspace(home: string, storeDirectory: string): MobileWorkspace {
  let path = '.'
  try {
    const saved: unknown = JSON.parse(readFileSync(join(storeDirectory, 'workspace.json'), 'utf8'))
    if (saved && typeof saved === 'object' && !Array.isArray(saved) && typeof (saved as { path?: unknown }).path === 'string') {
      path = (saved as { path: string }).path
    }
  } catch { /* A missing or invalid selection falls back to Linux home. */ }
  try { return resolveChoice(home, storeDirectory, path) }
  catch { return resolveChoice(home, storeDirectory, '.') }
}

export function chooseMobileWorkspace(home: string, storeDirectory: string, path: string): MobileWorkspace {
  const choice = resolveChoice(home, storeDirectory, path.trim())
  mkdirSync(storeDirectory, { recursive: true, mode: 0o700 })
  const temporary = join(storeDirectory, `workspace.json.${process.pid}.tmp`)
  writeFileSync(temporary, JSON.stringify({ path: choice.relative }), { mode: 0o600, flag: 'wx' })
  renameSync(temporary, join(storeDirectory, 'workspace.json'))
  return choice
}

export function listMobileProjects(home: string): string[] {
  return readdirSync(home, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .map(entry => entry.name).sort((a, b) => a.localeCompare(b))
}
