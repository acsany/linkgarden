const CACHE = 'linkgarden-static-__CACHE_VERSION__';
const PRECACHE = __PRECACHE__;
const STATIC_PATHS = new Set(PRECACHE);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) =>
        cache.addAll(PRECACHE.map((path) => new Request(path, { cache: 'reload' }))),
      ),
  );
});
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith('linkgarden-static-') && key !== CACHE)
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  // Never intercept authenticated data, agent tools, or tracked redirects.
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname === '/mcp' ||
    url.pathname.startsWith('/mcp/') ||
    url.pathname.startsWith('/r/')
  )
    return;
  if (STATIC_PATHS.has(url.pathname) && !url.search) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        const cached = await cache.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        if (response.ok && response.type === 'basic') await cache.put(request, response.clone());
        return response;
      })(),
    );
    return;
  }
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(async () => (await caches.match('/offline.html')) || Response.error()),
    );
  }
});
