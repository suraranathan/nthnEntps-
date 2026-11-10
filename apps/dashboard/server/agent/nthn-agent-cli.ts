import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ConnectionManager } from '../ai/connection-manager.ts'
import { CatalogService } from '../ai/catalog-service.ts'
import { VerificationService } from '../ai/verification-service.ts'
import { ManagementError } from '../ai/management-types.ts'
import { jefCanUse, jefProbeCapabilities, jefTransportSupportsTools } from '../ai/jef-model-policy.ts'
import { selectionConnection, type SavedSelection } from '../ai/nthn-cli-state.ts'
import type { CatalogEntry, ModelRoute } from '../ai/contracts.ts'
import { AlexAgent, type AgentEvent } from './agent.ts'
import { ResolvedRouteGateway } from './gateway.ts'
import { AgentChatStore } from './store.ts'
import { PermissionError } from './permissions.ts'
import { mobileAgentProgress, mobileAgentSnapshot } from './nthn-agent-mobile.ts'
import { chooseMobileWorkspace, listMobileProjects, loadMobileWorkspace } from './mobile-workspace.ts'

const appRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)))
const providerDirectory = resolve(appRoot, '.local/ai')
const agentDirectory = resolve(appRoot, '.local/agent')
const selectedPath = join(providerDirectory, 'selected-route.json')
const home = resolve(process.env.NTHN_AGENT_WORKSPACE || process.env.HOME || join(appRoot, 'workspace'))
const help = `nthn Jef coding agent
  nthn-agent state
  nthn-agent chat < request.json
  nthn-agent chat-stream < request.json
  nthn-agent new
  nthn-agent workspace < request.json
  nthn-agent approve < request.json
  nthn-agent approve-stream < request.json
Chat JSON: {"text":"...","conversationId":"optional"}
Workspace JSON: {"path":"project-folder"} or {"path":"."} for Linux home
Approval JSON: {"conversationId":"...","approvalId":"...","approved":true}`

