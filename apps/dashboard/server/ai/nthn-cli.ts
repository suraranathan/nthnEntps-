import { readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createInterface } from 'node:readline/promises'
import { ConnectionManager } from './connection-manager.ts'
import { CatalogService } from './catalog-service.ts'
import { VerificationService } from './verification-service.ts'
import { ManagementError } from './management-types.ts'

const directory = resolve(fileURLToPath(new URL('../../', import.meta.url)), '.local/ai')
const selectedPath = join(directory, 'selected-route.json')
const baseUrl = 'https://openrouter.ai/api/v1'
const help = `nthn AI provider
  nthn-ai status            Connection and selected model
  nthn-ai configure         Enter an OpenRouter API key privately
  nthn-ai models            Refresh and list available text models
  nthn-ai select MODEL_ID   Verify real text inference and select model
  nthn-ai test              Test connection and selected model inference
  nthn-ai clear-key         Remove the stored API key
The key stays in this app's encrypted private vault. Model tests may use credits.`

async function secretPrompt(): Promise<string> {
  if (!process.stdin.isTTY) throw new ManagementError('INVALID_INPUT')
  const stty = join(dirname(process.execPath), 'stty')
  execFileSync(stty, ['-echo'], { stdio: 'inherit' })
  // No output stream: readline must not echo the secret even when the TTY edits input.
  const reader = createInterface({ input: process.stdin })
  process.stdout.write('OpenRouter API key (hidden): ')
  try {
    const secret = await reader.question('')
    process.stdout.write('\n')
    return secret.trim()
  } finally {
    execFileSync(stty, ['echo'], { stdio: 'inherit' })
    reader.close()
  }
}

function secretStdin(): string {
  if (process.stdin.isTTY) throw new ManagementError('INVALID_INPUT')
  return readFileSync(0, 'utf8').trim()
}

function selected(): { routeId: string, modelId: string | null } | null {
  if (!existsSync(selectedPath)) return null
  try {
    const value = JSON.parse(readFileSync(selectedPath, 'utf8'))
    return typeof value.routeId === 'string'
      ? { routeId: value.routeId, modelId: typeof value.modelId === 'string' ? value.modelId : null }
      : null
  }
  catch { return null }
}
function saveSelected(routeId: string, modelId: string) {
  const temporary = `${selectedPath}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify({ routeId, modelId }), { mode: 0o600, flag: 'wx' })
  renameSync(temporary, selectedPath)
}

let manager: ConnectionManager | undefined
let catalog: CatalogService | undefined
let verification: VerificationService | undefined
try {
  const [command = 'help', argument, ...extra] = process.argv.slice(2)
  if (extra.length || !['help', 'status', 'configure', 'configure-stdin', 'models', 'select', 'test', 'clear-key'].includes(command)) throw new ManagementError('INVALID_INPUT')
  if (command === 'help') { console.log(help); process.exit(0) }
  manager = new ConnectionManager(directory)
  const connection = manager.list().find(item => item.providerId === 'openrouter')
  if (command === 'configure' || command === 'configure-stdin') {
    const key = command === 'configure' ? await secretPrompt() : secretStdin()
    if (!key) throw new ManagementError('INVALID_INPUT')
    const current = connection ?? manager.add({ providerId: 'openrouter', label: 'OpenRouter', baseUrl, networkPolicy: 'public', enabled: false })
    const saved = manager.setCredential(current.id, current.revision, key)
    const active = saved.enabled ? saved : manager.setEnabled(saved.id, saved.revision, true)
    const result = await manager.test(active.id, active.revision)
    console.log(JSON.stringify({ credentials: result.connection.credentials.state, connection: result.ok ? 'connected' : result.code }))
    if (!result.ok) process.exitCode = 1
  } else if (command === 'status') {
    console.log(JSON.stringify({ connection: connection?.health ?? null, credentials: connection?.credentials.state ?? 'missing', selectedModel: selected()?.modelId ?? null }, null, 2))
  } else {
    if (!connection) throw new ManagementError('CREDENTIAL_REQUIRED')
    if (command === 'clear-key') {
      manager.setCredential(connection.id, connection.revision, null)
      if (existsSync(selectedPath)) unlinkSync(selectedPath)
      console.log('OpenRouter credential removed.')
    } else if (command === 'test') {
      const result = await manager.test(connection.id, connection.revision)
      let inference: string | null = null
      const selectedRoute = selected()
      if (result.ok && selectedRoute) {
        catalog = new CatalogService(manager)
        verification = new VerificationService(manager, catalog)
        const check = await verification.verify(selectedRoute.routeId, ['text'])
        inference = check.state === 'verified' ? 'verified' : check.code
      }
      console.log(JSON.stringify({ connection: result.ok ? 'connected' : result.code, inference }))
    } else {
      catalog = new CatalogService(manager)
      if (command === 'models') {
        const refresh = await catalog.refresh(connection.id)
        if (refresh.errorCode) throw new ManagementError(refresh.errorCode)
        const page = await catalog.search({ connectionIds: [connection.id], outputModality: 'text', pageSize: 100 })
        for (const entry of page.entries) console.log(`${entry.route.ref.nativeModelId}\t${entry.route.model.displayName}\tcontext ${entry.route.model.contextTokens ?? '?'} tokens`)
        if (page.nextCursor) console.log('More models available; refine selection by exact model ID.')
      } else if (command === 'select') {
        if (!argument) throw new ManagementError('INVALID_INPUT')
        const page = await catalog.search({ connectionIds: [connection.id], search: argument, pageSize: 100 })
        const route = page.entries.find(item => item.route.ref.nativeModelId === argument)?.route
        if (!route) throw new ManagementError('MODEL_UNAVAILABLE')
        verification = new VerificationService(manager, catalog)
        const result = await verification.verify(route.id, ['text'])
        if (result.state !== 'verified') throw new ManagementError(result.code ?? 'REQUEST_FAILED')
        saveSelected(route.id, argument)
        console.log(JSON.stringify({ selected: argument, inference: 'verified', checkedAt: result.checkedAt }))
      }
    }
  }
} catch (error) {
  const failure = error instanceof ManagementError ? error : new ManagementError('REQUEST_FAILED')
  console.error(JSON.stringify({ code: failure.code, message: failure.message }))
  process.exitCode = 1
} finally {
  verification?.close(); catalog?.close(); manager?.close()
}
