import { createHash } from 'node:crypto'
import { lstat, readdir, readFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'

const SKIP_DIRS = new Set(['.git', '.local', '.ssh', '.gnupg', '.npm', '.cache', '.artifacts', '.bootstrap-chunk-transfer', '.bootstrap-transfer', 'node_modules', 'dist', 'build'])
const SECRET_NAMES = /^(?:\.env(?:\..*)?|credentials?\.(?:json|ya?ml)|secrets?\.(?:json|ya?ml|toml)|.*\.(?:pem|key|p12|pfx))$/i
const MAX_FILES = 5000
const MAX_BYTES = 50_000_000

export interface SourceManifest {
  version: string
  files: Array<{ path: string; bytes: number; sha256: string }>
  rootSha256: string
  totalBytes: number
  buildStatus: 'not-run'
}

export async function createSourceManifest(workspace: string): Promise<SourceManifest> {
  const root = resolve(workspace)
  const version = (await readFile(join(root, 'apps/nthn/VERSION'), 'utf8')).trim()
  if (!/^\d+(?:\.\d+){0,2}$/.test(version)) throw new Error('NTHN source version is missing or invalid.')
  await lstat(join(root, 'apps/dashboard/server/agent/agent.ts'))
  const files: SourceManifest['files'] = []
  let totalBytes = 0
  async function walk(directory: string): Promise<void> {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (SKIP_DIRS.has(entry.name)) continue
      const path = join(directory, entry.name)
      const rel = relative(root, path)
      if (rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('Source path escapes workspace.')
      if (entry.isSymbolicLink()) throw new Error(`Source symlink is not allowed: ${rel}`)
      if (entry.isDirectory()) { await walk(path); continue }
      if (!entry.isFile() || SECRET_NAMES.test(entry.name)) continue
      const info = await lstat(path)
      totalBytes += info.size
      if (files.length + 1 > MAX_FILES || totalBytes > MAX_BYTES) throw new Error('Source exceeds manifest limits.')
      const digest = createHash('sha256').update(await readFile(path)).digest('hex')
      files.push({ path: rel.split(sep).join('/'), bytes: info.size, sha256: digest })
    }
  }
  await walk(root)
  files.sort((a, b) => a.path.localeCompare(b.path))
  const rootSha256 = createHash('sha256').update(files.map(file => `${file.path}\0${file.sha256}\n`).join('')).digest('hex')
  return { version, files, rootSha256, totalBytes, buildStatus: 'not-run' }
}
