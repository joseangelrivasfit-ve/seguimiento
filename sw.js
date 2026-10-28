/* Service worker mínimo: guarda la estructura de la web para abrirla sin conexión.
 * Siempre intenta la red primero para que los cambios se vean al instante.
 * Los videos no pasan por aquí. Sube VERSION si quieres forzar una limpieza de caché. */
var VERSION = 'v1';
var CACHE = 'seguimiento-' + VERSION;
var SHELL = ['./', 'index.html', 'app.js', 'config.js', 'styles.css', 'manifest.webmanifest', 'icon.svg'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  var url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (/\.(mp4|webm|mov|gif)$/i.test(url.pathname) || req.headers.has('range')) return;
  e.respondWith(
    fetch(req).then(function (res) {
      var copy = res.clone();
      caches.open(CACHE).then(function (c) { c.put(req, copy); });
      return res;
    }).catch(function () { return caches.match(req).then(function (hit) { return hit || caches.match('index.html'); }); })
  );
});
