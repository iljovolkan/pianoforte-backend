// PianoForte service worker — овозможува инсталирање како апликација (Add to
// Home Screen) и минимален offline fallback за самата обвивка на страницата.
// НЕ ги кешира API повиците (/auth, /groups итн.) — тие секогаш мора да се
// свежи од серверот.

const CACHE_NAME = 'pianoforte-shell-v1';
const SHELL_FILES = [
  '/',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // никогаш не кешираj API повици — секогаш мора да одат до серверот
  const isApiCall = ['/auth', '/groups', '/schedule', '/materials', '/packages',
    '/purchases', '/admin', '/subscriptions', '/installments', '/health']
    .some((p) => url.pathname.startsWith(p));
  if (isApiCall || event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
