import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ConnectionManager } from '../ai/connection-manager.ts'
import { CatalogService } from '../ai/catalog-service.ts'
import { VerificationService } from '../ai/verification-service.ts'
import { ManagementError } from '../ai/management-types.ts'
import { jefCanUse, jefProbeCapabilities, jefTransportSupportsTools } from '../ai/jef-model-policy.ts'
import { selectionConnection, type SavedSelection } from '../ai/nthn-cli-state.ts'
import type { CatalogEntry, ModelRoute } from '../ai/contracts.ts'
import { JefAgent, type AgentEvent } from './agent.ts'
import type { MemoryKind } from './memory.ts'
import { SqliteMemoryStore } from './memory-db.ts'
import { EmbeddingService, loadEmbeddingConfig, saveEmbeddingConfig } from './embeddings.ts'
import { TaskStore } from './tasks.ts'
import { loadAutonomyPolicy, saveAutonomyConfig } from './autonomy.ts'
import { compareJefCandidates, jefModelPermitted, normalizeJefPreference, type JefModelPreference } from './model-preference.ts'
import { ResolvedRouteGateway } from './gateway.ts'
import { AgentChatStore } from './store.ts'
import { PermissionError } from './permissions.ts'
import { mobileAgentProgress, mobileAgentSnapshot } from './nthn-agent-mobile.ts'
import { chooseMobileWorkspace, listMobileProjects, loadMobileWorkspace } from './mobile-workspace.ts'
import { ResearchService } from './research.ts'
import { loadResearchConfig, saveResearchConfig } from './research-config.ts'
import { CredentialVault, createPrivateFile, readPrivateFile } from '../ai/credential-vault.ts'
import { loadReleaseConfig, saveReleaseConfig } from './release-config.ts'
import { ReleaseUpdateService } from './release-update.ts'
import { loadGithubWriteConfig, saveGithubWriteConfig } from './github-write-config.ts'
import { GithubWorkflowService } from './github-workflow.ts'

const appRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)))
const providerDirectory = resolve(appRoot, '.local/ai')
const agentDirectory = resolve(appRoot, '.local/agent')
const selectedPath = join(providerDirectory, 'selected-route.json')
const preferencePath = join(agentDirectory, 'model-preference.json')
const researchPath = join(agentDirectory, 'research.json')
const embeddingPath = join(agentDirectory, 'embedding.json')
const autonomyPath = join(agentDirectory, 'autonomy.json')
const agentKeyPath = join(agentDirectory, 'master.key')
const releasePath = join(agentDirectory, 'release.json')
const githubWritePath = join(agentDirectory, 'github-write.json')
const updateDirectory = join(agentDirectory, 'updates')
const home = resolve(process.env.NTHN_AGENT_WORKSPACE || process.env.HOME || join(appRoot, 'workspace'))
const help = `nthn Jef coding agent
  nthn-agent state
  nthn-agent chat < request.json
  nthn-agent chat-stream < request.json
  nthn-agent new
  nthn-agent workspace < request.json
  nthn-agent approve < request.json
  nthn-agent approve-stream < request.json
  nthn-agent select < request.json
  nthn-agent memory-list
  nthn-agent memory-add < request.json
  nthn-agent memory-update < request.json
  nthn-agent memory-remove < request.json
  nthn-agent model-preference < request.json
  nthn-agent research-config < request.json
  nthn-agent embedding-config < request.json
  nthn-agent memory-export
  nthn-agent memory-search < request.json
  nthn-agent memory-link < request.json
  nthn-agent memory-history < request.json
  nthn-agent task-list
  nthn-agent autonomy-config < request.json
  nthn-agent release-config < request.json
  nthn-agent update-check
  nthn-agent update-download
  nthn-agent github-write-config < request.json
  nthn-agent github-dispatch < request.json
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

function modelPreference(): JefModelPreference {
  try {
    const value: unknown = JSON.parse(readFileSync(preferencePath, 'utf8'))
    return normalizeJefPreference(value)
  } catch { return 'automatic-free' }
}

function appVersion(): string {
  const installed = join(appRoot, 'version.txt')
  const source = resolve(appRoot, '../../apps/nthn/VERSION')
  const version = readFileSync(existsSync(installed) ? installed : source, 'utf8').trim()
  if (!/^\d+(?:\.\d+){0,2}$/.test(version)) throw new Error('Installed NTHN version is invalid.')
  return version
}

function selected(): SavedSelection | null {
  if (!existsSync(selectedPath)) return null
  try {
    const value = JSON.parse(readFileSync(selectedPath, 'utf8')) as Record<string, unknown>
    if (typeof value.routeId !== 'string') return null
    if (modelPreference() === 'manual-free' && value.manual !== true) return null
    if (modelPreference() === 'automatic-free' && (value.manual === true || value.preference !== 'automatic-free')) return null
    return {
      routeId: value.routeId,
      modelId: typeof value.modelId === 'string' ? value.modelId : null,
      ...(typeof value.connectionId === 'string' ? { connectionId: value.connectionId } : {}),
    }
  } catch { return null }
}

function saveSelected(route: ModelRoute): void {
  const temporary = `${selectedPath}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify({ routeId: route.id, modelId: route.ref.nativeModelId, connectionId: route.ref.connectionId, preference: modelPreference() }), { mode: 0o600, flag: 'wx' })
  renameSync(temporary, selectedPath)
}


