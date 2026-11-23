/* Service worker : permet d'ouvrir l'application sans internet.
   Les pages viennent du réseau en priorité ; la copie gardée sert seulement hors connexion. */
const CACHE = 'suivi-ongles-v8';
const FICHIERS = ['./', './index.html', './app.js?v=7', './style.css?v=6', './manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FICHIERS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(cles => Promise.all(cles.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return; // les échanges avec le Google Sheet ne passent jamais par le cache
  const url = new URL(req.url);
  const memeSite = url.origin === self.location.origin;
  const polices = /fonts\.(googleapis|gstatic)\.com$/.test(url.hostname);
  if (!memeSite && !polices) return;
  e.respondWith(
    fetch(req).then(rep => {
      if (rep && rep.ok) { const copie = rep.clone(); caches.open(CACHE).then(c => c.put(req, copie)); }
      return rep;
    }).catch(() => caches.match(req, { ignoreSearch: req.mode === 'navigate' }).then(r => r || caches.match('./index.html')))
  );
});
