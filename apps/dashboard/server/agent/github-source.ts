import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { lstat, mkdir, realpath, rm, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { sanitizedEnvironment } from './permissions.ts'
import { validGithubBranch } from './github-workflow.ts'

const execFileAsync = promisify(execFile)
const REMOTE = 'https://github.com/suraranathan/nthnEntps-.git'
const PROJECT = 'nthnEntps-v2'

export interface GitRunnerOptions { cwd: string; env: NodeJS.ProcessEnv }
export type GitRunner = (args: string[], options: GitRunnerOptions) => Promise<{ stdout: string; stderr: string }>

const defaultRunner: GitRunner = async (args, options) => {
  try {
    const result = await execFileAsync('git', args, { cwd: options.cwd, env: options.env, timeout: 120_000, maxBuffer: 1_000_000, encoding: 'utf8' })
    return { stdout: result.stdout, stderr: result.stderr }
  } catch { throw new Error('Git operation failed.') }
}

function developmentBranch(branch: string): boolean {
  return validGithubBranch(branch) && /^(codex|jef)\//.test(branch)
}

function cleanLines(value: string): string[] {
  const lines = value.split(/\r?\n/).filter(Boolean)
  if (lines.length > 500 || lines.some(path => path.length > 500 || isAbsolute(path) || path.split(/[\\/]+/).some(part => part === '..' || part === '.git') || /[\x00-\x1f\x7f]/.test(path))) {
    throw new Error('Git change list is invalid or too large.')
  }
  if (lines.some(path => /(^|\/)(bootstrap-parts|\.bootstrap[^/]*)(\/|$)|bootstrap-aarch64\.zip$/.test(path))) {
    throw new Error('Bootstrap artifacts cannot be pushed by Jef.')
  }
  return lines
}

export class GithubSourceService {
  private readonly runner: GitRunner
  private readonly env: NodeJS.ProcessEnv

  constructor(token: string, runner: GitRunner = defaultRunner) {
    if (!token || /\s/.test(token)) throw new Error('GitHub write credential is required.')
    this.runner = runner
    this.env = {
      ...sanitizedEnvironment(process.env),
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.extraHeader',
      GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}`,
    }
  }

  private async git(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
    return await this.runner(args, { cwd, env: this.env })
  }

  async prepare(home: string, branch: string): Promise<{ project: string; branch: string; commit: string }> {
    if (!developmentBranch(branch)) throw new Error('Source preparation requires a development branch.')
    const root = await realpath(home)
    if (!(await stat(root)).isDirectory()) throw new Error('Linux home is unavailable.')
    const target = join(root, PROJECT)
    if (existsSync(target)) throw new Error(`${PROJECT} already exists.`)
    let created = false
    try {
      await mkdir(target, { mode: 0o700 })
      created = true
      await this.git(['clone', '--branch', branch, '--single-branch', '--origin', 'origin', REMOTE, '.'], target)
      const gitDirectory = await lstat(join(target, '.git'))
      if (!gitDirectory.isDirectory() || gitDirectory.isSymbolicLink()) throw new Error('Prepared source is not a Git repository.')
      const remote = (await this.git(['remote', 'get-url', 'origin'], target)).stdout.trim()
      if (remote !== REMOTE) throw new Error('Prepared source remote is invalid.')
      await this.git(['config', 'user.name', 'Jef'], target)
      await this.git(['config', 'user.email', 'jef@nthn.local'], target)
      const commit = (await this.git(['rev-parse', 'HEAD'], target)).stdout.trim()
      if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('Prepared source commit is invalid.')
      return { project: PROJECT, branch, commit }
    } catch (error) {
      if (created) await rm(target, { recursive: true, force: true })
      throw error
    }
  }

  async push(workspace: string, branch: string): Promise<{ branch: string; commit: string; changed: string[] }> {
    if (!developmentBranch(branch)) throw new Error('Source push requires a development branch.')
    const root = await realpath(workspace)
    const gitDirectory = await lstat(join(root, '.git')).catch(() => undefined)
    if (!gitDirectory?.isDirectory() || gitDirectory.isSymbolicLink()) throw new Error('Selected project is not a prepared Git repository.')
    const current = (await this.git(['branch', '--show-current'], root)).stdout.trim()
    if (current !== branch) throw new Error('Selected Git branch does not match the approved push branch.')
    const remote = (await this.git(['remote', 'get-url', 'origin'], root)).stdout.trim()
    if (remote !== REMOTE) throw new Error('Git remote is not the fixed NTHN repository.')
    if ((await this.git(['status', '--porcelain=v1'], root)).stdout.trim()) throw new Error('Source has uncommitted changes; review and commit them before push.')
    const commit = (await this.git(['rev-parse', 'HEAD'], root)).stdout.trim()
    if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('Source commit is invalid.')
    const upstream = `origin/${branch}`
    const ahead = Number((await this.git(['rev-list', '--count', `${upstream}..HEAD`], root)).stdout.trim())
    const behind = Number((await this.git(['rev-list', '--count', `HEAD..${upstream}`], root)).stdout.trim())
    if (!Number.isInteger(ahead) || ahead < 1 || ahead > 100 || behind !== 0) throw new Error('Source branch must be a reviewable fast-forward update of its origin branch.')
    const changed = cleanLines((await this.git(['diff', '--name-only', `${upstream}...HEAD`], root)).stdout)
    if (!changed.length) throw new Error('Source commit has no reviewable changes.')
    await this.git(['push', 'origin', `HEAD:refs/heads/${branch}`], root)
    return { branch, commit, changed }
  }
}
