import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isNTHNSourceWorkspace } from '../server/agent/workspace-policy.ts'

test('prepared NTHN clones enable the narrow source-write policy regardless of directory name', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'nthn-source-workspace-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  await mkdir(join(workspace, 'apps/nthn'), { recursive: true })
  await mkdir(join(workspace, 'apps/dashboard/server/agent'), { recursive: true })
  await writeFile(join(workspace, 'apps/nthn/VERSION'), '2\n')
  await writeFile(join(workspace, 'apps/dashboard/server/agent/agent.ts'), '')

  assert.equal(isNTHNSourceWorkspace(workspace), true)
  await rm(join(workspace, 'apps/nthn/VERSION'))
  assert.equal(isNTHNSourceWorkspace(workspace), false)
})
