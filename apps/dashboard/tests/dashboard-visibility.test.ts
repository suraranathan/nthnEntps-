import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'
import { createServer } from 'vite'
import config from '../vite.config.ts'
import { developmentPwaReset } from '../scripts/pwa-development.ts'

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

test('dev serves current navigation, provider component, visible CSS and a valid retirement worker', async t => {
  const server = await createServer({ configFile: new URL('../vite.config.ts', import.meta.url).pathname, logLevel: 'silent', server: { host: '127.0.0.1', port: 0, strictPort: false } })
  t.after(() => server.close())
  await server.listen()
  const address = server.httpServer!.address(); assert.ok(address && typeof address === 'object')
  const base = `http://127.0.0.1:${address.port}`
  const html = await (await fetch(base)).text()
  assert.ok(html.indexOf('getRegistrations') < html.indexOf('src="/src/main.tsx"'))
  const app = await (await fetch(base + '/src/App.tsx')).text()
  assert.match(app, /"Office", "Agents", "Activity", "AI Providers"/)
  assert.match(app, /activeTab === "AI Providers" &&/)
  assert.match(await (await fetch(base + '/src/AiProviders.tsx')).text(), /providers-title/)
  assert.match(await (await fetch(base + '/src/styles.css')).text(), /\.dashboard-nav \{ display: flex/)
  const worker = await fetch(base + '/service-worker.js')
  assert.match(worker.headers.get('content-type')!, /javascript/)
  assert.equal(worker.headers.get('cache-control'), 'no-store')
  assert.match(await worker.text(), /registration.unregister/)
})
