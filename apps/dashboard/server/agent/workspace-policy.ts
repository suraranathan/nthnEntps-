import { existsSync } from 'node:fs'
import { join } from 'node:path'

export function isNTHNSourceWorkspace(workspace: string): boolean {
  return existsSync(join(workspace, 'apps/nthn/VERSION')) &&
    existsSync(join(workspace, 'apps/dashboard/server/agent/agent.ts'))
}
