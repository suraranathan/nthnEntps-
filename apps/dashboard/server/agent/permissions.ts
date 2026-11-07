import { lstat, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

export class PermissionError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'PermissionError'
    this.code = code
  }
}

const SENSITIVE_SEGMENTS = new Set(['.git', '.ssh', '.gnupg', '.local', '__pycache__'])
const SENSITIVE_NAMES = [
  /^\.env($|\.)/i,
  /(^|\.)pem$/i,
  /(^|\.)key$/i,
  /(^|\.)p12$/i,
  /(^|\.)pfx$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /^master\.key$/i,
  /^providers\.sqlite$/i,
  /^credentials?\.(json|ya?ml)$/i,
  /^secrets?\.(json|ya?ml|toml)$/i,
]
const ALLOWED_TOP_LEVEL_PROTECTED = [
  'apps/nthn', // readable, but writes are blocked by the team boundary below
]

export interface PathPolicyOptions {
  root: string
  writablePrefixes?: string[]
  deniedSegments?: string[]
}

export class PathPolicy {
  readonly root: string
  private readonly writablePrefixes: string[]
  private readonly deniedSegments: Set<string>

  constructor(options: PathPolicyOptions) {
    this.root = resolve(options.root)
    this.writablePrefixes = (options.writablePrefixes ?? []).map(prefix => resolve(this.root, prefix))
    this.deniedSegments = new Set([...SENSITIVE_SEGMENTS, ...(options.deniedSegments ?? [])])
  }

  private assertRelative(relativePath: string): void {
    if (isAbsolute(relativePath)) throw new PermissionError('absolute-path', `Absolute paths are not allowed: ${relativePath}`)
    const segments = relativePath.split(/[\\/]+/)
    for (const segment of segments) {
      if (segment === '..') throw new PermissionError('path-traversal', `Path traversal is not allowed: ${relativePath}`)
      if (this.deniedSegments.has(segment)) throw new PermissionError('protected-path', `Protected path segment: ${segment}`)
    }
    for (const name of SENSITIVE_NAMES) {
      if (name.test(relativePath.split(/[\\/]+/).pop() ?? '')) {
        throw new PermissionError('sensitive-file', `Sensitive file is not accessible: ${relativePath}`)
      }
    }
  }

  private insideRoot(absolutePath: string): boolean {
    const rel = relative(this.root, absolutePath)
    return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
  }

  async resolveExisting(input: string): Promise<string> {
    this.assertRelative(input)
    const candidate = resolve(this.root, input)
    if (!this.insideRoot(candidate)) throw new PermissionError('outside-workspace', `Path escapes the workspace: ${input}`)
    let real: string
    try {
      real = await realpath(candidate)
    } catch {
      throw new PermissionError('not-found', `Path does not exist: ${input}`)
    }
    if (!this.insideRoot(real)) throw new PermissionError('symlink-escape', `Symlink escapes the workspace: ${input}`)
    return real
  }

  async resolveForWrite(input: string): Promise<string> {
    this.assertRelative(input)
    const candidate = resolve(this.root, input)
    if (!this.insideRoot(candidate)) throw new PermissionError('outside-workspace', `Path escapes the workspace: ${input}`)
    let parentReal: string
    try {
      parentReal = await realpath(dirname(candidate))
    } catch {
      throw new PermissionError('not-found', `Parent directory does not exist: ${dirname(input)}`)
    }
    if (!this.insideRoot(parentReal)) throw new PermissionError('symlink-escape', `Parent resolves outside the workspace: ${input}`)
    const target = resolve(parentReal, relative(dirname(candidate), candidate))
    try {
      const info = await lstat(target)
      if (info.isSymbolicLink()) {
        const linkReal = await realpath(target)
        if (!this.insideRoot(linkReal)) throw new PermissionError('symlink-escape', `Symlink escapes the workspace: ${input}`)
      }
    } catch (error) {
      if (error instanceof PermissionError) throw error
    }
    for (const protectedPrefix of ALLOWED_TOP_LEVEL_PROTECTED) {
      const protectedRoot = resolve(this.root, protectedPrefix)
      if (target === protectedRoot || target.startsWith(`${protectedRoot}${sep}`)) {
        throw new PermissionError('protected-project', `Writes to ${protectedPrefix} are protected. Modify this project through its own task boundary.`)
      }
    }
    if (this.writablePrefixes.length > 0 && !this.writablePrefixes.some(prefix => target === prefix || target.startsWith(`${prefix}${sep}`))) {
      throw new PermissionError('write-boundary', `Writes are limited to: ${this.writablePrefixes.map(prefix => relative(this.root, prefix) || '.').join(', ')}`)
    }
    return target
  }

  async describe(input: string): Promise<{ absolute: string; relative: string; directory: boolean; size: number }> {
    const absolute = await this.resolveExisting(input)
    const info = await stat(absolute)
    return { absolute, relative: relative(this.root, absolute), directory: info.isDirectory(), size: info.size }
  }
}

const ALLOWED_COMMANDS = new Set([
  'node', 'npm', 'npx', 'pnpm', 'yarn',
  'git', 'ls', 'pwd', 'cat', 'head', 'tail', 'wc', 'rg', 'grep', 'find', 'sed', 'awk', 'sort', 'uniq', 'diff',
  'mkdir', 'touch', 'cp', 'mv', 'python3', 'python', 'tsc', 'eslint', 'prettier', 'jest', 'vitest',
  'true', 'false', 'test',
])

