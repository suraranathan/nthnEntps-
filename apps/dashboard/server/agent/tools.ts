import { spawn } from 'node:child_process'
import type { MemoryKind } from './memory.ts'
import type { MemoryStoreLike } from './memory-db.ts'
import type { ResearchService } from './research.ts'
import type { TaskStore, TaskStep } from './tasks.ts'
import type { AutonomyPolicy } from './autonomy.ts'
import { inspectEnvironment, inspectTask } from './system-tools.ts'
import { createSourceManifest } from './self-development.ts'
import { readNativeAppScreen } from './app-state.ts'
import { readNativeDeviceContext } from './device-state.ts'
import { readNativeTerminalState } from './terminal-state.ts'
import type { GithubWorkflowService } from './github-workflow.ts'
import { existsSync } from 'node:fs'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, relative, resolve as resolvePath } from 'node:path'
import {
  assessCommand,
  PathPolicy,
  PermissionError,
  sanitizedEnvironment,
  type CommandAssessment,
} from './permissions.ts'
import {
  assessRisk,
  booleanDecision,
  choose,
  classify,
  estimateProbability,
  evaluateConditions,
  planWorkflow,
  prioritize,
  routeTask,
  type Evidence,
  type RiskInput,
} from './decision.ts'

export interface ToolContext {
  workspace: string
  paths: PathPolicy
  signal: AbortSignal
  timeoutMs?: number
  onOutput?: (chunk: string) => void
  taskId?: string
}

export interface ToolResult {
  ok: boolean
  summary: string
  output: string
  truncated?: boolean
  meta?: Record<string, unknown>
}

export type ToolArgumentType = 'string' | 'number' | 'boolean' | 'string[]'

export interface ToolDefinition {
  name: string
  description: string
  requiresApproval: boolean | ((args: Record<string, unknown>) => boolean)
  required: string[]
  arguments: Record<string, ToolArgumentType>
  summarize: (args: Record<string, unknown>) => string
  execute: (args: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>
}

export interface ToolRegistryOptions {
  appStatePath?: string
  deviceStatePath?: string
  terminalStatePath?: string
  githubWorkflow?: GithubWorkflowService
  installedVersion?: string
  taskRoot?: string
  requireCommandApproval?: boolean
  sandboxCommands?: boolean
  memory?: MemoryStoreLike
  memoryScope?: string
  research?: ResearchService
  tasks?: TaskStore
  autonomy?: AutonomyPolicy
}

const MAX_TOOL_OUTPUT = 200_000
const MAX_FILE_BYTES = 1_000_000
const MAX_SEARCH_RESULTS = 200

export function stableSignature(tool: string, args: Record<string, unknown>): string {
  const sort = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sort)
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sort(v)]))
    }
    return value
  }
  return `${tool}\u0000${JSON.stringify(sort(args))}`
}

function stringArg(args: Record<string, unknown>, name: string, fallback = ''): string {
  const value = args[name]
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return fallback
  throw new PermissionError('invalid-argument', `Argument "${name}" must be a string.`)
}

function numberArg(args: Record<string, unknown>, name: string, fallback: number): number {
  const value = args[name]
  if (value === undefined || value === null) return fallback
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) throw new PermissionError('invalid-argument', `Argument "${name}" must be a number.`)
  return parsed
}

function clampOutput(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_TOOL_OUTPUT) return { text, truncated: false }
  return { text: `${text.slice(0, MAX_TOOL_OUTPUT)}\n…[output truncated at ${MAX_TOOL_OUTPUT} characters]`, truncated: true }
}

interface ParsedCommand {
  program: string
  args: string[]
}

export function parseCommand(command: string): ParsedCommand {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]
    if (quote) {
      if (char === quote) quote = null
      else current += char
      continue
    }
    if (char === '"' || char === "'") { quote = char; continue }
    if (/\s/.test(char)) {
      if (current) { tokens.push(current); current = '' }
      continue
    }
    if ('|&;<>`$(){}'.includes(char)) {
      throw new PermissionError('shell-metacharacter', `Shell operators are not allowed (${char}). Run commands separately.`)
    }
    current += char
  }
  if (quote) throw new PermissionError('shell-quote', 'Unterminated quote in command.')
  if (current) tokens.push(current)
  if (tokens.length === 0) throw new PermissionError('empty-command', 'No command was supplied.')
  return { program: tokens[0], args: tokens.slice(1) }
}

