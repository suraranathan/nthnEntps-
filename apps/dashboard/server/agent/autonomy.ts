import { assessCommand } from './permissions.ts'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export type AutonomyConfig =
  | { mode: 'supervised' }
  | { mode: 'bounded'; expiresAt: number; commands: string[]; maxCommands: number; usedCommands?: number }

export class AutonomyPolicy {
  private readonly config: AutonomyConfig
  private used: number
  private readonly onUse?: (config: AutonomyConfig) => void

  constructor(config: AutonomyConfig, onUse?: (config: AutonomyConfig) => void) {
    if (!config || !['supervised', 'bounded'].includes(config.mode)) throw new Error('Invalid autonomy mode.')
    if (config.mode === 'bounded') {
      if (!Number.isFinite(config.expiresAt) || config.expiresAt <= Date.now() || config.expiresAt > Date.now() + 24 * 60 * 60_000 ||
        !Array.isArray(config.commands) || config.commands.length < 1 || config.commands.length > 20 ||
        !Number.isInteger(config.maxCommands) || config.maxCommands < 1 || config.maxCommands > 20 ||
        (config.usedCommands !== undefined && (!Number.isInteger(config.usedCommands) || config.usedCommands < 0 || config.usedCommands > config.maxCommands)) ||
        config.commands.some(command => typeof command !== 'string' || !assessCommand(command).allowed || assessCommand(command).requiresApproval)) {
        throw new Error('Invalid bounded autonomy grant.')
      }
    }
    this.config = config
    this.used = config.mode === 'bounded' ? Math.max(0, config.usedCommands ?? 0) : 0
    this.onUse = onUse
  }

  useCommand(command: string): boolean {
    if (this.config.mode !== 'bounded' || Date.now() >= this.config.expiresAt || this.used >= this.config.maxCommands || !this.config.commands.includes(command)) return false
    this.used += 1
    this.onUse?.(this.snapshot())
    return true
  }

  snapshot(): AutonomyConfig {
    return this.config.mode === 'bounded' ? { ...this.config, usedCommands: this.used } : { mode: 'supervised' }
  }
}

function persist(file: string, config: AutonomyConfig): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${randomUUID()}.tmp`
  writeFileSync(temporary, JSON.stringify(config), { mode: 0o600, flag: 'wx' })
  renameSync(temporary, file)
}

export function saveAutonomyConfig(file: string, value: unknown): AutonomyConfig {
  const policy = new AutonomyPolicy(value as AutonomyConfig)
  const config = policy.snapshot()
  persist(file, config)
  return config
}

export function loadAutonomyPolicy(file: string): AutonomyPolicy {
  if (!existsSync(file)) return new AutonomyPolicy({ mode: 'supervised' })
  let value: unknown
  try { value = JSON.parse(readFileSync(file, 'utf8')) }
  catch { throw new Error('Saved autonomy grant is invalid; refusing to use it.') }
  if (value && typeof value === 'object' && (value as { mode?: unknown }).mode === 'bounded' &&
    typeof (value as { expiresAt?: unknown }).expiresAt === 'number' && (value as { expiresAt: number }).expiresAt <= Date.now()) {
    return new AutonomyPolicy({ mode: 'supervised' })
  }
  return new AutonomyPolicy(value as AutonomyConfig, config => persist(file, config))
}