const DANGEROUS_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /\brm\b/, label: 'file removal' },
  { pattern: /\brmdir\b/, label: 'directory removal' },
  { pattern: /\bmkfs\b/, label: 'filesystem formatting' },
  { pattern: /\bdd\s+/, label: 'raw disk write' },
  { pattern: /\bsudo\b/, label: 'privilege escalation' },
  { pattern: /\bsu\b/, label: 'user switching' },
  { pattern: /\b(chmod|chown|chgrp)\b/, label: 'permission change' },
  { pattern: /\b(kill|pkill|killall)\b/, label: 'process termination' },
  { pattern: /\b(shutdown|reboot|poweroff|halt)\b/, label: 'system power' },
  { pattern: /\b(mount|umount)\b/, label: 'filesystem mount' },
  { pattern: /\bgit\s+(reset|clean|rebase|push|checkout\s+--|restore|filter-branch)\b/, label: 'git history/destructive action' },
  { pattern: /\bgit\s+commit\b/, label: 'git commit' },
  { pattern: /\b(npm|pnpm|yarn)\s+(publish|unpublish|install\s+-g|add\s+-g|global)\b/, label: 'global/publish package action' },
  { pattern: /\b(curl|wget|nc|netcat|telnet)\b/, label: 'network download' },
  { pattern: /\b(ssh|scp|rsync)\b/, label: 'remote access' },
  { pattern: /\b(docker|podman|systemctl|service)\b/, label: 'system service control' },
  { pattern: /(^|[^\\])>>?/, label: 'output redirection' },
  { pattern: /\|\s*(sh|bash)\b/, label: 'pipe to shell' },
  { pattern: /\b(eval|exec)\b/, label: 'dynamic execution' },
  { pattern: /:\(\)\s*\{/, label: 'fork bomb' },
  { pattern: /\bpkg\s+(install|uninstall|upgrade)\b/, label: 'system package management' },
  { pattern: /\bnode\s+(-e|--eval)\b/, label: 'inline code execution' },
  { pattern: /\bpython3?\s+-c\b/, label: 'inline code execution' },
  { pattern: /\b(sed\s+-i|perl\s+-i)\b/, label: 'in-place file rewrite' },
  { pattern: /(-exec\b|\bxargs\b)/, label: 'command chaining' },
]

export interface CommandAssessment {
  allowed: boolean
  requiresApproval: boolean
  reason: string
  dangerous: string[]
  program: string
}

export function assessCommand(command: string, maxLength = 2000): CommandAssessment {
  const trimmed = command.trim()
  if (trimmed.length === 0) return { allowed: false, requiresApproval: false, reason: 'Empty command.', dangerous: [], program: '' }
  if (trimmed.length > maxLength) return { allowed: false, requiresApproval: false, reason: `Command exceeds ${maxLength} characters.`, dangerous: [], program: '' }
  if (trimmed.includes('\u0000')) return { allowed: false, requiresApproval: false, reason: 'NUL bytes are not allowed.', dangerous: [], program: '' }
  const program = trimmed.split(/\s+/)[0].replace(/^.*\//, '')
  if (!ALLOWED_COMMANDS.has(program)) {
    return { allowed: false, requiresApproval: false, reason: `Program "${program}" is not on the tool allowlist.`, dangerous: [], program }
  }
  const dangerous = DANGEROUS_PATTERNS.filter(item => item.pattern.test(trimmed)).map(item => item.label)
  return {
    allowed: true,
    requiresApproval: dangerous.length > 0,
    reason: dangerous.length > 0 ? `Requires human approval: ${dangerous.join(', ')}.` : 'Read-only or verification command on the allowlist.',
    dangerous,
    program,
  }
}

const ENV_ALLOWLIST = new Set([
  'PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'PWD', 'SHELL', 'USER', 'TZ',
  'NODE_ENV', 'NODE_OPTIONS', 'NODE_PATH', 'NPM_CONFIG_PREFIX', 'CI',
])

const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION|PRIVATE)/i

export function sanitizedEnvironment(source: NodeJS.ProcessEnv, overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue
    if (!ENV_ALLOWLIST.has(name)) continue
    if (SECRET_NAME.test(name)) continue
    result[name] = value
  }
  for (const [name, value] of Object.entries(overrides)) {
    if (!ENV_ALLOWLIST.has(name)) continue
    result[name] = value
  }
  result.CI = '1'
  return result
}

export interface ApprovalTicket {
  id: string
  conversationId: string
  tool: string
  signature: string
  createdAt: number
  expiresAt: number
}

export class ApprovalRegistry {
  private readonly tickets = new Map<string, ApprovalTicket>()
  private readonly ttlMs: number
  private counter = 0

  constructor(ttlMs = 10 * 60 * 1000) {
    this.ttlMs = ttlMs
  }

  issue(conversationId: string, tool: string, signature: string): ApprovalTicket {
    this.sweep()
    this.counter += 1
    const id = `approval-${Date.now().toString(36)}-${this.counter}`
    const now = Date.now()
    const ticket: ApprovalTicket = { id, conversationId, tool, signature, createdAt: now, expiresAt: now + this.ttlMs }
    this.tickets.set(id, ticket)
    return ticket
  }

  consume(id: string, conversationId: string, tool: string, signature: string): ApprovalTicket {
    this.sweep()
    const ticket = this.tickets.get(id)
    if (!ticket) throw new PermissionError('approval-missing', 'Approval ticket is missing or expired.')
    if (ticket.conversationId !== conversationId) throw new PermissionError('approval-scope', 'Approval ticket belongs to another conversation.')
    if (ticket.tool !== tool) throw new PermissionError('approval-scope', 'Approval ticket is for a different tool.')
    if (ticket.signature !== signature) throw new PermissionError('approval-signature', 'Approval ticket does not match the proposed action.')
    this.tickets.delete(id)
    return ticket
  }

  sweep(): void {
    const now = Date.now()
    for (const [id, ticket] of this.tickets) if (ticket.expiresAt <= now) this.tickets.delete(id)
  }
}