export async function runProcess(
  command: string,
  context: ToolContext,
  cwd: string,
  timeoutMs = context.timeoutMs ?? 120_000,
  sandbox = false,
): Promise<ToolResult> {
  const assessment = assessCommand(command)
  if (!assessment.allowed) {
    return { ok: false, summary: assessment.reason, output: assessment.reason }
  }
  const parsed = parseCommand(command)
  if (sandbox) context.paths.assertCommandArguments(parsed.args)
  return await new Promise<ToolResult>(resolve => {
    let program = parsed.program
    let args = parsed.args
    let processCwd = cwd
    let sandboxCwd = '/'
    if (sandbox) {
      const prefix = resolvePath(process.execPath, '../..')
      const proot = join(prefix, 'bin/proot')
      if (!existsSync(proot)) {
        resolve({ ok: false, summary: 'The confined command runner (proot) is unavailable.', output: 'The app runtime is missing proot. Reopen NTHN after updating, then try again.' })
        return
      }
      const guestCwd = '/' + relative(context.workspace, cwd).split('\\').join('/')
      sandboxCwd = guestCwd
      const bindings = [prefix, '/system', '/apex', '/vendor', '/proc', '/linkerconfig'].filter(path => existsSync(path))
      program = proot
      args = ['--kill-on-exit', '-r', context.workspace]
      for (const binding of bindings) args.push('-b', `${binding}:${binding}`)
      args.push('-w', guestCwd, parsed.program.replace(/^.*\//, ''), ...parsed.args)
      processCwd = context.workspace
    }
    const environment = sanitizedEnvironment(process.env, sandbox ? { HOME: '/', TMPDIR: '/', PWD: sandboxCwd } : {})
    const child = spawn(program, args, {
      cwd: processCwd,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    })
    let output = ''
    let truncated = false
    let settled = false
    const append = (chunk: Buffer) => {
      if (truncated) return
      output += chunk.toString('utf8')
      if (output.length > MAX_TOOL_OUTPUT) {
        output = output.slice(0, MAX_TOOL_OUTPUT)
        truncated = true
      }
      context.onOutput?.(chunk.toString('utf8'))
    }
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    const finish = (result: ToolResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish({ ok: false, summary: `Command timed out after ${timeoutMs}ms.`, output: clampOutput(output).text, truncated: true })
    }, timeoutMs)
    const abort = () => {
      child.kill('SIGKILL')
      finish({ ok: false, summary: 'Command cancelled.', output: clampOutput(output).text, truncated })
    }
    context.signal.addEventListener('abort', abort, { once: true })
    child.on('error', error => finish({ ok: false, summary: `Failed to start command: ${error.message}`, output: clampOutput(output).text, truncated }))
    child.on('close', code => {
      context.signal.removeEventListener('abort', abort)
      const clamped = clampOutput(output)
      finish({
        ok: code === 0,
        summary: code === 0 ? `Command exited 0.` : `Command exited ${code ?? 'signal'}.`,
        output: clamped.text,
        truncated: clamped.truncated,
        meta: { code, command, approval: assessment },
      })
    })
  })
}

async function walkFiles(root: string, policy: PathPolicy, startRelative: string, signal: AbortSignal): Promise<string[]> {
  const start = await policy.resolveExisting(startRelative)
  const files: string[] = []
  const visit = async (directory: string) => {
    if (signal.aborted) return
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      if (signal.aborted) return
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.local') continue
      const absolute = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (relative(root, absolute).split(/[\\/]/).some(segment => ['.git', '.ssh', '.gnupg', '.local', '__pycache__'].includes(segment))) continue
        await visit(absolute)
      } else if (entry.isFile()) {
        files.push(absolute)
      }
    }
  }
  const startInfo = await stat(start)
  if (startInfo.isDirectory()) await visit(start)
  else files.push(start)
  return files
}

