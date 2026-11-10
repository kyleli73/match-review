const CACHE = 'bubblotics-match-review-v4';
const SHELL = [
  './', './index.html', './styles.css', './manifest.webmanifest', './icon.svg',
  './src/main.js', './src/ui.js', './src/detect.js', './src/track.js', './src/metrics.js',
  './src/exporters.js', './src/machine.js', './src/worker.js', './src/db.js', './src/video.js',
  './src/youtube.js', './src/player.js', './src/capture.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Stale-while-revalidate: instant offline loads, and a deploy reaches users on their next visit.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || req.headers.has('range') || req.destination === 'video' || url.origin !== location.origin) return;
  e.respondWith(caches.open(CACHE).then(async (cache) => {
    const hit = await cache.match(req, { ignoreSearch: true });
    const fresh = fetch(req).then((res) => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    }).catch(() => hit || (req.mode === 'navigate' ? cache.match('./index.html') : Response.error()));
    if (hit) e.waitUntil(fresh.catch(() => {}));
    return hit || fresh;
  }));
});
