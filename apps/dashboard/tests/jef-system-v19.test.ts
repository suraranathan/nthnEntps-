import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { inspectEnvironment, inspectTask } from '../server/agent/system-tools.ts'
import { TaskStore } from '../server/agent/tasks.ts'
import { PathPolicy } from '../server/agent/permissions.ts'
import { ToolRegistry } from '../server/agent/tools.ts'
import { createSourceManifest } from '../server/agent/self-development.ts'

test('environment inspection reports the selected workspace without private paths', async t => {
  const root = await mkdtemp(join(tmpdir(), 'jef-system-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'project.txt'), 'hello')
  const info = await inspectEnvironment({ workspace: root, paths: new PathPolicy({ root }), signal: new AbortController().signal })
  assert.equal(info.workspace, root)
  assert.equal(info.platform.length > 0, true)
  assert.equal(info.fileCount, 1)
  assert.equal(JSON.stringify(info).includes('apiKey'), false)
})

test('task inspection returns persisted progress for the current task', async t => {
  const root = await mkdtemp(join(tmpdir(), 'jef-system-'))
  const store = new TaskStore(join(root, 'tasks.sqlite'))
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }) })
  const task = store.create('conversation', 'Inspect project', 8)
  store.append(task.id, 'tool', 'read_file succeeded')
  const info = inspectTask(store, task.id)
  assert.equal(info.objective, 'Inspect project')
  assert.equal(info.events[0].summary, 'read_file succeeded')
  assert.throws(() => inspectTask(store, 'other-task'))
})

test('Jef can call environment and current-task tools without accessing other task IDs', async t => {
  const root = await mkdtemp(join(tmpdir(), 'jef-system-'))
  const store = new TaskStore(join(root, 'tasks.sqlite'))
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }) })
  const task = store.create('conversation', 'Inspect', 8)
  const tools = new ToolRegistry({ tasks: store })
  const context = { workspace: root, paths: new PathPolicy({ root }), signal: new AbortController().signal, taskId: task.id }
  const environment = await tools.execute('inspect_environment', {}, context)
  const progress = await tools.execute('task_status', {}, context)
  assert.equal(environment.ok, true)
  assert.match(progress.output, /Inspect/)
  assert.equal(tools.list().find(item => item.name === 'task_status')?.requiresApproval, false)
})

test('self-development path policy permits approved app source while protecting bootstrap', async t => {
  const root = await mkdtemp(join(tmpdir(), 'jef-selfdev-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await import('node:fs/promises').then(fs => fs.mkdir(join(root, 'apps/nthn/branding'), { recursive: true }))
  await import('node:fs/promises').then(fs => fs.mkdir(join(root, 'apps/nthn/bootstrap'), { recursive: true }))
  const paths = new PathPolicy({ root, writablePrefixes: ['.'], allowNTHNSourceWrites: true })
  assert.match(await paths.resolveForWrite('apps/nthn/branding/Source.java'), /Source\.java$/)
  await assert.rejects(paths.resolveForWrite('apps/nthn/bootstrap/config.sh'), /protected/i)
})

test('self-development manifest hashes actual source and rejects symlink escape', async t => {
  const root = await mkdtemp(join(tmpdir(), 'jef-manifest-'))
  const outside = await mkdtemp(join(tmpdir(), 'jef-outside-'))
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }) })
  const fs = await import('node:fs/promises')
  await fs.mkdir(join(root, 'apps/nthn'), { recursive: true })
  await fs.mkdir(join(root, 'apps/dashboard/server/agent'), { recursive: true })
  await writeFile(join(root, 'apps/nthn/VERSION'), '1.9\n')
  await writeFile(join(root, 'apps/dashboard/server/agent/agent.ts'), 'export const agent = true\n')
  const manifest = await createSourceManifest(root)
  assert.equal(manifest.version, '1.9')
  assert.equal(manifest.files.length, 2)
  assert.match(manifest.rootSha256, /^[a-f0-9]{64}$/)
  const tools = new ToolRegistry()
  const result = await tools.execute('source_manifest', {}, { workspace: root, paths: new PathPolicy({ root }), signal: new AbortController().signal })
  assert.equal(result.ok, true)
  assert.match(result.output, /rootSha256/)
  await writeFile(join(outside, 'private.txt'), 'private')
  await fs.symlink(join(outside, 'private.txt'), join(root, 'apps/nthn/leak.txt'))
  await assert.rejects(createSourceManifest(root), /symlink/i)
})