function input(): Record<string, unknown> {
  if (process.stdin.isTTY) throw new ManagementError('INVALID_INPUT')
  const raw = readFileSync(0)
  if (raw.length > 32_000) throw new ManagementError('INVALID_INPUT')
  try {
    const value: unknown = JSON.parse(raw.toString('utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object required')
    return value as Record<string, unknown>
  } catch { throw new ManagementError('INVALID_INPUT') }
}

function selected(): SavedSelection | null {
  if (!existsSync(selectedPath)) return null
  try {
    const value = JSON.parse(readFileSync(selectedPath, 'utf8')) as Record<string, unknown>
    if (typeof value.routeId !== 'string') return null
    return {
      routeId: value.routeId,
      modelId: typeof value.modelId === 'string' ? value.modelId : null,
      ...(typeof value.connectionId === 'string' ? { connectionId: value.connectionId } : {}),
    }
  } catch { return null }
}

function saveSelected(route: ModelRoute): void {
  const temporary = `${selectedPath}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify({ routeId: route.id, modelId: route.ref.nativeModelId, connectionId: route.ref.connectionId }), { mode: 0o600, flag: 'wx' })
  renameSync(temporary, selectedPath)
}

function rank(entry: CatalogEntry): number {
  const value = `${entry.route.model.displayName} ${entry.route.ref.nativeModelId}`.toLowerCase()
  if (/\b(code|coder|coding|devstral)\b/.test(value)) return 0
  if (/\b(reason|thinking|opus|sonnet|gpt|gemini|deepseek|qwen)\b/.test(value)) return 1
  return 2
}

let manager: ConnectionManager | undefined
let catalog: CatalogService | undefined
let verification: VerificationService | undefined

async function resolveRoute(excluded = new Set<string>()): Promise<ModelRoute> {
  if (!manager || !catalog || !verification) throw new ManagementError('REQUEST_FAILED')
  const accounts = manager.list().filter(account => account.enabled && (account.credentials.state === 'configured' || account.credentials.state === 'not-required'))
  if (!accounts.length) throw new ManagementError('CREDENTIAL_REQUIRED')
  const saved = selected()
  const savedEntry = saved ? await catalog.getRoute(saved.routeId) : null
  if (savedEntry && !excluded.has(savedEntry.route.id) && selectionConnection(saved, savedEntry, accounts) && jefTransportSupportsTools(savedEntry.route.providerId)) {
    const prior = verification.store.latest(savedEntry.route.id)
    const current = prior?.connectionRevision === savedEntry.route.connectionRevision && Date.now() - Date.parse(prior.checkedAt) < 86_400_000
    if (current && jefCanUse(prior)) return savedEntry.route
    const checked = await verification.verify(savedEntry.route.id, jefProbeCapabilities)
    if (jefCanUse(checked)) return savedEntry.route
  }

  const refreshed: string[] = []
  let lastError = 'MODEL_UNAVAILABLE'
  for (const account of accounts) {
    const result = await catalog.refresh(account.id)
    if (result.errorCode) lastError = result.errorCode
    else refreshed.push(account.id)
  }
  if (!refreshed.length) throw new ManagementError(lastError)
  const candidates: CatalogEntry[] = []
  let cursor: string | undefined
  do {
    const page = await catalog.search({ connectionIds: refreshed, outputModality: 'text', pageSize: 100, ...(cursor ? { cursor } : {}) })
    candidates.push(...page.entries.filter(entry => !excluded.has(entry.route.id) && entry.route.lifecycle === 'active' && entry.route.access.state !== 'unavailable' && jefTransportSupportsTools(entry.route.providerId) && entry.route.model.capabilities.tools !== 'unsupported'))
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  candidates.sort((left, right) => rank(left) - rank(right) || left.route.ref.nativeModelId.localeCompare(right.route.ref.nativeModelId))
  for (const candidate of candidates) {
    const prior = verification.store.latest(candidate.route.id)
    const current = prior?.connectionRevision === candidate.route.connectionRevision && Date.now() - Date.parse(prior.checkedAt) < 86_400_000
    const result = current && jefCanUse(prior) ? prior : await verification.verify(candidate.route.id, jefProbeCapabilities)
    if (!jefCanUse(result)) continue
    saveSelected(candidate.route)
    return candidate.route
  }
  throw new ManagementError('MODEL_UNAVAILABLE')
}

async function main(): Promise<void> {
  const [command = 'help', ...extra] = process.argv.slice(2)
  if (extra.length || !['help', 'state', 'chat', 'chat-stream', 'new', 'workspace', 'approve', 'approve-stream'].includes(command)) throw new ManagementError('INVALID_INPUT')
  if (command === 'help') { console.log(help); return }

  let choice = loadMobileWorkspace(home, agentDirectory)
  if (command === 'workspace') {
    const body = input()
    if (typeof body.path !== 'string') throw new ManagementError('INVALID_INPUT')
    choice = chooseMobileWorkspace(home, agentDirectory, body.path)
  }

  manager = new ConnectionManager(providerDirectory)
  catalog = new CatalogService(manager)
  verification = new VerificationService(manager, catalog)
  const saved = selected()
  const gateway = new ResolvedRouteGateway(manager, resolveRoute, saved?.modelId ? { provider: 'configured', model: saved.modelId, transport: 'streaming' } : null)
  const store = new AgentChatStore(choice.storeDirectory)
  const agent = new AlexAgent({
    store, gateway, workspace: choice.workspace, name: 'Jef',
    writablePrefixes: ['.'],
    deniedSegments: ['.local', '.termux', '.ssh', '.gnupg', '.npm', '.npm-cache', '.cache'],
    protectedPaths: ['provider vault', 'credentials', 'Android app files outside Linux home'],
    taskRoot: '.',
    requireCommandApproval: true,
    sandboxCommands: true,
  })
  await agent.load()
  const events: AgentEvent[] = []
  const streaming = command === 'chat-stream' || command === 'approve-stream'
  const emit = (event: AgentEvent): void => {
    if (!streaming) { events.push(event); return }
    const progress = mobileAgentProgress(event)
    if (progress) console.log(JSON.stringify({ progress }))
  }
  if (command === 'new') {
    await agent.newConversation()
  } else if (command === 'chat' || command === 'chat-stream') {
    const body = input()
    if (typeof body.text !== 'string') throw new ManagementError('INVALID_INPUT')
    let conversationId = typeof body.conversationId === 'string' ? body.conversationId : agent.state().activeId
    if (!conversationId || !agent.conversation(conversationId)) conversationId = (await agent.newConversation()).id
    await agent.run(conversationId, body.text, emit)
  } else if (command === 'approve' || command === 'approve-stream') {
    const body = input()
    if (typeof body.conversationId !== 'string' || typeof body.approvalId !== 'string' || typeof body.approved !== 'boolean') throw new ManagementError('INVALID_INPUT')
    await agent.approve(body.conversationId, body.approvalId, body.approved, emit)
  }
  console.log(JSON.stringify({ snapshot: {
    ...mobileAgentSnapshot(agent.state()),
    workspaceRelative: choice.relative,
    projects: listMobileProjects(home),
  }, events }))
}

try { await main() }
catch (error) {
  const code = error instanceof ManagementError || error instanceof PermissionError ? error.code : 'REQUEST_FAILED'
  const message = error instanceof Error ? error.message : 'Jef agent request failed.'
  console.error(JSON.stringify({ code, message }))
  process.exitCode = 1
} finally {
  verification?.close()
  catalog?.close()
  manager?.close()
}
