import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JefMemoryStore } from '../server/agent/memory.ts'

test('Jef memory persists personal and project facts and retrieves only relevant scopes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'jef-memory-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new JefMemoryStore(join(root, 'memory.json'))
  await store.add({ scope: 'personal', kind: 'preference', text: 'Prefer concise answers', source: 'user correction' })
  await store.add({ scope: 'project:one', kind: 'decision', text: 'Use Vite for the dashboard', source: 'chat' })
  await store.add({ scope: 'project:two', kind: 'decision', text: 'Use Python for the script', source: 'chat' })
  const reopened = new JefMemoryStore(join(root, 'memory.json'))
  assert.deepEqual(reopened.relevant('project:one', 'dashboard Vite', 5).map(item => item.text), ['Use Vite for the dashboard', 'Prefer concise answers'])
  assert.equal(reopened.list('project:one').some(item => item.text.includes('Python')), false)
  assert.equal((await readFile(join(root, 'memory.json'), 'utf8')).includes('Use Vite'), true)
})

test('Jef memory rejects secrets and supports edit, pin, and deletion', async t => {
  const root = await mkdtemp(join(tmpdir(), 'jef-memory-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new JefMemoryStore(join(root, 'memory.json'))
  await assert.rejects(store.add({ scope: 'personal', kind: 'fact', text: 'API key sk-12345678901234567890', source: 'chat' }))
  const item = await store.add({ scope: 'personal', kind: 'goal', text: 'Build NTHN', source: 'user' })
  await store.update(item.id, { text: 'Build the NTHN app', pinned: true })
  assert.equal(store.list('personal')[0].pinned, true)
  assert.equal(store.list('personal')[0].text, 'Build the NTHN app')
  await store.remove(item.id)
  assert.equal(store.list('personal').length, 0)
})

test('file-backed project memory becomes stale after the cited file changes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'jef-memory-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'config.txt'), 'Vite')
  const store = new JefMemoryStore(join(root, 'memory.json'), root)
  const item = await store.add({ scope: 'project:one', kind: 'fact', text: 'Build uses Vite', source: 'config.txt', sourcePath: 'config.txt' })
  assert.equal(store.list('project:one')[0].stale, false)
  await writeFile(join(root, 'config.txt'), 'Webpack')
  assert.equal(store.list('project:one')[0].stale, true)
  assert.equal(store.relevant('project:one', 'build', 5).some(memory => memory.id === item.id), false)
})


test('file-backed memory never fingerprints a symlink outside the project', async t => {
  const root = await mkdtemp(join(tmpdir(), 'jef-memory-'))
  const outside = await mkdtemp(join(tmpdir(), 'jef-outside-'))
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }) })
  await writeFile(join(outside, 'private.txt'), 'private')
  await symlink(join(outside, 'private.txt'), join(root, 'link.txt'))
  const store = new JefMemoryStore(join(root, 'memory.json'), root)
  const item = await store.add({ scope: 'project:x', kind: 'fact', text: 'Project uses Vite', source: 'link', sourcePath: 'link.txt' })
  assert.equal(item.sourcePath, undefined)
})

test('invalid saved memory fails closed instead of being overwritten', async t => {
  const root = await mkdtemp(join(tmpdir(), 'jef-memory-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = join(root, 'memory.json')
  await writeFile(file, '{invalid')
  assert.throws(() => new JefMemoryStore(file), /corrupt/i)
  assert.equal(await readFile(file, 'utf8'), '{invalid')
})
