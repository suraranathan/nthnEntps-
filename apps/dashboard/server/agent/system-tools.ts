import { freemem, platform, totalmem, cpus, uptime } from 'node:os'
import { readdir, statfs } from 'node:fs/promises'
import type { ToolContext } from './tools.ts'
import type { TaskStore, JefTask } from './tasks.ts'

export interface EnvironmentInfo {
  workspace: string
  platform: string
  arch: string
  node: string
  cpuCount: number
  freeMemoryBytes: number
  totalMemoryBytes: number
  uptimeSeconds: number
  workspaceFreeBytes: number
  fileCount: number
}

export async function inspectEnvironment(context: ToolContext): Promise<EnvironmentInfo> {
  const directory = await context.paths.resolveExisting('.')
  const [entries, filesystem] = await Promise.all([readdir(directory, { withFileTypes: true }), statfs(directory)])
  return {
    workspace: context.workspace,
    platform: platform(), arch: process.arch, node: process.version,
    cpuCount: cpus().length, freeMemoryBytes: freemem(), totalMemoryBytes: totalmem(),
    uptimeSeconds: Math.floor(uptime()), workspaceFreeBytes: Number(filesystem.bavail) * Number(filesystem.bsize),
    fileCount: entries.filter(entry => !['.local', '.git', '.ssh', '.termux'].includes(entry.name)).length,
  }
}

export function inspectTask(tasks: TaskStore, id: string): JefTask {
  const task = tasks.get(id)
  if (!task) throw new Error('Task not found.')
  return task
}
