/* Service worker: precache the app shell so the app opens offline.
   API calls (script.google.com) are never cached here — app.js keeps its own
   localStorage cache of holdings/quotes/history for offline use. */
// holdings.csv is intentionally NOT precached: it only exists in local dev
// (it is excluded from the public repo) and precache addAll() would fail on
// hosting where it 404s. The runtime SWR handler still caches it in dev.
const CACHE = 'stock-tracker-v8';
const SHELL = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'chart.js',
  'manifest.json',
  'icon.svg',
  'icon-180.png',
  'icon-192.png',
  'icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Never intercept API calls — neither the remote Apps Script (different
  // origin) nor the local dev server's same-origin /api endpoint.
  if (e.request.method !== 'GET' || url.origin !== location.origin ||
      url.pathname.replace(/\/$/, '').endsWith('/api')) return;
  // Stale-while-revalidate for the shell: serve cache fast, refresh in background.
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((cached) => {
      const fetched = fetch(e.request)
        .then((res) => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, clone));
          }
          return res;
        })
        .catch(() => cached);
      return cached || fetched;
    })
  );
});
