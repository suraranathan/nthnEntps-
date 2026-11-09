import { spawn } from 'node:child_process'
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
  taskRoot?: string
  requireCommandApproval?: boolean
  sandboxCommands?: boolean
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
        resolve({ ok: false, summary: 'The confined command runner is unavailable.', output: 'Install the app Linux environment before running commands.' })
        return
      }
      const guestCwd = '/' + relative(context.workspace, cwd).split('\\').join('/')
      sandboxCwd = guestCwd
      const bindings = [prefix, '/system', '/apex', '/vendor', '/proc'].filter(path => existsSync(path))
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

  constructor(options: ToolRegistryOptions = {}) {
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
  const commandApproval = options.requireCommandApproval ?? false
  const sandboxCommands = options.sandboxCommands ?? false
  return [
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
        return { ok: true, summary: `${lines.length} entr${lines.length === 1 ? 'y' : 'ies'} in ${target.relative}.`, output: output.text, truncated: output.truncated }
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
      description: 'Run the dashboard test suite (node --test). Optional command override must remain a test command.',
      requiresApproval: commandApproval,
      required: [],
      arguments: { command: 'string' },
      summarize: args => `Run tests: ${stringArg(args, 'command', 'node --test --test-concurrency=1 tests/*.test.ts')}`,
      execute: async (args, context) => {
        const command = stringArg(args, 'command', 'node --test --test-concurrency=1 tests/*.test.ts')
        if (!/\b(test|spec|node\s+--test)\b/.test(command)) return { ok: false, summary: 'run_tests only accepts test commands.', output: command }
        const cwd = await context.paths.resolveExisting(taskRoot)
        return await runProcess(command, context, cwd, context.timeoutMs ?? 120_000, sandboxCommands)
      },
    },
    {
      name: 'run_build',
      description: 'Run the dashboard production build (npm run build). Optional command override must remain a build/typecheck command.',
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
