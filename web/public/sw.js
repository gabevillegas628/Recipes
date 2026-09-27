// Minimal service worker: makes the app installable. It deliberately caches nothing,
// so a new deploy always shows up on the next page load.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {
  // Let the browser handle every request normally.
});
