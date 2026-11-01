// 離線快取：同網域的檔案先走網路（拿到最新版），沒網路時改用快取
const CACHE = 'foodskin-2026.11.01-0851';
const ASSETS = [
  './', './index.html', './styles.css', './manifest.webmanifest',
  './js/app.js', './js/config.js', './js/db.js', './js/util.js', './js/vocab.js',
  './js/claude.js', './js/gemini.js','./js/analyzer.js', './js/records.js', './js/xlsx.js', './js/excel.js', './js/pdf.js',
  './js/backup.js', './js/dropbox.js', './js/version.js',
  './icons/icon-180.png', './icons/icon-192.png', './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    // no-cache：每次都向伺服器確認是否有新版（GitHub Pages 預設讓瀏覽器快取 10 分鐘，會拿到舊檔）
    fetch(req, { cache: 'no-cache' })
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html')))
  );
});
