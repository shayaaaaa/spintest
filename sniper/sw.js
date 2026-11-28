// Offline cache: every file the game needs is stored on first visit, then served from the cache.
const CACHE = 'deadeye-outpost-v4';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './js/main.js',
  './js/game.js',
  './js/horde.js',
  './js/ui.js',
  './js/world.js',
  './js/models.js',
  './js/fx.js',
  './js/audio.js',
  './js/data.js',
  './js/save.js',
  './js/three.module.min.js',
  './fonts/saira-condensed-latin-600-normal.woff2',
  './fonts/saira-condensed-latin-800-normal.woff2',
  './fonts/saira-stencil-one-latin-400-normal.woff2',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', e => {
  // cache: 'reload' skips the browser's HTTP cache so an update always gets fresh files
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then(hit => hit || fetch(req).then(res => {
      if (res.ok && new URL(req.url).origin === location.origin) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy));
      }
      return res;
    }).catch(() => (req.mode === 'navigate' ? caches.match('./index.html') : Response.error())))
  );
});
