import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { validatePublicUrl, type SearchConfig } from './research.ts'
import type { CredentialVault } from '../ai/credential-vault.ts'

export function validateResearchConfig(value: unknown): SearchConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid research configuration.')
  const data = value as Record<string, unknown>
  if (data.kind === 'searxng' && typeof data.endpoint === 'string') {
    const url = validatePublicUrl(data.endpoint)
    if (url.search || url.hash || url.pathname.length > 200) throw new Error('Invalid SearXNG endpoint.')
    return { kind: 'searxng', endpoint: url.href }
  }
  if (data.kind === 'brave' && typeof data.apiKey === 'string' && data.apiKey.length >= 8 && data.apiKey.length <= 500 && !/[\r\n]/.test(data.apiKey)) {
    return { kind: 'brave', apiKey: data.apiKey }
  }
  throw new Error('Invalid research configuration.')
}

export function loadResearchConfig(file: string, vault: CredentialVault): SearchConfig | undefined {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    return validateResearchConfig(raw.kind === 'brave' ? { kind: 'brave', apiKey: vault.open(String(raw.cipher), 'jef-web-search') } : raw)
  }
  catch (error) {
    if (existsSync(file)) throw new Error('Saved research configuration is invalid; refusing to use it.', { cause: error })
    return undefined
  }
}

export async function saveResearchConfig(file: string, value: unknown, vault: CredentialVault): Promise<{ kind: SearchConfig['kind']; configured: true }> {
  const config = validateResearchConfig(value)
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${randomUUID()}.tmp`
  const stored = config.kind === 'brave' ? { kind: 'brave', cipher: vault.seal(config.apiKey, 'jef-web-search') } : config
  await writeFile(temporary, JSON.stringify(stored), { mode: 0o600, flag: 'wx' })
  await rename(temporary, file)
  return { kind: config.kind, configured: true }
}