let manager: ConnectionManager | undefined
let catalog: CatalogService | undefined
let verification: VerificationService | undefined
let mobileMemory: SqliteMemoryStore | undefined
let mobileTasks: TaskStore | undefined
let agentVault: CredentialVault | undefined

async function resolveRoute(excluded = new Set<string>()): Promise<ModelRoute> {
  if (!manager || !catalog || !verification) throw new ManagementError('REQUEST_FAILED')
  const accounts = manager.list().filter(account => account.enabled && (account.credentials.state === 'configured' || account.credentials.state === 'not-required'))
  if (!accounts.length) throw new ManagementError('CREDENTIAL_REQUIRED')
  const saved = selected()
  const savedEntry = saved ? await catalog.getRoute(saved.routeId) : null
  if (savedEntry && !excluded.has(savedEntry.route.id) && selectionConnection(saved, savedEntry, accounts) && jefTransportSupportsTools(savedEntry.route.providerId) && jefModelPermitted(savedEntry, modelPreference())) {
    const prior = verification.store.latest(savedEntry.route.id)
    const current = prior?.connectionRevision === savedEntry.route.connectionRevision && Date.now() - Date.parse(prior.checkedAt) < 86_400_000
    if (current && jefCanUse(prior)) return savedEntry.route
    const checked = await verification.verify(savedEntry.route.id, jefProbeCapabilities)
    if (jefCanUse(checked)) return savedEntry.route
  }
  if (modelPreference() === 'manual-free') throw new ManagementError('MODEL_UNAVAILABLE')

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
    candidates.push(...page.entries.filter(entry => !excluded.has(entry.route.id) && entry.route.lifecycle === 'active' && entry.route.access.state !== 'unavailable' && jefTransportSupportsTools(entry.route.providerId) && entry.route.model.capabilities.tools !== 'unsupported' && jefModelPermitted(entry, modelPreference())))
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  candidates.sort((left, right) => compareJefCandidates(left, right, modelPreference()))
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
  if (extra.length || !['help', 'state', 'chat', 'chat-stream', 'new', 'workspace', 'approve', 'approve-stream', 'select', 'memory-list', 'memory-add', 'memory-update', 'memory-remove', 'memory-export', 'memory-search', 'memory-link', 'memory-history', 'task-list', 'model-preference', 'research-config', 'embedding-config', 'autonomy-config', 'release-config', 'update-check', 'update-download', 'github-write-config', 'github-dispatch'].includes(command)) throw new ManagementError('INVALID_INPUT')
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
  mkdirSync(agentDirectory, { recursive: true, mode: 0o700 })
  if (!existsSync(agentKeyPath)) {
    if (existsSync(researchPath) || existsSync(embeddingPath) || existsSync(releasePath) || existsSync(githubWritePath)) throw new Error('Agent credential key is missing; saved credentials cannot be opened.')
    try { createPrivateFile(agentKeyPath, randomBytes(32)) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  }
  agentVault = new CredentialVault(readPrivateFile(agentKeyPath))
  const saved = selected()
  const gateway = new ResolvedRouteGateway(manager, resolveRoute, saved?.modelId ? { provider: 'configured', model: saved.modelId, transport: 'streaming' } : null)
  if (command === 'research-config') await saveResearchConfig(researchPath, input(), agentVault)
  if (command === 'embedding-config') await saveEmbeddingConfig(embeddingPath, input(), agentVault)
  if (command === 'release-config') await saveReleaseConfig(releasePath, input(), agentVault)
  if (command === 'github-write-config') await saveGithubWriteConfig(githubWritePath, input(), agentVault)
  if (command === 'autonomy-config') saveAutonomyConfig(autonomyPath, input())
  const researchConfig = loadResearchConfig(researchPath, agentVault)
  const research = new ResearchService({ ...(researchConfig ? { search: researchConfig } : {}) })
  const embeddingConfig = loadEmbeddingConfig(embeddingPath, agentVault)
  const embedding = embeddingConfig ? new EmbeddingService(embeddingConfig) : undefined
  const autonomy = loadAutonomyPolicy(autonomyPath)
  const releaseConfig = loadReleaseConfig(releasePath, agentVault)
  const githubWrite = loadGithubWriteConfig(githubWritePath, agentVault)
  if (command === 'github-dispatch') {
    const body = input()
    if (typeof body.branch !== 'string' || !githubWrite) throw new ManagementError(githubWrite ? 'INVALID_INPUT' : 'CREDENTIAL_REQUIRED')
    console.log(JSON.stringify(await new GithubWorkflowService(githubWrite.token).dispatch(body.branch, appVersion())))
    return
  }
  const updater = new ReleaseUpdateService({ ...(releaseConfig ? { token: releaseConfig.token } : {}) })
  if (command === 'update-check' || command === 'update-download') {
    const release = await updater.check(appVersion())
    if (command === 'update-check' || !release) { console.log(JSON.stringify({ release, currentVersion: appVersion(), privateTokenConfigured: !!releaseConfig })); return }
    console.log(JSON.stringify({ release, apk: await updater.download(release, updateDirectory), currentVersion: appVersion() }))
    return
  }
  const store = new AgentChatStore(choice.storeDirectory)
  const memoryScope = `project:${choice.relative}`
  const memory = new SqliteMemoryStore(join(agentDirectory, 'memories.sqlite'), join(agentDirectory, 'memories.json'), choice.workspace, embedding)
  mobileMemory = memory
  const tasks = new TaskStore(join(agentDirectory, 'tasks.sqlite'))
  mobileTasks = tasks
  const agent = new JefAgent({
    store, gateway, workspace: choice.workspace, name: 'Jef', memory, memoryScope, research, tasks, autonomy,
    appStatePath: join(agentDirectory, 'app-state.json'),
    deviceStatePath: join(agentDirectory, 'device-state.json'),
    terminalStatePath: join(agentDirectory, 'terminal-state.json'),
    writablePrefixes: ['.'],
    allowNTHNSourceWrites: choice.relative === 'nthnEntps' && existsSync(join(choice.workspace, 'apps/nthn/VERSION')) && existsSync(join(choice.workspace, 'apps/dashboard/server/agent/agent.ts')),
    deniedSegments: ['.local', '.termux', '.ssh', '.gnupg', '.npm', '.npm-cache', '.cache'],
    protectedPaths: ['provider vault', 'credentials', 'Android app files outside Linux home'],
    taskRoot: '.',
    requireCommandApproval: true,
    sandboxCommands: true,
  })
  await agent.load()
  if (command === 'chat-stream' || command === 'approve-stream') {
    process.once('SIGTERM', () => {
      const activeId = agent.state().activeId
      if (activeId) agent.cancel(activeId)
    })
  }
  const events: AgentEvent[] = []
  const streaming = command === 'chat-stream' || command === 'approve-stream'
  const emit = (event: AgentEvent): void => {
    if (!streaming) { events.push(event); return }
    const progress = mobileAgentProgress(event)
    if (progress) console.log(JSON.stringify({ progress }))
  }
  if (command === 'model-preference') {
    const body = input()
    if (body.value !== 'automatic-free' && body.value !== 'manual-free') throw new ManagementError('INVALID_INPUT')
    const temporary = `${preferencePath}.${process.pid}.tmp`
    writeFileSync(temporary, JSON.stringify(body.value), { mode: 0o600, flag: 'wx' })
    renameSync(temporary, preferencePath)
  } else if (command === 'select') {
    const body = input()
    if (typeof body.conversationId !== 'string' || !await agent.select(body.conversationId)) throw new ManagementError('INVALID_INPUT')
  } else if (command === 'memory-add') {
    const body = input()
    if (typeof body.text !== 'string' || typeof body.kind !== 'string') throw new ManagementError('INVALID_INPUT')
    await memory.add({ scope: body.scope === 'personal' ? 'personal' : memoryScope, kind: body.kind as MemoryKind, text: body.text, source: 'User', sourcePath: typeof body.sourcePath === 'string' ? body.sourcePath : undefined })
  } else if (command === 'memory-update') {
    const body = input()
    if (typeof body.id !== 'string' || !memory.list(memoryScope).some(item => item.id === body.id)) throw new ManagementError('INVALID_INPUT')
    await memory.update(body.id, { ...(typeof body.text === 'string' ? { text: body.text } : {}), ...(typeof body.pinned === 'boolean' ? { pinned: body.pinned } : {}) })
  } else if (command === 'memory-remove') {
    const body = input()
    if (typeof body.id !== 'string' || !memory.list(memoryScope).some(item => item.id === body.id)) throw new ManagementError('INVALID_INPUT')
    await memory.remove(body.id)
  } else if (command === 'memory-search') {
    const body = input()
    if (typeof body.query !== 'string') throw new ManagementError('INVALID_INPUT')
    console.log(JSON.stringify({ results: await memory.semanticRelevant(memoryScope, body.query, 20) }))
    return
  } else if (command === 'memory-export') {
    console.log(JSON.stringify({ memories: memory.export(memoryScope) }))
    return
  } else if (command === 'memory-link') {
    const body = input()
    if (typeof body.from !== 'string' || typeof body.to !== 'string' || typeof body.relation !== 'string') throw new ManagementError('INVALID_INPUT')
    const visible = new Set(memory.list(memoryScope).map(item => item.id))
    if (!visible.has(body.from) || !visible.has(body.to)) throw new ManagementError('INVALID_INPUT')
    await memory.link(body.from, body.to, body.relation)
  } else if (command === 'memory-history') {
    const body = input()
    if (typeof body.id !== 'string' || !memory.list(memoryScope).some(item => item.id === body.id)) throw new ManagementError('INVALID_INPUT')
    console.log(JSON.stringify({ history: memory.history(body.id), links: memory.links(body.id) }))
    return
  } else if (command === 'task-list') {
    console.log(JSON.stringify({ tasks: tasks.list() }))
    return
  } else if (command === 'new') {
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
    conversations: agent.state().conversations,
    ...(!['chat', 'chat-stream', 'approve', 'approve-stream'].includes(command) ? { memories: memory.list(memoryScope) } : {}),
    modelPreference: modelPreference(),
    research: { searchConfigured: research.configuredSearch, provider: researchConfig?.kind ?? null, pageRetrieval: true },
    embedding: { configured: !!embeddingConfig, provider: embeddingConfig?.kind ?? null, model: embeddingConfig?.model ?? null },
    autonomy: autonomy.snapshot(),
    task: agent.state().activeId ? tasks.latestForConversation(agent.state().activeId!) : null,
    release: { privateTokenConfigured: !!releaseConfig, installedVersion: appVersion() },
    github: { writeTokenConfigured: !!githubWrite },
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
  mobileMemory?.close()
  mobileTasks?.close()
  agentVault?.destroy()
}
