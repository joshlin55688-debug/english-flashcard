// FlashLearn Service Worker — 離線可用
const CACHE = 'flashlearn-v2';
const CORE = [
  './',
  './index.html',
  './flashcard_system.html',
  './words.js',
  './core.js',
  './app.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // 跨源資源（Firebase / gstatic CDN）交給瀏覽器直接處理
  if (url.origin !== location.origin) return;
  // 同源：HTML/JS 導航及檔案採網路優先，更新快取，離線時回退快取
  const isDynamic = req.mode === 'navigate' || url.pathname.endsWith('.html') || url.pathname.endsWith('.js');
  if (isDynamic) {
    e.respondWith(
      fetch(req).then(res => {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
        }
        return res;
      }).catch(() => caches.match(req))
    );
    return;
  }
  // 其他資源：cache-first，背景更新
  e.respondWith(
    caches.match(req).then(cached => {
      const net = fetch(req).then(res => {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
        }
        return res;
      }).catch(() => cached);
      return cached || net;
    })
  );
});
