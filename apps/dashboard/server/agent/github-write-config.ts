import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { CredentialVault } from '../ai/credential-vault.ts'

export interface GithubWriteConfig { token: string }

export function loadGithubWriteConfig(file: string, vault: CredentialVault): GithubWriteConfig | undefined {
  if (!existsSync(file)) return undefined
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    if (typeof value.cipher !== 'string') throw new Error('Invalid GitHub credential.')
    return { token: vault.open(value.cipher, 'jef-github-write') }
  } catch { throw new Error('Saved GitHub write credential cannot be opened.') }
}

export async function saveGithubWriteConfig(file: string, input: unknown, vault: CredentialVault): Promise<{ configured: boolean }> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof (input as Record<string, unknown>).token !== 'string') throw new Error('Invalid GitHub credential input.')
  const token = (input as { token: string }).token.trim()
  if (!token) { await unlink(file).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }); return { configured: false } }
  if (token.length < 8 || token.length > 500 || /\s/.test(token)) throw new Error('Invalid GitHub write credential.')
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify({ cipher: vault.seal(token, 'jef-github-write') }), { mode: 0o600, flag: 'wx' })
  await rename(temporary, file)
  return { configured: true }
}
