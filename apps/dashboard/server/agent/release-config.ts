import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { CredentialVault } from '../ai/credential-vault.ts'

export interface ReleaseConfig { token: string }

export function loadReleaseConfig(file: string, vault: CredentialVault): ReleaseConfig | undefined {
  if (!existsSync(file)) return undefined
  try {
    const stored = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    if (typeof stored.cipher !== 'string') throw new Error('Invalid release token.')
    return { token: vault.open(stored.cipher, 'jef-private-release') }
  } catch { throw new Error('Saved GitHub release token is invalid; refusing to use it.') }
}

export async function saveReleaseConfig(file: string, value: unknown, vault: CredentialVault): Promise<{ configured: boolean }> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof (value as Record<string, unknown>).token !== 'string') throw new Error('Invalid release token input.')
  const token = (value as { token: string }).token.trim()
  if (!token) { await unlink(file).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }); return { configured: false } }
  if (token.length < 8 || token.length > 500 || /\s/.test(token)) throw new Error('Invalid GitHub release token.')
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify({ cipher: vault.seal(token, 'jef-private-release') }), { mode: 0o600, flag: 'wx' })
  await rename(temporary, file)
  return { configured: true }
}