function toolDecision(args: Record<string, unknown>): ToolResult {
  const kind = stringArg(args, 'kind', 'choice')
  const question = stringArg(args, 'question', 'Untitled decision')
  const context = (args.context as Record<string, unknown> | undefined) ?? {}
  let envelope: unknown
  switch (kind) {
    case 'choice':
      envelope = choose(question, (args.options as never) ?? [], context)
      break
    case 'classification':
      envelope = classify(question, stringArg(args, 'text'), (args.labels as string[] | undefined) ?? [], context)
      break
    case 'priority':
      envelope = prioritize((args.items as never) ?? [], context)
      break
    case 'risk': {
      const risk = (args.input as RiskInput | undefined) ?? { action: question }
      envelope = assessRisk({ ...risk, action: risk.action || question }, context)
      break
    }
    case 'boolean':
      envelope = booleanDecision(question, (args.evidence as Evidence[] | undefined) ?? [], context)
      break
    case 'probability': {
      const prior = Number(args.prior ?? 0.5)
      envelope = estimateProbability(question, (args.evidence as Evidence[] | undefined) ?? [], prior, context)
      break
    }
    case 'conditions':
      envelope = evaluateConditions(question, (args.conditions as never) ?? [], context)
      break
    case 'routing':
      envelope = routeTask(question, context)
      break
    case 'workflow':
      envelope = planWorkflow(question, context)
      break
    default:
      throw new PermissionError('invalid-decision-kind', `Unknown decision kind: ${kind}`)
  }
  return {
    ok: true,
    summary: `Decision engine produced a structured ${kind} result. Advisory only.`,
    output: JSON.stringify(envelope, null, 2),
    meta: { decision: envelope },
  }
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>()
  private readonly autonomy?: AutonomyPolicy

  constructor(options: ToolRegistryOptions = {}) {
    this.autonomy = options.autonomy
    for (const tool of buildTools(options)) this.tools.set(tool.name, tool)
  }

  list(): { name: string; description: string; requiresApproval: boolean | 'conditional'; arguments: Record<string, ToolArgumentType> }[] {
    return [...this.tools.values()].map(tool => ({
      name: tool.name,
      description: tool.description,
      requiresApproval: typeof tool.requiresApproval === 'boolean' ? tool.requiresApproval : 'conditional',
      arguments: tool.arguments,
    }))
  }

  get(name: string): ToolDefinition {
    const tool = this.tools.get(name)
    if (!tool) throw new PermissionError('unknown-tool', `Unknown tool: ${name}`)
    return tool
  }

  needsApproval(name: string, args: Record<string, unknown>): boolean {
    const tool = this.get(name)
    if (name === 'run_command' && this.autonomy?.useCommand(stringArg(args, 'command'))) return false
    return typeof tool.requiresApproval === 'boolean' ? tool.requiresApproval : tool.requiresApproval(args)
  }

  validate(name: string, args: Record<string, unknown>): void {
    const tool = this.get(name)
    for (const required of tool.required) {
      if (args[required] === undefined || args[required] === null) {
        throw new PermissionError('invalid-argument', `Tool "${name}" requires argument "${required}".`)
      }
    }
    for (const [key, type] of Object.entries(tool.arguments)) {
      const value = args[key]
      if (value === undefined || value === null) continue
      if (type === 'string[]' ? !Array.isArray(value) : typeof value !== type) {
        throw new PermissionError('invalid-argument', `Argument "${key}" must be of type ${type}.`)
      }
    }
  }

  async execute(name: string, args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const tool = this.get(name)
    this.validate(name, args)
    return await tool.execute(args, context)
  }
}

