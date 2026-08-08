/* Scope-local app shell cache. Data remains managed by the local app API. */
const CACHE_PREFIX = 'local-attendance-shell-';
const CACHE_VERSION = 'dev'; // __CACHE_VERSION__
const CACHE_NAME = `${CACHE_PREFIX}${CACHE_VERSION}`;
const PRECACHE_PATHS = ['./', './index.html', './manifest.webmanifest']; // __PRECACHE_MANIFEST__

const scopeUrl = () => new URL(self.registration.scope);
const scopedUrl = (path) => new URL(path, scopeUrl()).href;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => (
    cache.addAll(PRECACHE_PATHS.map(scopedUrl))
  )));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
        .map((key) => caches.delete(key)),
    )).then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  const scope = scopeUrl();
  if (!url.pathname.startsWith(scope.pathname)) return;

  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(() => caches.match(scopedUrl('./index.html'))));
    return;
  }

  event.respondWith(caches.match(event.request).then((cached) => {
    if (cached) return cached;
    return fetch(event.request).then((response) => {
      // Keep same-origin runtime resources available without caching the worker itself.
      if (response.ok && response.type === 'basic' && url.href !== scopedUrl('./sw.js')) {
        void caches.open(CACHE_NAME).then((cache) => cache.put(event.request, response.clone()));
      }
      return response;
    });
  }));
});
