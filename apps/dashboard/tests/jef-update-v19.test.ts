import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ReleaseUpdateService, parseRelease, parseChecksum, releaseHeaders } from '../server/agent/release-update.ts'
import { loadReleaseConfig, saveReleaseConfig } from '../server/agent/release-config.ts'
import { CredentialVault } from '../server/ai/credential-vault.ts'
import { randomBytes } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { PathPolicy } from '../server/agent/permissions.ts'
import { ToolRegistry } from '../server/agent/tools.ts'

test('release metadata accepts only the expected NTHN APK and checksum URLs', () => {
  const base = 'https://github.com/suraranathan/nthnEntps-/releases/download/v1.9/'
  const release = parseRelease({ tag_name: 'v1.9', assets: [
    { name: 'nthn-V1.9.apk', browser_download_url: `${base}nthn-V1.9.apk`, size: 1000 },
    { name: 'nthn-V1.9.sha256', browser_download_url: `${base}nthn-V1.9.sha256`, size: 80 },
  ] })
  assert.equal(release.version, '1.9')
  assert.equal(release.apkUrl, `${base}nthn-V1.9.apk`)
  assert.throws(() => parseRelease({ tag_name: 'v1.9', assets: [{ name: 'nthn-V1.9.apk', browser_download_url: 'https://evil.example/apk', size: 1000 }] }))
  assert.equal(parseChecksum(`${'a'.repeat(64)}  nthn-V1.9.apk\n`, 'nthn-V1.9.apk'), 'a'.repeat(64))
  assert.throws(() => parseChecksum(`${'a'.repeat(64)}  other.apk\n`, 'nthn-V1.9.apk'))
})

test('update download verifies SHA-256 before retaining an APK', async t => {
  const root = await mkdtemp(join(tmpdir(), 'jef-update-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const apk = Buffer.from('real apk bytes for fixture')
  const sha = createHash('sha256').update(apk).digest('hex')
  const service = new ReleaseUpdateService({
    fetchText: async url => url.pathname.endsWith('.sha256') ? `${sha}  nthn-V1.9.apk\n` : JSON.stringify({ tag_name: 'v1.9', assets: [
      { name: 'nthn-V1.9.apk', browser_download_url: 'https://github.com/suraranathan/nthnEntps-/releases/download/v1.9/nthn-V1.9.apk', size: apk.length },
      { name: 'nthn-V1.9.sha256', browser_download_url: 'https://github.com/suraranathan/nthnEntps-/releases/download/v1.9/nthn-V1.9.sha256', size: 80 },
    ] }),
    download: async (_url, file) => { await writeFile(file, apk); return { bytes: apk.length, sha256: sha } },
  })
  const release = await service.check('1.8')
  assert.equal(release?.version, '1.9')
  const result = await service.download(release!, root)
  assert.deepEqual(await readFile(result.path), apk)
  assert.equal(result.sha256, sha)
})

test('private release uses asset API and never forwards its token to a CDN', () => {
  const release = parseRelease({ tag_name: 'v1.9', assets: [
    { name: 'nthn-V1.9.apk', browser_download_url: 'https://github.com/suraranathan/nthnEntps-/releases/download/v1.9/nthn-V1.9.apk', url: 'https://api.github.com/repos/suraranathan/nthnEntps-/releases/assets/123', size: 1000 },
    { name: 'nthn-V1.9.sha256', browser_download_url: 'https://github.com/suraranathan/nthnEntps-/releases/download/v1.9/nthn-V1.9.sha256', url: 'https://api.github.com/repos/suraranathan/nthnEntps-/releases/assets/124', size: 80 },
  ] })
  assert.equal(release.apkAssetUrl, 'https://api.github.com/repos/suraranathan/nthnEntps-/releases/assets/123')
  assert.equal(releaseHeaders(new URL(release.apkAssetUrl!), 'private-token').Authorization, 'Bearer private-token')
  assert.equal(releaseHeaders(new URL('https://release-assets.githubusercontent.com/signed'), 'private-token').Authorization, undefined)
})

test('private release token is encrypted and can be cleared by its owner', async t => {
  const root = await mkdtemp(join(tmpdir(), 'jef-release-config-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = join(root, 'release.json')
  const vault = new CredentialVault(randomBytes(32))
  await saveReleaseConfig(file, { token: 'private-test-token' }, vault)
  assert.doesNotMatch(await readFile(file, 'utf8'), /private-test-token/)
  assert.deepEqual(loadReleaseConfig(file, vault), { token: 'private-test-token' })
  await saveReleaseConfig(file, { token: '' }, vault)
  assert.equal(loadReleaseConfig(file, vault), undefined)
  vault.destroy()
})

test('Jef checks and downloads only a verified newer NTHN release with approval', async t => {
  const root = await mkdtemp(join(tmpdir(), 'jef-update-tools-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, 'workspace'), downloads = join(root, 'downloads')
  await mkdir(workspace)
  const apk = Buffer.from('verified V2 apk fixture')
  const sha = createHash('sha256').update(apk).digest('hex')
  const service = new ReleaseUpdateService({
    fetchText: async url => url.pathname.endsWith('.sha256') ? `${sha}  nthn-V2.apk\n` : JSON.stringify({ tag_name: 'v2', assets: [
      { name: 'nthn-V2.apk', browser_download_url: 'https://github.com/suraranathan/nthnEntps-/releases/download/v2/nthn-V2.apk', size: apk.length },
      { name: 'nthn-V2.sha256', browser_download_url: 'https://github.com/suraranathan/nthnEntps-/releases/download/v2/nthn-V2.sha256', size: 80 },
    ] }),
    download: async (_url, file) => { await writeFile(file, apk); return { bytes: apk.length, sha256: sha } },
  })
  const tools = new ToolRegistry({ releaseUpdater: service, installedVersion: '1.9', updateDirectory: downloads })
  const context = { workspace, paths: new PathPolicy({ root: workspace, writablePrefixes: ['.'] }), signal: new AbortController().signal }
  assert.equal(tools.needsApproval('download_update', {}), true)
  assert.equal(JSON.parse((await tools.execute('check_update', {}, context)).output).version, '2')
  const result = await tools.execute('download_update', {}, context)
  assert.equal(result.ok, true)
  assert.deepEqual(await readFile(JSON.parse(result.output).path), apk)
})
