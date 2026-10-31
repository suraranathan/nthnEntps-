import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import config from '../vite.config.ts'
import { developmentPwaReset, retiredWorker } from '../scripts/pwa-development.ts'

test('dev HTML resets only dashboard caches and reloads once after removing its controller', async () => {
  let reloads = 0, unregistered = false
  const deleted: string[] = []
  const context = {
    navigator: { serviceWorker: {
      controller: { scriptURL: 'http://localhost:3000/service-worker.js' },
      getRegistrations: async () => unregistered ? [] : [{ active: { scriptURL: 'http://localhost:3000/service-worker.js' }, unregister: async () => { unregistered = true; return true } }, { active: { scriptURL: 'http://localhost:3000/unrelated.js' }, unregister: () => { throw Error('unrelated worker') } }],
    } },
    location: { origin: 'http://localhost:3000', reload: () => reloads++ }, URL,
    window: { caches: true }, caches: { keys: async () => ['nthnentps-shell-old', 'unrelated'], delete: async (key: string) => deleted.push(key) },
  }
  await runInNewContext(developmentPwaReset, context)
  await runInNewContext(developmentPwaReset, context)
  assert.equal(reloads, 1); assert.ok(deleted.every(key => key === 'nthnentps-shell-old'))
})

test('production worker cannot serve cached development source; previous policy reproduces stale navigation', async () => {
  const plugin = (config.plugins as any[]).find(p => p.name === 'nthnentps-pwa-shell')
  let source = ''
  plugin.generateBundle.call({ emitFile: (asset: { source: string; fileName: string }) => { if (asset.fileName === 'service-worker.js') source = asset.source } }, {}, { 'index.html': {}, 'assets/app-hash.js': {} })
  async function intercepted(script: string, pathname: string) {
    const listeners: Record<string, (event: any) => void> = {}
    let response: Promise<unknown> | undefined
    runInNewContext(script, { URL, self: { location: { origin: 'http://localhost:3000' }, addEventListener: (name: string, fn: (event: any) => void) => { listeners[name] = fn } }, caches: { open: async () => ({ match: async () => 'STALE NAVIGATION' }) } })
    listeners.fetch({ request: { url: 'http://localhost:3000' + pathname, method: 'GET', destination: 'script' }, respondWith: (value: Promise<unknown>) => { response = value } })
    return response ? await response : 'NETWORK'
  }
  const oldPolicy = source.replace('PRECACHE_URLS.includes(url.pathname) && ', '')
  assert.equal(await intercepted(oldPolicy, '/src/App.tsx'), 'STALE NAVIGATION')
  assert.equal(await intercepted(source, '/src/App.tsx'), 'NETWORK')
  assert.equal(await intercepted(source, '/assets/app-hash.js'), 'STALE NAVIGATION', 'Production precache is preserved')
  assert.equal(await intercepted(source, '/api/ai'), 'NETWORK')
})

test('dashboard navigation and development cache reset remain configured', async () => {
  const plugin = (config.plugins as any[]).find(p => p.name === 'development-pwa-reset')
  assert.ok(plugin)
  const injected = plugin.transformIndexHtml()
  assert.match(injected[0].children, /getRegistrations/)
  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')
  assert.match(app, /'Office', 'Agents', 'Activity', 'AI Providers'/)
  assert.match(app, /activeTab === 'AI Providers' &&/)
  assert.match(await readFile(new URL('../src/AiProviders.tsx', import.meta.url), 'utf8'), /providers-title/)
  assert.match(await readFile(new URL('../src/styles.css', import.meta.url), 'utf8'), /\.dashboard-nav \{ display: flex/)
  assert.match(retiredWorker, /registration.unregister/)
})
