// Margin service worker: makes the app open instantly and work offline.
// It only caches the app's own files. Your data never passes through here.
const VERSION = 'margin-v1.4.2';
const FILES = [
  './', 'index.html', 'styles.css', 'app.js', 'engine.js', 'manifest.webmanifest',
  'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png',
  'fonts/serif-400.woff2', 'fonts/serif-400i.woff2', 'fonts/serif-500.woff2', 'fonts/serif-600.woff2',
  'fonts/sans-400.woff2', 'fonts/sans-500.woff2', 'fonts/sans-600.woff2',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' })))));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('message', (e) => { if (e.data === 'skipWaiting') self.skipWaiting(); });

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Pages: always serve the cached app shell (the URL fragment is never sent here).
  if (req.mode === 'navigate') {
    e.respondWith(caches.match('index.html').then((r) => r || fetch(req)));
    return;
  }
  e.respondWith(caches.match(req, { ignoreSearch: true }).then((r) => r || fetch(req)));
});
