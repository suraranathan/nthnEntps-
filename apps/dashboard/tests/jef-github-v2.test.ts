import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CredentialVault } from '../server/ai/credential-vault.ts'
import { loadGithubWriteConfig, saveGithubWriteConfig } from '../server/agent/github-write-config.ts'
import { GithubWorkflowService } from '../server/agent/github-workflow.ts'
import { GithubSourceService, type GitRunner } from '../server/agent/github-source.ts'
import { PathPolicy } from '../server/agent/permissions.ts'
import { ToolRegistry } from '../server/agent/tools.ts'

test('GitHub write credential is encrypted and separate from read access', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nthn-gh-v2-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = join(directory, 'github-write.json')
  const vault = new CredentialVault(Buffer.alloc(32, 4))
  await saveGithubWriteConfig(file, { token: 'github-write-test-token' }, vault)
  assert.doesNotMatch(await readFile(file, 'utf8'), /github-write-test-token/)
  assert.deepEqual(loadGithubWriteConfig(file, vault), { token: 'github-write-test-token' })
  vault.destroy()
})

test('workflow dispatch checks the remote branch version before running the fixed workflow', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const service = new GithubWorkflowService('test-token', async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} })
    return String(url).includes('/contents/apps/nthn/VERSION')
      ? Response.json({ content: Buffer.from('2\n').toString('base64'), encoding: 'base64' })
      : new Response(null, { status: 204 })
  })
  await assert.rejects(() => service.dispatch('main;echo secret', '1.9'), /Invalid GitHub branch/)
  await service.dispatch('codex/jef-v2', '1.9')
  assert.equal(calls.length, 2)
  assert.equal(calls[0].url, 'https://api.github.com/repos/suraranathan/nthnEntps-/contents/apps/nthn/VERSION?ref=codex%2Fjef-v2')
  assert.equal(calls[1].url, 'https://api.github.com/repos/suraranathan/nthnEntps-/actions/workflows/nthn-build-separate.yml/dispatches')
  assert.deepEqual(JSON.parse(String(calls[1].init.body)), { ref: 'codex/jef-v2' })
  assert.equal((calls[1].init.headers as Record<string, string>).Authorization, 'Bearer test-token')
})

test('workflow dispatch refuses a branch at the installed version', async () => {
  let posted = false
  const service = new GithubWorkflowService('test-token', async () => {
    if (posted) throw new Error('unexpected request')
    posted = true
    return Response.json({ content: Buffer.from('1.9\n').toString('base64'), encoding: 'base64' })
  })
  await assert.rejects(() => service.dispatch('codex/jef-v2', '1.9'), /newer NTHN version/)
  assert.equal(posted, true)
})

test('workflow status validates the run and returns only bounded build state', async () => {
  const calls: string[] = []
  const service = new GithubWorkflowService('test-token', async url => {
    calls.push(String(url))
    return Response.json({ id: 43157797332, name: 'Build independent nthn APK', event: 'workflow_dispatch', status: 'completed', conclusion: 'success', html_url: 'https://github.com/suraranathan/nthnEntps-/actions/runs/43157797332', head_branch: 'codex/jef-v2', head_sha: 'c8b0eafc11d666893d064a897b125f567bc2cbd4' })
  })
  await assert.rejects(() => service.status('1;echo secret'), /Invalid GitHub workflow run/)
  const status = await service.status('43157797332')
  assert.deepEqual(status, { runId: 43157797332, status: 'completed', conclusion: 'success', branch: 'codex/jef-v2', commit: 'c8b0eafc11d666893d064a897b125f567bc2cbd4', url: 'https://github.com/suraranathan/nthnEntps-/actions/runs/43157797332' })
  assert.deepEqual(calls, ['https://api.github.com/repos/suraranathan/nthnEntps-/actions/runs/43157797332'])
})

