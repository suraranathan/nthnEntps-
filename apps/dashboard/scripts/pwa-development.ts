// Runs in fresh dev HTML, before potentially stale cached entry modules execute.
// Only this dashboard's worker and app-shell caches are removed.
export const developmentPwaReset = `
(async () => {
  if (!('serviceWorker' in navigator)) return;
  const workerUrl = new URL('/service-worker.js', location.origin).href;
  const controlled = navigator.serviceWorker.controller?.scriptURL === workerUrl;
  const registrations = await navigator.serviceWorker.getRegistrations();
  let removed = false;
  for (const registration of registrations) {
    if ([registration.active, registration.waiting, registration.installing].some(worker => worker?.scriptURL === workerUrl)) {
      removed = await registration.unregister() || removed;
    }
  }
  if ('caches' in window) {
    await Promise.all((await caches.keys()).filter(key => key.startsWith('nthnentps-shell-')).map(key => caches.delete(key)));
  }
  if (controlled && removed) location.reload();
})().catch(() => console.warn('Dashboard cache reset failed. Clear this site’s cached data and reload.'));
`

// An existing registration's automatic update must receive JavaScript, not Vite's HTML fallback.
export const retiredWorker = `
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil((async () => {
  await Promise.all((await caches.keys()).filter(key => key.startsWith('nthnentps-shell-')).map(key => caches.delete(key)));
  await self.clients.claim();
  await self.registration.unregister();
})()));
`