function buildTools(options: ToolRegistryOptions = {}): ToolDefinition[] {
  const taskRoot = options.taskRoot ?? 'apps/dashboard'
  const defaultTestCommand = taskRoot === '.' ? 'npm test' : 'node --test --test-concurrency=1 tests/*.test.ts'
  const commandApproval = options.requireCommandApproval ?? false
  const sandboxCommands = options.sandboxCommands ?? false
  return [
    ...(options.githubWorkflow && options.installedVersion ? [{
      name: 'github_dispatch',
      description: 'Dispatch the fixed NTHN Android build workflow for a reviewed branch after confirming that it contains a newer app version.',
      requiresApproval: true,
      required: ['branch'],
      arguments: { branch: 'string' as const },
      summarize: args => `Dispatch NTHN Android workflow for ${stringArg(args, 'branch')}`,
      execute: async args => {
        try { return { ok: true, summary: 'Dispatched the NTHN Android workflow.', output: JSON.stringify(await options.githubWorkflow!.dispatch(stringArg(args, 'branch'), options.installedVersion!)) } }
        catch (error) { return { ok: false, summary: error instanceof Error ? error.message : 'GitHub workflow dispatch failed.', output: '' } }
      },
    } as ToolDefinition, {
      name: 'github_workflow_status',
      description: 'Read the current status and conclusion of a specific NTHN Android workflow run.',
      requiresApproval: false,
      required: ['runId'],
      arguments: { runId: 'string' as const },
      summarize: args => `Inspect GitHub workflow run ${stringArg(args, 'runId')}`,
      execute: async args => {
        try { return { ok: true, summary: 'Read NTHN Android workflow status.', output: JSON.stringify(await options.githubWorkflow!.status(stringArg(args, 'runId'))) } }
        catch (error) { return { ok: false, summary: error instanceof Error ? error.message : 'GitHub workflow status failed.', output: '' } }
      },
    } as ToolDefinition] : []),
    ...(options.terminalStatePath ? [{
      name: 'inspect_terminal',
      description: 'Read a bounded snapshot of the currently visible native terminal session. Requires approval because terminal output may contain sensitive data. This does not send input to the open terminal.',
      requiresApproval: true,
      required: [],
      arguments: {},
      summarize: () => 'Inspect visible terminal output',
      execute: async () => {
        try { return { ok: true, summary: 'Read bounded native terminal snapshot.', output: JSON.stringify(await readNativeTerminalState(options.terminalStatePath!)) } }
        catch { return { ok: false, summary: 'Native terminal state is unavailable.', output: '' } }
      },
    } as ToolDefinition] : []),
    ...(options.deviceStatePath ? [{
      name: 'inspect_device_context',
      description: 'Read the latest camera, location, speech, or shared-file context explicitly granted through the native NTHN app.',
      requiresApproval: false,
      required: [],
      arguments: {},
      summarize: () => 'Inspect latest granted device context',
      execute: async () => {
        try { return { ok: true, summary: 'Read latest granted device context.', output: JSON.stringify(await readNativeDeviceContext(options.deviceStatePath!)) } }
        catch { return { ok: false, summary: 'No granted device context is available.', output: '' } }
      },
    } as ToolDefinition] : []),
    ...(options.appStatePath ? [{
      name: 'inspect_app_screen',
      description: 'Read the current NTHN app screen name and update time reported by the native app. This is structured app state, not a screenshot.',
      requiresApproval: false,
      required: [],
      arguments: {},
      summarize: () => 'Inspect current NTHN screen',
      execute: async () => {
        try { return { ok: true, summary: 'Read native NTHN screen state.', output: JSON.stringify(await readNativeAppScreen(options.appStatePath!)) } }
        catch { return { ok: false, summary: 'Native NTHN screen state is unavailable.', output: '' } }
      },
    } as ToolDefinition] : []),
    {
      name: 'source_manifest',
      description: 'Hash the selected NTHN source tree and report its version and integrity. This does not build or install the app.',
      requiresApproval: false,
      required: [],
      arguments: {},
      summarize: () => 'Inspect NTHN source integrity',
      execute: async (_args, context) => {
        try {
          const manifest = await createSourceManifest(context.workspace)
          return { ok: true, summary: `Hashed ${manifest.files.length} source files for V${manifest.version}; build not run.`,
            output: JSON.stringify({ version: manifest.version, rootSha256: manifest.rootSha256, fileCount: manifest.files.length, totalBytes: manifest.totalBytes, buildStatus: manifest.buildStatus }) }
        } catch (error) { return { ok: false, summary: error instanceof Error ? error.message : 'Source manifest failed.', output: '' } }
      },
    },
    {
      name: 'inspect_environment',
      description: 'Read Node/Linux runtime, selected workspace, memory, CPU count, and free space. Does not inspect other Android apps.',
      requiresApproval: false,
      required: [],
      arguments: {},
      summarize: () => 'Inspect environment',
      execute: async (_args, context) => {
        try { return { ok: true, summary: 'Inspected app environment.', output: JSON.stringify(await inspectEnvironment(context)) } }
        catch (error) { return { ok: false, summary: error instanceof Error ? error.message : 'Environment inspection failed.', output: '' } }
      },
    },
    ...(options.tasks ? [{
      name: 'task_status',
      description: 'Read the current task plan and progress log.',
      requiresApproval: false,
      required: [],
      arguments: {},
      summarize: () => 'Inspect current task',
      execute: async (_args: Record<string, unknown>, context: ToolContext) => {
        if (!context.taskId) return { ok: false, summary: 'No active task.', output: '' }
        try { return { ok: true, summary: 'Task status available.', output: JSON.stringify(inspectTask(options.tasks!, context.taskId)) } }
        catch (error) { return { ok: false, summary: error instanceof Error ? error.message : 'Task status unavailable.', output: '' } }
      },
    } as ToolDefinition] : []),
    ...(options.research ? [{
      name: 'web_search',
      description: 'Search the public web using the configured provider. Returns real titles, snippets, and source URLs. A provider must be configured.',
      requiresApproval: false,
      required: ['query'],
      arguments: { query: 'string' },
      summarize: (args: Record<string, unknown>) => `Search web for ${stringArg(args, 'query').slice(0, 100)}`,
      execute: async (args: Record<string, unknown>, context: ToolContext) => {
        try {
          const sources = await options.research!.search(stringArg(args, 'query'), context.signal)
          return { ok: true, summary: `${sources.length} web source(s) found.`, output: JSON.stringify(sources) }
        } catch (error) { return { ok: false, summary: error instanceof Error ? error.message : 'Web search failed.', output: '' } }
      },
    } as ToolDefinition, {
      name: 'open_url',
      description: 'Retrieve a public HTTPS page and extract readable text, its title, and final source URL.',
      requiresApproval: false,
      required: ['url'],
      arguments: { url: 'string' },
      summarize: (args: Record<string, unknown>) => `Open ${stringArg(args, 'url').slice(0, 150)}`,
      execute: async (args: Record<string, unknown>, context: ToolContext) => {
        try {
          const page = await options.research!.open(stringArg(args, 'url'), context.signal)
          return { ok: true, summary: `Opened ${page.title}.`, output: JSON.stringify(page) }
        } catch (error) { return { ok: false, summary: error instanceof Error ? error.message : 'Page retrieval failed.', output: '' } }
      },
    } as ToolDefinition] : []),
    ...(options.tasks ? [{
      name: 'set_task_plan',
      description: 'Record a short executable plan for the current task. Pass steps as JSON array of {action,done}. Update it as work progresses.',
      requiresApproval: false,
      required: ['steps'],
      arguments: { steps: 'string' },
      summarize: () => 'Update task plan',
      execute: async (args: Record<string, unknown>, context: ToolContext) => {
        if (!context.taskId) return { ok: false, summary: 'No active task.', output: '' }
        try {
          const steps = JSON.parse(stringArg(args, 'steps')) as TaskStep[]
          options.tasks!.setPlan(context.taskId, steps)
          return { ok: true, summary: `Saved ${steps.length} task step(s).`, output: JSON.stringify(steps) }
        } catch (error) { return { ok: false, summary: error instanceof Error ? error.message : 'Invalid task plan.', output: '' } }
      },
    } as ToolDefinition] : []),
    ...(options.memory ? [{
      name: 'save_memory',
      description: 'Save a concise useful fact, preference, decision, goal, checkpoint, or verified lesson for future chats. No secrets or guesses.',
      requiresApproval: false,
      required: ['kind', 'text'],
      arguments: { kind: 'string', text: 'string', scope: 'string', sourcePath: 'string' },
      summarize: (args: Record<string, unknown>) => `Remember: ${stringArg(args, 'text').slice(0, 100)}`,
      execute: async (args: Record<string, unknown>) => {
        const kind = stringArg(args, 'kind') as MemoryKind
        const scope = stringArg(args, 'scope', 'project') === 'personal' ? 'personal' : options.memoryScope ?? 'personal'
        try {
          const item = await options.memory!.add({ scope, kind, text: stringArg(args, 'text'), source: 'Jef conversation', sourcePath: stringArg(args, 'sourcePath') || undefined })
          return { ok: true, summary: 'Saved memory.', output: item.text }
        } catch (error) { return { ok: false, summary: error instanceof Error ? error.message : 'Memory rejected.', output: '' } }
      },
    } as ToolDefinition, {
      name: 'recall_memory',
      description: 'Find relevant saved personal and current-project memories with source and freshness.',
      requiresApproval: false,
      required: ['query'],
      arguments: { query: 'string' },
      summarize: (args: Record<string, unknown>) => `Recall memory about ${stringArg(args, 'query')}`,
      execute: async (args: Record<string, unknown>) => {
        const found = options.memory!.relevant(options.memoryScope ?? 'personal', stringArg(args, 'query'), 20)
        return { ok: true, summary: `${found.length} memories found.`, output: found.map(item => `${item.id} [${item.kind}; ${item.source}] ${item.text}`).join('\n') }
      },
    } as ToolDefinition, {
      name: 'revise_memory',
      description: 'Correct an existing saved memory after new evidence or user feedback.',
      requiresApproval: false,
      required: ['id', 'text'],
      arguments: { id: 'string', text: 'string' },
      summarize: () => 'Correct saved memory',
      execute: async (args: Record<string, unknown>) => {
        const id = stringArg(args, 'id')
        if (!options.memory!.list(options.memoryScope ?? 'personal').some(item => item.id === id)) return { ok: false, summary: 'Memory not found in this project.', output: '' }
        try { const item = await options.memory!.update(id, { text: stringArg(args, 'text') }); return { ok: true, summary: 'Memory corrected.', output: item.text } }
        catch (error) { return { ok: false, summary: error instanceof Error ? error.message : 'Memory rejected.', output: '' } }
      },
    } as ToolDefinition, {
      name: 'forget_memory',
      description: 'Delete a saved memory when the user asks or evidence proves it is wrong.',
      requiresApproval: false,
      required: ['id'],
      arguments: { id: 'string' },
      summarize: () => 'Forget saved memory',
      execute: async (args: Record<string, unknown>) => {
        const id = stringArg(args, 'id')
        if (!options.memory!.list(options.memoryScope ?? 'personal').some(item => item.id === id)) return { ok: false, summary: 'Memory not found in this project.', output: '' }
        await options.memory!.remove(id)
        return { ok: true, summary: 'Memory deleted.', output: '' }
      },
    } as ToolDefinition, {
      name: 'link_memory',
      description: 'Connect two visible saved memories with a named relationship.',
      requiresApproval: false,
      required: ['from', 'to', 'relation'],
      arguments: { from: 'string', to: 'string', relation: 'string' },
      summarize: () => 'Connect memories',
      execute: async (args: Record<string, unknown>) => {
        if (!options.memory!.link) return { ok: false, summary: 'Memory relationships are unavailable.', output: '' }
        const from = stringArg(args, 'from'), to = stringArg(args, 'to')
        const visible = new Set(options.memory!.list(options.memoryScope ?? 'personal').map(item => item.id))
        if (!visible.has(from) || !visible.has(to)) return { ok: false, summary: 'Memory not found in this project.', output: '' }
        try { await options.memory!.link(from, to, stringArg(args, 'relation')); return { ok: true, summary: 'Memories connected.', output: `${from} → ${to}` } }
        catch (error) { return { ok: false, summary: error instanceof Error ? error.message : 'Memory link failed.', output: '' } }
      },
    } as ToolDefinition, {
      name: 'memory_history',
      description: 'Read the change history and relationships of one visible saved memory.',
      requiresApproval: false,
      required: ['id'],
      arguments: { id: 'string' },
      summarize: () => 'Inspect memory history',
      execute: async (args: Record<string, unknown>) => {
        const id = stringArg(args, 'id')
        if (!options.memory!.list(options.memoryScope ?? 'personal').some(item => item.id === id)) return { ok: false, summary: 'Memory not found in this project.', output: '' }
        return { ok: true, summary: 'Memory history available.', output: JSON.stringify({ history: options.memory!.history?.(id) ?? [], links: options.memory!.links?.(id) ?? [] }) }
      },
    } as ToolDefinition] : []),
    {
      name: 'list_dir',
      description: 'List files and directories inside the workspace. Relative paths only.',
      requiresApproval: false,
      required: [],
      arguments: { path: 'string' },
      summarize: args => `List directory ${stringArg(args, 'path', '.')}`,
      execute: async (args, context) => {
        const target = await context.paths.describe(stringArg(args, 'path', '.'))
        if (!target.directory) return { ok: false, summary: 'Not a directory.', output: target.relative }
        const entries = await readdir(target.absolute, { withFileTypes: true })
        const lines = entries
          .filter(entry => !['.git', '.local', '.ssh'].includes(entry.name))
          .sort((a, b) => a.name.localeCompare(b.name))
          .map(entry => `${entry.isDirectory() ? 'dir ' : 'file'} ${entry.name}`)
        const output = clampOutput(lines.join('\n'))
        const summary = lines.length === 0 && (target.relative === '' || target.relative === '.')
          ? '0 entries in workspace root; no project files are visible here.'
          : `${lines.length} entr${lines.length === 1 ? 'y' : 'ies'} in ${target.relative}.`
        return { ok: true, summary, output: output.text, truncated: output.truncated }
      },
    },
    {
      name: 'find_files',
      description: 'Find file paths by a case-insensitive name fragment without reading file contents.',
      requiresApproval: false,
      required: ['query'],
      arguments: { query: 'string', path: 'string' },
      summarize: args => `Find files named ${stringArg(args, 'query')}`,
      execute: async (args, context) => {
        const query = stringArg(args, 'query').trim().toLowerCase()
        if (!query || query.length > 100) return { ok: false, summary: 'Invalid file query.', output: '' }
        const files = await walkFiles(context.workspace, context.paths, stringArg(args, 'path', '.'), context.signal)
        const matches = files.map(file => relative(context.workspace, file)).filter(path => path.toLowerCase().includes(query)).slice(0, 100)
        return { ok: true, summary: `${matches.length} matching file(s).`, output: matches.join('\n') }
      },
    },
    {
      name: 'read_file',
      description: 'Read a UTF-8 text file inside the workspace. Optional start and end line numbers (1-based).',
      requiresApproval: false,
      required: ['path'],
      arguments: { path: 'string', start: 'number', end: 'number' },
      summarize: args => `Read ${stringArg(args, 'path')}`,
      execute: async (args, context) => {
        const target = await context.paths.describe(stringArg(args, 'path'))
        if (target.directory) return { ok: false, summary: 'Path is a directory.', output: target.relative }
        if (target.size > MAX_FILE_BYTES) return { ok: false, summary: `File is larger than ${MAX_FILE_BYTES} bytes.`, output: target.relative }
        const content = await readFile(target.absolute, 'utf8')
        if (content.includes('\u0000')) return { ok: false, summary: 'File appears to be binary.', output: target.relative }
        const lines = content.split('\n')
        const start = Math.max(1, numberArg(args, 'start', 1))
        const end = Math.min(lines.length, numberArg(args, 'end', lines.length))
        const sliced = lines.slice(start - 1, end)
        const numbered = sliced.map((line, index) => `${String(start + index).padStart(6)}  ${line}`).join('\n')
        const output = clampOutput(numbered)
        return { ok: true, summary: `Read ${sliced.length} line(s) from ${target.relative}.`, output: output.text, truncated: output.truncated, meta: { relative: target.relative, lines: lines.length } }
      },
    },
    {
      name: 'search',
      description: 'Search file contents in the workspace with a JavaScript regular expression. Skips node_modules, .git and binary files.',
      requiresApproval: false,
      required: ['pattern'],
      arguments: { pattern: 'string', path: 'string' },
      summarize: args => `Search for /${stringArg(args, 'pattern')}/ in ${stringArg(args, 'path', '.')}`,
      execute: async (args, context) => {
        const pattern = stringArg(args, 'pattern')
        if (pattern.length > 300) return { ok: false, summary: 'Pattern is too long.', output: '' }
        let regex: RegExp
        try {
          regex = new RegExp(pattern, 'i')
        } catch {
          return { ok: false, summary: 'Invalid regular expression.', output: pattern }
        }
        const files = await walkFiles(context.workspace, context.paths, stringArg(args, 'path', '.'), context.signal)
        const matches: string[] = []
        for (const file of files) {
          if (matches.length >= MAX_SEARCH_RESULTS) break
          if (context.signal.aborted) break
          let safeFile: string
          try { safeFile = await context.paths.resolveExisting(relative(context.workspace, file)) } catch { continue }
          const info = await stat(safeFile)
          if (info.size > MAX_FILE_BYTES) continue
          let content: string
          try { content = await readFile(safeFile, 'utf8') } catch { continue }
          if (content.includes('\u0000')) continue
          const lines = content.split('\n')
          for (let index = 0; index < lines.length && matches.length < MAX_SEARCH_RESULTS; index += 1) {
            if (regex.test(lines[index])) matches.push(`${relative(context.workspace, safeFile)}:${index + 1}: ${lines[index].slice(0, 300)}`)
          }
        }
        const output = clampOutput(matches.join('\n'))
        return { ok: true, summary: `${matches.length} match(es)${matches.length >= MAX_SEARCH_RESULTS ? ' (limited)' : ''}.`, output: output.text, truncated: output.truncated }
      },
    },
    {
      name: 'write_file',
      description: 'Create or overwrite a UTF-8 text file inside the workspace. Requires user approval.',
      requiresApproval: true,
      required: ['path', 'content'],
      arguments: { path: 'string', content: 'string' },
      summarize: args => `Write ${stringArg(args, 'path')}`,
      execute: async (args, context) => {
        const target = await context.paths.resolveForWrite(stringArg(args, 'path'))
        const content = stringArg(args, 'content')
        if (content.length > MAX_FILE_BYTES) return { ok: false, summary: 'Content is too large.', output: '' }
        await writeFile(target, content, 'utf8')
        return { ok: true, summary: `Wrote ${content.length} bytes to ${relative(context.workspace, target)}.`, output: `Wrote ${relative(context.workspace, target)}.`, meta: { relative: relative(context.workspace, target) } }
      },
    },
    {
      name: 'edit_file',
      description: 'Replace an exact, unique text fragment in a workspace file. Requires user approval.',
      requiresApproval: true,
      required: ['path', 'oldText', 'newText'],
      arguments: { path: 'string', oldText: 'string', newText: 'string' },
      summarize: args => `Edit ${stringArg(args, 'path')}`,
      execute: async (args, context) => {
        const target = await context.paths.resolveForWrite(stringArg(args, 'path'))
        const oldText = stringArg(args, 'oldText')
        const newText = stringArg(args, 'newText')
        if (oldText.length === 0) return { ok: false, summary: 'oldText must not be empty.', output: '' }
        const content = await readFile(target, 'utf8')
        const first = content.indexOf(oldText)
        if (first === -1) return { ok: false, summary: 'oldText was not found in the file.', output: '' }
        if (content.indexOf(oldText, first + 1) !== -1) return { ok: false, summary: 'oldText matches more than once; provide a unique fragment.', output: '' }
        const updated = content.slice(0, first) + newText + content.slice(first + oldText.length)
        if (updated.length > MAX_FILE_BYTES) return { ok: false, summary: 'Resulting file is too large.', output: '' }
        await writeFile(target, updated, 'utf8')
        return { ok: true, summary: `Edited ${relative(context.workspace, target)}.`, output: `Replaced ${oldText.length} character(s) with ${newText.length} character(s).`, meta: { relative: relative(context.workspace, target) } }
      },
    },
    {
      name: 'edit_files',
      description: 'Replace exact unique text in up to 10 files as one reviewed action. Pass changes as a JSON array of {path, oldText, newText}. Requires approval.',
      requiresApproval: true,
      required: ['changes'],
      arguments: { changes: 'string' },
      summarize: args => {
        try {
          const changes: unknown = JSON.parse(stringArg(args, 'changes'))
          return Array.isArray(changes) ? `Edit ${changes.length} files: ${changes.map(item => String(item?.path ?? '?')).join(', ')}` : 'Edit files'
        } catch { return 'Edit files' }
      },
      execute: async (args, context) => {
        let changes: unknown
        try { changes = JSON.parse(stringArg(args, 'changes')) } catch { return { ok: false, summary: 'Invalid changes JSON.', output: '' } }
        if (!Array.isArray(changes) || changes.length < 1 || changes.length > 10) return { ok: false, summary: 'Provide 1 to 10 changes.', output: '' }
        const prepared: { path: string; original: string; updated: string }[] = []
        const seen = new Set<string>()
        try {
          for (const change of changes) {
            if (!change || typeof change.path !== 'string' || typeof change.oldText !== 'string' || typeof change.newText !== 'string' || !change.oldText) throw new Error('Each change needs path, oldText, and newText.')
            const path = await context.paths.resolveForWrite(change.path)
            if (seen.has(path)) throw new Error('Each file may appear only once.')
            seen.add(path)
            const original = await readFile(path, 'utf8')
            const first = original.indexOf(change.oldText)
            if (first < 0 || original.indexOf(change.oldText, first + 1) >= 0) throw new Error(`Text is missing or not unique in ${change.path}.`)
            const updated = original.slice(0, first) + change.newText + original.slice(first + change.oldText.length)
            if (updated.length > MAX_FILE_BYTES) throw new Error(`Result is too large in ${change.path}.`)
            prepared.push({ path, original, updated })
          }
        } catch (error) { return { ok: false, summary: error instanceof Error ? error.message : 'Changes rejected.', output: '' } }
        const written: typeof prepared = []
        try {
          for (const change of prepared) { await writeFile(change.path, change.updated, 'utf8'); written.push(change) }
        } catch (error) {
          for (const change of written.reverse()) await writeFile(change.path, change.original, 'utf8').catch(() => undefined)
          return { ok: false, summary: error instanceof Error ? error.message : 'Write failed.', output: '' }
        }
        return { ok: true, summary: `Edited ${prepared.length} files.`, output: prepared.map(change => relative(context.workspace, change.path)).join('\n') }
      },
    },
    {
      name: 'run_command',
      description: 'Run an allowlisted development command in the workspace. Shell operators are rejected. Destructive commands require approval.',
      requiresApproval: commandApproval ? true : args => {
        const assessment: CommandAssessment = assessCommand(stringArg(args, 'command'))
        return assessment.requiresApproval
      },
      required: ['command'],
      arguments: { command: 'string', cwd: 'string' },
      summarize: args => `Run: ${stringArg(args, 'command')}`,
      execute: async (args, context) => {
        const cwdInput = stringArg(args, 'cwd', '.')
        const cwd = await context.paths.resolveExisting(cwdInput)
        return await runProcess(stringArg(args, 'command'), context, cwd, context.timeoutMs ?? 120_000, sandboxCommands)
      },
    },
    {
      name: 'run_tests',
      description: 'Run the selected project test suite. Optional command override must remain a test command.',
      requiresApproval: commandApproval,
      required: [],
      arguments: { command: 'string' },
      summarize: args => `Run tests: ${stringArg(args, 'command', defaultTestCommand)}`,
      execute: async (args, context) => {
        const command = stringArg(args, 'command', defaultTestCommand)
        if (!/\b(test|spec|node\s+--test)\b/.test(command)) return { ok: false, summary: 'run_tests only accepts test commands.', output: command }
        const cwd = await context.paths.resolveExisting(taskRoot)
        return await runProcess(command, context, cwd, context.timeoutMs ?? 120_000, sandboxCommands)
      },
    },
    {
      name: 'run_build',
      description: 'Run the selected project build (npm run build). Optional command override must remain a build/typecheck command.',
      requiresApproval: commandApproval,
      required: [],
      arguments: { command: 'string' },
      summarize: args => `Build: ${stringArg(args, 'command', 'npm run build')}`,
      execute: async (args, context) => {
        const command = stringArg(args, 'command', 'npm run build')
        if (!/\b(build|typecheck|tsc)\b/.test(command)) return { ok: false, summary: 'run_build only accepts build or typecheck commands.', output: command }
        const cwd = await context.paths.resolveExisting(taskRoot)
        return await runProcess(command, context, cwd, context.timeoutMs ?? 120_000, sandboxCommands)
      },
    },
    {
      name: 'decide',
      description: 'Ask the local structured decision engine for an advisory analysis. Kinds: choice, classification, priority, risk, boolean, probability, conditions, routing, workflow.',
      requiresApproval: false,
      required: ['kind', 'question'],
      arguments: { kind: 'string', question: 'string' },
      summarize: args => `Decision (${stringArg(args, 'kind')}): ${stringArg(args, 'question')}`,
      execute: async args => toolDecision(args),
    },
  ]
}
