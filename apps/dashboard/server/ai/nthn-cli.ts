import { readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createInterface } from 'node:readline/promises'
import { ConnectionManager } from './connection-manager.ts'
import { CatalogService } from './catalog-service.ts'
import { VerificationService } from './verification-service.ts'
import { ManagementError } from './management-types.ts'
import { connectionAdapter } from './connection-adapters.ts'
import { connectionSummary, selectionIsCurrent } from './nthn-cli-state.ts'

const directory = resolve(fileURLToPath(new URL('../../', import.meta.url)), '.local/ai')
const selectedPath = join(directory, 'selected-route.json')
const baseUrl = 'https://openrouter.ai/api/v1'
const help = `nthn AI provider
  nthn-ai status            Connection and selected model
  nthn-ai configure         Enter an OpenRouter API key privately
  nthn-ai models            Refresh and list available text models
  nthn-ai auto-select       Verify and choose a suitable text model automatically
  nthn-ai select MODEL_ID   Verify real text inference and select model
  nthn-ai test              Test connection and selected model inference
  nthn-ai chat              Send a JSON conversation on stdin to the selected model
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

function rankForAlex(name: string, modelId: string): number {
  const value = `${name} ${modelId}`.toLowerCase()
  if (/\b(code|coder|coding|devstral)\b/.test(value)) return 0
  if (/\b(reason|thinking|opus|sonnet|gpt|gemini|deepseek|qwen)\b/.test(value)) return 1
  return 2
}

async function autoSelect(connectionId: string): Promise<{ modelId: string; routeId: string }> {
  if (!catalog || !verification || !manager) throw new ManagementError('REQUEST_FAILED')
  const refresh = await catalog.refresh(connectionId)
  if (refresh.errorCode) throw new ManagementError(refresh.errorCode)
  const candidates: import('./contracts.ts').CatalogEntry[] = []
  let cursor: string | undefined
  do {
    const page = await catalog.search({ connectionIds: [connectionId], outputModality: 'text', pageSize: 100, ...(cursor ? { cursor } : {}) })
    candidates.push(...page.entries.filter(entry => entry.route.lifecycle === 'active' && entry.route.access.state !== 'unavailable'))
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  candidates.sort((left, right) => rankForAlex(left.route.model.displayName, left.route.ref.nativeModelId) - rankForAlex(right.route.model.displayName, right.route.ref.nativeModelId)
    || left.route.ref.nativeModelId.localeCompare(right.route.ref.nativeModelId))
  for (const candidate of candidates) {
    const result = await verification.verify(candidate.route.id, ['text'])
    if (result.state !== 'verified') continue
    saveSelected(candidate.route.id, candidate.route.ref.nativeModelId)
    return { modelId: candidate.route.ref.nativeModelId, routeId: candidate.route.id }
  }
  throw new ManagementError('MODEL_UNAVAILABLE')
}

type ChatMessage = { role: 'user' | 'assistant'; content: string }

function chatInput(): ChatMessage[] {
  if (process.stdin.isTTY) throw new ManagementError('INVALID_INPUT')
  let value: unknown
  try { value = JSON.parse(readFileSync(0, 'utf8')) } catch { throw new ManagementError('INVALID_INPUT') }
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray((value as { messages?: unknown }).messages)) throw new ManagementError('INVALID_INPUT')
  const messages = (value as { messages: unknown[] }).messages
  if (messages.length < 1 || messages.length > 40) throw new ManagementError('INVALID_INPUT')
  const result: ChatMessage[] = []
  let characters = 0
  for (const raw of messages) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ManagementError('INVALID_INPUT')
    const message = raw as { role?: unknown; content?: unknown }
    if ((message.role !== 'user' && message.role !== 'assistant') || typeof message.content !== 'string' || !message.content.trim()) throw new ManagementError('INVALID_INPUT')
    characters += message.content.length
    if (message.content.length > 20_000 || characters > 60_000) throw new ManagementError('INVALID_INPUT')
    result.push({ role: message.role, content: message.content.trim() })
  }
  return result
}

async function chat(connectionId: string, routeId: string, messages: ChatMessage[]) {
  if (!catalog || !manager) throw new ManagementError('REQUEST_FAILED')
  const entry = await catalog.getRoute(routeId)
  if (!entry || entry.route.ref.connectionId !== connectionId || entry.route.lifecycle === 'removed') throw new ManagementError('MODEL_UNAVAILABLE')
  const route = entry.route
  const protocol = connectionAdapter(route.providerId).protocol
  const system = [
    'You are Alex, NTHN\'s coding and development assistant inside the com.nthn Android app.',
    'Focus only on coding, software development, vibe coding, decision support and clear communication.',
    'Be concise, explain uncertainty, and never invent command output, file contents, tests or changes.',
    'This chat can discuss and plan work. It cannot execute terminal commands or edit files from a message; direct the user to the real Terminal or Files screens when execution is needed.',
  ].join(' ')
  const turns = messages.map(message => ({ role: message.role, content: message.content }))
  const body: Record<string, unknown> = protocol === 'anthropic-messages'
    ? { model: route.ref.nativeModelId, messages: turns, system, max_tokens: 1600 }
    : protocol === 'gemini-generate-content'
      ? { model: route.ref.nativeModelId, contents: turns.map(message => ({ role: message.role === 'assistant' ? 'model' : 'user', parts: [{ text: message.content }] })), systemInstruction: { parts: [{ text: system }] }, generationConfig: { maxOutputTokens: 1600 } }
      : { model: route.ref.nativeModelId, messages: [{ role: 'system', content: system }, ...turns], stream: false, max_tokens: 1600, ...(route.providerId === 'openrouter' ? { provider: { require_parameters: true } } : {}) }
  const data = await manager.inferenceProbe(route.ref.connectionId, route.connectionRevision, body)
  const response = data as { choices?: { message?: { content?: unknown }; finish_reason?: string }[]; message?: { content?: unknown }; content?: { type?: string; text?: string }[]; candidates?: { content?: { parts?: { text?: string }[] } }[] }
  const text = protocol === 'ollama-chat' ? response.message?.content
    : protocol === 'anthropic-messages' ? response.content?.filter(part => part.type === 'text').map(part => part.text ?? '').join('')
      : protocol === 'gemini-generate-content' ? response.candidates?.[0]?.content?.parts?.map(part => part.text ?? '').join('')
        : response.choices?.[0]?.message?.content
  if (typeof text !== 'string' || !text.trim()) throw new ManagementError('REQUEST_FAILED')
  console.log(JSON.stringify({ message: text.trim().slice(0, 24_000), model: route.ref.nativeModelId }))
}

let manager: ConnectionManager | undefined
let catalog: CatalogService | undefined
let verification: VerificationService | undefined
try {
  const [command = 'help', argument, ...extra] = process.argv.slice(2)
  if (extra.length || !['help', 'status', 'configure', 'configure-stdin', 'models', 'select', 'auto-select', 'test', 'chat', 'clear-key'].includes(command)) throw new ManagementError('INVALID_INPUT')
  if (command === 'help') { console.log(help); process.exit(0) }
  manager = new ConnectionManager(directory)
  const connection = manager.list().find(item => item.providerId === 'openrouter')
  if (command === 'configure' || command === 'configure-stdin') {
    const key = command === 'configure' ? await secretPrompt() : secretStdin()
    if (!key) throw new ManagementError('INVALID_INPUT')
    const current = connection ?? manager.add({ providerId: 'openrouter', label: 'OpenRouter', baseUrl, networkPolicy: 'public', enabled: false })
    const saved = manager.setCredential(current.id, current.revision, key)
    if (existsSync(selectedPath)) unlinkSync(selectedPath)
    const active = saved.enabled ? saved : manager.setEnabled(saved.id, saved.revision, true)
    const result = await manager.test(active.id, active.revision)
    console.log(JSON.stringify({ credentials: result.connection.credentials.state, connection: result.ok ? 'connected' : result.code }))
    if (!result.ok) process.exitCode = 1
  } else if (command === 'status') {
    console.log(JSON.stringify({ connection: connectionSummary(connection), credentials: connection?.credentials.state ?? 'missing', selectedModel: selected()?.modelId ?? null }, null, 2))
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
      if (command === 'chat' || command === 'auto-select') {
        verification = new VerificationService(manager, catalog)
        let selectedRoute = selected()
        if (selectedRoute && !selectionIsCurrent(selectedRoute, await catalog.getRoute(selectedRoute.routeId), connection)) selectedRoute = null
        if (command === 'auto-select' || !selectedRoute) {
          const automatic = await autoSelect(connection.id)
          selectedRoute = { routeId: automatic.routeId, modelId: automatic.modelId }
        }
        if (command === 'auto-select') {
          console.log(JSON.stringify({ selected: selectedRoute.modelId, inference: 'verified', automatic: true }))
        } else {
          await chat(connection.id, selectedRoute.routeId, chatInput())
        }
      } else if (command === 'models') {
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
