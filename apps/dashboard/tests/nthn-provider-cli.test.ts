import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { connectionSummary, selectionIsCurrent } from '../server/ai/nthn-cli-state.ts'
import type { CatalogEntry } from '../server/ai/contracts.ts'
import type { ManagedConnection } from '../server/ai/management-types.ts'

test('packaged nthn provider command runs in isolated app storage', () => {
  const source = resolve('server/ai')
  const root = mkdtempSync(join(tmpdir(), 'nthn-provider-'))
  const target = join(root, 'server/ai')
  mkdirSync(target, { recursive: true })
  for (const name of readdirSync(source).filter(name => name.endsWith('.ts'))) copyFileSync(join(source, name), join(target, name))
  const cli = join(target, 'nthn-cli.ts')
  assert.match(execFileSync(process.execPath, [cli, 'help'], { encoding: 'utf8' }), /nthn-ai select MODEL_ID/)
  assert.match(execFileSync(process.execPath, [cli, 'help'], { encoding: 'utf8' }), /nthn-ai auto-select/)
  const state = JSON.parse(execFileSync(process.execPath, [cli, 'status'], { encoding: 'utf8' }))
  assert.deepEqual(state, { connection: 'Not connected', credentials: 'missing', selectedModel: null })
  assert.equal(statSync(join(root, '.local/ai/master.key')).mode & 0o077, 0)
  assert.equal(readFileSync(join(root, '.local/ai/master.key')).length, 32)

  const piped = spawnSync(process.execPath, [cli, 'configure-stdin'], { input: '', encoding: 'utf8' })
  assert.equal(piped.status, 1)
  assert.match(piped.stderr, /INVALID_INPUT/)
  assert.doesNotMatch(`${piped.stdout}${piped.stderr}`, /api key/i)
})

test('nthn keeps configured credentials connected and rejects stale selected routes', () => {
  const connection = {
    id: '11111111-1111-4111-8111-111111111111', enabled: true, revision: 3,
    credentials: { state: 'configured', revision: 1 },
    health: { authentication: 'accepted', discovery: 'never-tested', inference: 'never-tested', checkedAt: null },
  } as ManagedConnection
  const selection = { routeId: 'saved-route', modelId: 'openrouter/model' }
  const entry = {
    route: { id: selection.routeId, ref: { connectionId: connection.id }, connectionRevision: 2, lifecycle: 'active' },
  } as CatalogEntry

  assert.equal(connectionSummary(connection), 'connected')
  assert.equal(selectionIsCurrent(selection, entry, connection), false)
  entry.route.connectionRevision = connection.revision
  assert.equal(selectionIsCurrent(selection, entry, connection), true)
})
