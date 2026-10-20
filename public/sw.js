// Minimal service worker: makes the app installable and caches the static shell.
// API and auth calls always go to the network (never cached).
const CACHE = 'devin-control-v4';
const SHELL = [
  '/',
  '/style.css',
  '/manifest.webmanifest',
  '/icon.svg',
  '/js/app.js',
  '/js/core.js',
  '/js/charts.js',
  '/js/sessions.js',
  '/js/dashboard.js',
  '/js/projects.js',
  '/js/local.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) return;
  // Network first, fall back to cache (so updates show up immediately when online).
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
