const CACHE_PREFIX = 'pixel-tarot-';
const CACHE_NAME = `${CACHE_PREFIX}v5`;
const APP_SHELL = [
  './',
  './index.html',
  './tarot16.png',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png'
];
const APP_ROOT = new URL('./', self.location.href);
const APP_HTML = new URL('./index.html', APP_ROOT).href;
const APP_ASSETS = new Set(APP_SHELL.map(path => new URL(path, APP_ROOT).href));

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) => Promise.all(
      names.filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
        .map((name) => caches.delete(name))
    )).then(() => self.clients.claim())
  );
});

function cacheResponse(event, key, response) {
  // Keep writes alive without turning a cache-storage failure into a request failure.
  const copy = response.clone();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.put(key, copy)).catch(() => {})
  );
}

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== APP_ROOT.origin) return;

  // Only app entry pages may replace the offline HTML. Leave unrelated pages alone.
  if (event.request.mode === 'navigate') {
    if (url.pathname !== APP_ROOT.pathname && url.pathname !== new URL(APP_HTML).pathname) return;
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response.ok && !response.redirected &&
              (response.headers.get('content-type') || '').includes('text/html')) {
            cacheResponse(event, APP_HTML, response);
          }
          return response;
        })
        .catch(async () => {
          const cache = await caches.open(CACHE_NAME);
          return (await cache.match(APP_HTML)) || Response.error();
        })
    );
    return;
  }

  // Cache only known app assets, and never persist HTTP error responses.
  if (APP_ASSETS.has(url.href)) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        const cached = await cache.match(event.request);
        if (cached) return cached;
        const response = await fetch(event.request);
        if (response.ok && !response.redirected) cacheResponse(event, event.request, response);
        return response;
      })
    );
  }
});
