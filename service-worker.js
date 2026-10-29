// Service worker: solo recursos estáticos propios. Nunca se guardan en caché transmisiones, listas,
// guías ni logotipos de terceros (todo lo que no sea del mismo origen pasa directo a la red).
const VERSION = 'v1.2.0';
const CACHE = 'nova-iptv-' + VERSION;
const ASSETS = [
  './', './index.html', './manifest.webmanifest',
  './css/styles.css', './css/layout.css', './css/player.css',
  './js/app.js', './js/config.js', './js/m3u-parser.js', './js/playlist-manager.js', './js/player.js',
  './js/storage.js', './js/favorites.js', './js/search.js', './js/epg.js', './js/vendor/hls.min.js',
  './assets/icons/icon.svg', './assets/icons/icon-192.png', './assets/icons/icon-512.png', './assets/icons/icon-maskable-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('nova-iptv-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return; // streams/listas/logos: red directa
  if (req.headers.has('range')) return; // nunca interferir con peticiones de medios

  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(() => caches.match('./index.html')));
    return;
  }
  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    })),
  );
});
