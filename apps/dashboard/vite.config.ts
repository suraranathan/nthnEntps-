import { createHash } from 'node:crypto'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

const shellAssets = [
  '/manifest.webmanifest',
  '/icons/app-icon-192.png',
  '/icons/app-icon-512.png',
]

function dashboardPwa(): Plugin {
  return {
    name: 'nthnentps-pwa-shell',
    apply: 'build',
    generateBundle(_options, bundle) {
      const bundleFiles = Object.keys(bundle).map((file) => `/${file}`)
      const precacheUrls = ['/', ...bundleFiles, ...shellAssets]
      const buildId = createHash('sha256')
        .update(`${Date.now()}\n${precacheUrls.join('\n')}`)
        .digest('hex')
        .slice(0, 12)

      const source = `const CACHE_PREFIX = 'nthnentps-shell-';
const CACHE_NAME = CACHE_PREFIX + '${buildId}';
const PRECACHE_URLS = ${JSON.stringify(precacheUrls)};

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
          .map((key) => caches.delete(key)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || request.method !== 'GET' || url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(async () => {
        const cache = await caches.open(CACHE_NAME);
        return (await cache.match('/index.html')) || (await cache.match('/')) || Response.error();
      }),
    );
    return;
  }

  if (['script', 'style', 'image', 'font', 'manifest'].includes(request.destination)) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        const cached = await cache.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        if (response.ok) await cache.put(request, response.clone());
        return response;
      }),
    );
  }
});
`

      this.emitFile({ type: 'asset', fileName: 'service-worker.js', source })
    },
  }
}

export default defineConfig({
  plugins: [react(), dashboardPwa()],
  preview: { host: '0.0.0.0', port: 3000, strictPort: true, proxy: { '/api': { target: 'http://127.0.0.1:3001', changeOrigin: false } } },
  server: {
    fs: { deny: ['.env', '.env.*', '*.{crt,pem,key}', '**/.git/**', '**/.local/**', '**/alex.json', '**/alex-*.tmp', '**/runtime.lock'] },
    proxy: { '/api': { target: 'http://127.0.0.1:3001', changeOrigin: false } },
    host: '0.0.0.0',
    port: 3000,
    strictPort: true,
  },
})