test('Jef exposes approved dispatch and read-only workflow monitoring tools', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'nthn-gh-tools-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  await mkdir(join(workspace, 'apps'), { recursive: true })
  const service = new GithubWorkflowService('test-token', async (url, init) => {
    if (String(url).includes('/contents/')) return Response.json({ content: Buffer.from('2\n').toString('base64'), encoding: 'base64' })
    if (init?.method === 'POST') return new Response(null, { status: 204 })
    return Response.json({ id: 43157797332, name: 'Build independent nthn APK', event: 'workflow_dispatch', status: 'completed', conclusion: 'success', html_url: 'https://github.com/suraranathan/nthnEntps-/actions/runs/43157797332', head_branch: 'codex/jef-v2', head_sha: 'c8b0eafc11d666893d064a897b125f567bc2cbd4' })
  })
  const tools = new ToolRegistry({ githubWorkflow: service, installedVersion: '1.9' })
  const context = { workspace, paths: new PathPolicy({ root: workspace, writablePrefixes: ['.'] }), signal: new AbortController().signal }
  assert.equal(tools.needsApproval('github_dispatch', { branch: 'codex/jef-v2' }), true)
  assert.equal((await tools.execute('github_dispatch', { branch: 'codex/jef-v2' }, context)).ok, true)
  const result = await tools.execute('github_workflow_status', { runId: '43157797332' }, context)
  assert.equal(result.ok, true)
  assert.equal(JSON.parse(result.output).conclusion, 'success')
})

test('GitHub source service prepares and pushes only the fixed NTHN repository without token arguments', async t => {
  const home = await mkdtemp(join(tmpdir(), 'nthn-source-home-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = []
  let dirty = false
  const runner: GitRunner = async (args, options) => {
    calls.push({ args, env: options.env })
    if (args[0] === 'clone') await mkdir(join(options.cwd, '.git'), { recursive: true })
    if (args.includes('status')) return { stdout: dirty ? ' M apps/nthn/VERSION\n' : '', stderr: '' }
    if (args.includes('branch')) return { stdout: 'codex/jef-v2\n', stderr: '' }
    if (args.includes('get-url')) return { stdout: 'https://github.com/suraranathan/nthnEntps-.git\n', stderr: '' }
    if (args.includes('rev-list')) return { stdout: args.at(-1)?.startsWith('HEAD..') ? '0\n' : '1\n', stderr: '' }
    if (args.includes('diff')) return { stdout: 'apps/nthn/VERSION\napps/dashboard/server/agent/tools.ts\n', stderr: '' }
    if (args.includes('rev-parse')) return { stdout: '4f1c9d90899f6ee1bfd930809ed4cf2661e17f6b\n', stderr: '' }
    return { stdout: '', stderr: '' }
  }
  const service = new GithubSourceService('github-write-test-token', runner)
  assert.deepEqual(await service.prepare(home, 'codex/jef-v2'), { project: 'nthnEntps-v2', branch: 'codex/jef-v2', commit: '4f1c9d90899f6ee1bfd930809ed4cf2661e17f6b' })
  assert.deepEqual(await service.push(join(home, 'nthnEntps-v2'), 'codex/jef-v2'), { branch: 'codex/jef-v2', commit: '4f1c9d90899f6ee1bfd930809ed4cf2661e17f6b', changed: ['apps/nthn/VERSION', 'apps/dashboard/server/agent/tools.ts'] })
  assert.equal(calls.some(call => call.args.join(' ').includes('github-write-test-token')), false)
  assert.equal(calls.some(call => call.env.GIT_CONFIG_VALUE_0 === 'Authorization: Bearer github-write-test-token'), true)
  dirty = true
  await assert.rejects(() => service.push(join(home, 'nthnEntps-v2'), 'codex/jef-v2'), /uncommitted changes/)
  await assert.rejects(() => service.push(join(home, 'nthnEntps-v2'), 'main'), /development branch/)
  dirty = false
  await rm(join(home, 'nthnEntps-v2'), { recursive: true, force: true })
  const tools = new ToolRegistry({ githubSource: service, linuxHome: home })
  assert.equal(tools.needsApproval('github_prepare_source', { branch: 'codex/jef-v2' }), true)
  assert.equal((await tools.execute('github_prepare_source', { branch: 'codex/jef-v2' }, { workspace: home, paths: new PathPolicy({ root: home, writablePrefixes: ['.'] }), signal: new AbortController().signal })).ok, true)
  const prepared = join(home, 'nthnEntps-v2')
  assert.equal((await tools.execute('github_push_source', { branch: 'codex/jef-v2' }, { workspace: prepared, paths: new PathPolicy({ root: prepared, writablePrefixes: ['.'] }), signal: new AbortController().signal })).ok, true)
})
