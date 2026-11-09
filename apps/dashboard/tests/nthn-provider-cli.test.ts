import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import * as cliState from '../server/ai/nthn-cli-state.ts'
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
  assert.match(execFileSync(process.execPath, [cli, 'help'], { encoding: 'utf8' }), /nthn-ai accounts/)
  assert.match(execFileSync(process.execPath, [cli, 'help'], { encoding: 'utf8' }), /nthn-ai add-account/)
  assert.deepEqual(JSON.parse(execFileSync(process.execPath, [cli, 'accounts'], { encoding: 'utf8' })), [])
  const state = JSON.parse(execFileSync(process.execPath, [cli, 'status'], { encoding: 'utf8' }))
  assert.deepEqual(state, { connection: 'Not connected', credentials: 'missing', selectedModel: null })
  assert.equal(statSync(join(root, '.local/ai/master.key')).mode & 0o077, 0)
  assert.equal(readFileSync(join(root, '.local/ai/master.key')).length, 32)

  const piped = spawnSync(process.execPath, [cli, 'configure-stdin'], { input: '', encoding: 'utf8' })
  assert.equal(piped.status, 1)
  assert.match(piped.stderr, /INVALID_INPUT/)
  assert.doesNotMatch(`${piped.stdout}${piped.stderr}`, /api key/i)
})

test('nthn retains multiple OpenRouter accounts and resolves a selection to its own account', () => {
  const openRouterAccounts = (cliState as typeof cliState & { openRouterAccounts?: (connections: ManagedConnection[]) => ManagedConnection[] }).openRouterAccounts
  const selectionConnection = (cliState as typeof cliState & { selectionConnection?: (selection: { routeId: string; modelId: string | null }, entry: CatalogEntry | null, connections: ManagedConnection[]) => ManagedConnection | undefined }).selectionConnection
  assert.equal(typeof openRouterAccounts, 'function')
  assert.equal(typeof selectionConnection, 'function')
  const first = {
    id: '11111111-1111-4111-8111-111111111111', providerId: 'openrouter', label: 'Personal', enabled: true, revision: 2,
    credentials: { state: 'configured', revision: 1 },
    health: { authentication: 'accepted', discovery: 'ok', inference: 'ok', checkedAt: new Date().toISOString() },
  } as ManagedConnection
  const second = {
    ...first, id: '22222222-2222-4222-8222-222222222222', label: 'Work', revision: 4,
  } as ManagedConnection
  const other = { ...first, id: '33333333-3333-4333-8333-333333333333', providerId: 'openai' } as ManagedConnection
  const accounts = openRouterAccounts!([first, other, second])
  assert.deepEqual(accounts.map(account => account.label), ['Personal', 'Work'])

  const selection = { routeId: 'work-route', modelId: 'openrouter/work-model' }
  const entry = {
    route: { id: selection.routeId, ref: { connectionId: second.id }, connectionRevision: second.revision, lifecycle: 'active' },
  } as CatalogEntry
  assert.equal(selectionConnection!(selection, entry, accounts)?.id, second.id)
  assert.equal(cliState.selectionIsCurrent(selection, entry, second), true)
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

  assert.equal(cliState.connectionSummary(connection), 'connected')
  assert.equal(cliState.selectionIsCurrent(selection, entry, connection), false)
  entry.route.connectionRevision = connection.revision
  assert.equal(cliState.selectionIsCurrent(selection, entry, connection), true)
})
