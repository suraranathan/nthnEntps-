import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chooseMobileWorkspace, listMobileProjects, loadMobileWorkspace } from '../server/agent/mobile-workspace.ts'

test('mobile project selection persists an existing directory and isolates its conversation store', () => {
  const root = mkdtempSync(join(tmpdir(), 'nthn-project-'))
  try {
    const home = join(root, 'home')
    const state = join(root, 'agent')
    mkdirSync(join(home, 'my-app'), { recursive: true })
    assert.equal(loadMobileWorkspace(home, state).workspace, home)
    const chosen = chooseMobileWorkspace(home, state, 'my-app')
    assert.equal(chosen.workspace, join(home, 'my-app'))
    assert.notEqual(chosen.storeDirectory, state)
    assert.deepEqual(loadMobileWorkspace(home, state), chosen)
    assert.deepEqual(listMobileProjects(home), ['my-app'])
    assert.deepEqual(JSON.parse(readFileSync(join(state, 'workspace.json'), 'utf8')), { path: 'my-app' })
    assert.equal(chooseMobileWorkspace(home, state, '.').storeDirectory, state)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('mobile project selection rejects paths outside home, files, and private agent state', () => {
  const root = mkdtempSync(join(tmpdir(), 'nthn-project-'))
  try {
    const home = join(root, 'home')
    const state = join(root, 'agent')
    mkdirSync(home)
    mkdirSync(join(home, '.local'))
    writeFileSync(join(home, 'file.txt'), 'text')
    mkdirSync(join(root, 'outside'))
    symlinkSync(join(root, 'outside'), join(home, 'escape'))
    symlinkSync(join(home, '.local'), join(home, 'private-link'))
    for (const path of ['../outside', join(root, 'outside'), '.local', 'file.txt', 'escape', 'private-link']) {
      assert.throws(() => chooseMobileWorkspace(home, state, path), { name: 'Error' }, path)
    }
    assert.equal(loadMobileWorkspace(home, state).workspace, home)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
