// PianoForte service worker — овозможува инсталирање како апликација (Add to
// Home Screen). Стратегија: HTML/навигацијата секогаш прво оди на мрежата
// (за корисникот веднаш да ги гледа најновите промени), статичните икони/
// manifest се cache-first (не се менуваат често). НЕ ги кешира API повиците.

const CACHE_NAME = 'pianoforte-shell-v2'; // зголемено — ja поништува старата верзија кај сите инсталирани корисници
const SHELL_FILES = [
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
    '/purchases', '/admin', '/subscriptions', '/installments', '/individual-bookings', '/health']
    .some((p) => url.pathname.startsWith(p));
  if (isApiCall || event.request.method !== 'GET') return;

  // Навигација / самата страница (index.html) — секогаш прво мрежа, кешот е
  // само резервна опција ако интернетот е прекинат (offline fallback)
  const isNavigation = event.request.mode === 'navigate' || url.pathname === '/' || url.pathname.endsWith('.html');
  if (isNavigation) {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return res;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Статични фајлови (икони, manifest) — cache-first, ретко се менуваат
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return res;
      });
    })
  );
});
