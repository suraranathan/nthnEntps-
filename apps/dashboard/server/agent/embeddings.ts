import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { pinEndpoint, requestPinnedJson, type ProbeTransport } from '../ai/endpoint-policy.ts'
import type { EmbeddingProvider } from './memory-db.ts'
import type { CredentialVault } from '../ai/credential-vault.ts'

export type EmbeddingConfig = { kind: 'ollama'; model: string } | { kind: 'openai'; model: string; apiKey: string }

export function validateEmbeddingConfig(value: unknown): EmbeddingConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid embedding configuration.')
  const data = value as Record<string, unknown>
  if (typeof data.model !== 'string' || !/^[A-Za-z0-9._:/-]{1,100}$/.test(data.model)) throw new Error('Invalid embedding model.')
  if (data.kind === 'ollama') return { kind: 'ollama', model: data.model }
  if (data.kind === 'openai' && typeof data.apiKey === 'string' && data.apiKey.length >= 8 && data.apiKey.length <= 500 && !/[\r\n]/.test(data.apiKey)) {
    return { kind: 'openai', model: data.model, apiKey: data.apiKey }
  }
  throw new Error('Invalid embedding configuration.')
}

export function loadEmbeddingConfig(file: string, vault: CredentialVault): EmbeddingConfig | undefined {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    return validateEmbeddingConfig(raw.kind === 'openai' ? { kind: 'openai', model: raw.model, apiKey: vault.open(String(raw.cipher), 'jef-embedding') } : raw)
  }
  catch (error) {
    if (existsSync(file)) throw new Error('Saved embedding configuration is invalid; refusing to use it.', { cause: error })
    return undefined
  }
}

export async function saveEmbeddingConfig(file: string, value: unknown, vault: CredentialVault): Promise<{ kind: EmbeddingConfig['kind']; model: string; configured: true }> {
  const config = validateEmbeddingConfig(value)
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${randomUUID()}.tmp`
  const stored = config.kind === 'openai' ? { kind: 'openai', model: config.model, cipher: vault.seal(config.apiKey, 'jef-embedding') } : config
  await writeFile(temporary, JSON.stringify(stored), { mode: 0o600, flag: 'wx' })
  await rename(temporary, file)
  return { kind: config.kind, model: config.model, configured: true }
}

export class EmbeddingService implements EmbeddingProvider {
  private readonly config: EmbeddingConfig
  private readonly request: ProbeTransport
  private readonly pin: typeof pinEndpoint

  constructor(config: EmbeddingConfig, dependencies: { request?: ProbeTransport; pin?: typeof pinEndpoint } = {}) {
    this.config = config
    this.request = dependencies.request ?? requestPinnedJson
    this.pin = dependencies.pin ?? pinEndpoint
  }

  async embed(text: string): Promise<number[]> {
    if (!text || text.length > 8000) throw new Error('Embedding input must contain 1 to 8000 characters.')
    const local = this.config.kind === 'ollama'
    const endpoint = await this.pin(local ? 'http://127.0.0.1:11434' : 'https://api.openai.com/v1', local ? 'loopback' : 'public', local ? 'ollama' : 'openai')
    const result = await this.request(endpoint, local ? '/api/embed' : '/embeddings', local ? null : this.config.apiKey, {
      maxBytes: 256_000,
      body: local ? { model: this.config.model, input: text } : { model: this.config.model, input: text },
    })
    if (result.status !== 200) throw new Error(`Embedding provider failed (HTTP ${result.status}).`)
    const body = result.body as Record<string, any> | null
    const value = local ? body?.embeddings?.[0] : body?.data?.[0]?.embedding
    if (!Array.isArray(value) || !value.length || value.length > 4096 || value.some(item => typeof item !== 'number' || !Number.isFinite(item))) {
      throw new Error('Embedding provider returned an invalid vector.')
    }
    return value as number[]
  }
}
