/* ONEMA SAÚDE — service worker
 * Política: armazena SOMENTE arquivos estáticos do aplicativo (app shell).
 * Nunca armazena respostas de /api (dados de saúde, sessões, mídia privada ou documentos).
 * Offline com dados clínicos não está previsto no escopo (P-011): a interface informa indisponibilidade.
 */
const VERSION = '__SW_VERSION__';
const CACHE = `onema-shell-${VERSION}`;
const PRECACHE = __PRECACHE__;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // rede apenas, sem cache
  if (req.mode === 'navigate') {
    // Rede primeiro; sem conexão, entrega o app shell (que exibe o aviso de indisponibilidade).
    event.respondWith(fetch(req).catch(() => caches.match('/', { cacheName: CACHE })));
    return;
  }
  event.respondWith(caches.match(req, { cacheName: CACHE }).then((hit) => hit || fetch(req)));
});
