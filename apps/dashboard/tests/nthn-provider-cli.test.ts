import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'

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
  assert.deepEqual(state, { connection: null, credentials: 'missing', selectedModel: null })
  assert.equal(statSync(join(root, '.local/ai/master.key')).mode & 0o077, 0)
  assert.equal(readFileSync(join(root, '.local/ai/master.key')).length, 32)

  const piped = spawnSync(process.execPath, [cli, 'configure-stdin'], { input: '', encoding: 'utf8' })
  assert.equal(piped.status, 1)
  assert.match(piped.stderr, /INVALID_INPUT/)
  assert.doesNotMatch(`${piped.stdout}${piped.stderr}`, /api key/i)
})
