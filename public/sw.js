// Bloom Service Worker — alpha
// Strategy:
//   • HTML / navigation  → network-first (always get the latest index.html, so it
//     references the newest hashed JS/CSS). Falls back to cache only when offline.
//   • Hashed build assets → cache-first (safe: Vite gives each build new filenames,
//     so a new deploy is a new URL = automatic refresh; no manual version bump needed).
//   • API calls           → never cached.
// This avoids the "tester is stuck on an old build after a deploy" problem: the only
// cache-first responses are content-hashed files that change name when they change.

const CACHE = 'bloom-alpha-v2';
const SHELL = ['/', '/index.html'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Treat navigations and HTML documents as "pages" that must stay fresh.
function isPageRequest(req) {
  if (req.mode === 'navigate') return true;
  const accept = req.headers.get('accept') || '';
  return accept.includes('text/html');
}

self.addEventListener('fetch', e => {
  const req = e.request;

  // Only handle GET; let the browser deal with POST/etc. and never cache API traffic.
  if (req.method !== 'GET' || req.url.includes('api.anthropic.com')) return;

  if (isPageRequest(req)) {
    // Network-first: fetch fresh, update cache, fall back to cache offline.
    e.respondWith(
      fetch(req)
        .then(res => {
          if (res && res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then(c => c.put(req, clone));
          }
          return res;
        })
        .catch(() => caches.match(req).then(cached => cached || caches.match('/index.html')))
    );
    return;
  }

  // Static assets: cache-first (filenames are content-hashed by the build).
  e.respondWith(
    caches.match(req).then(cached => {
      if (cached) return cached;
      return fetch(req).then(res => {
        if (res && res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(req, clone));
        }
        return res;
      });
    })
  );
});
