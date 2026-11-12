import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CredentialVault } from '../server/ai/credential-vault.ts'
import { loadGithubWriteConfig, saveGithubWriteConfig } from '../server/agent/github-write-config.ts'
import { GithubWorkflowService } from '../server/agent/github-workflow.ts'
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
