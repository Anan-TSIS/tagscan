/* Service worker: เปิดแอปและสแกนได้แม้ไม่มีสัญญาณ (หลังเปิดครั้งแรกตอนมีเน็ต)
   ถ้าแก้ไฟล์ใดแล้วอัปโหลดใหม่ ให้เปลี่ยนเลขเวอร์ชันด้านล่าง เพื่อให้มือถือดึงไฟล์ชุดใหม่ */
var VERSION = 'tagscan-v2-5';
var PRECACHE = [
  './', 'index.html', 'app.js', 'parser.js', 'config.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'sample.jpg',
  'zxing.js', 'tesseract.min.js', 'worker.min.js',
  'tesseract-core-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js',
  'eng.lang.wasm'
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(VERSION).then(function (c) { return c.addAll(PRECACHE); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (ks) {
    return Promise.all(ks.filter(function (k) { return k !== VERSION; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
function keep(req, res) {
  if (res && res.ok) { var copy = res.clone(); caches.open(VERSION).then(function (c) { c.put(req, copy); }); }
  return res;
}
self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  var heavy = /(zxing|tesseract|worker\.min|eng\.lang)|icon-|sample\.jpg/.test(url.pathname);
  if (heavy) {
    e.respondWith(caches.match(req, { ignoreSearch: true }).then(function (r) { return r || fetch(req).then(function (res) { return keep(req, res); }); }));
    return;
  }
  e.respondWith(fetch(req).then(function (res) { return keep(req, res); }).catch(function () {
    return caches.match(req, { ignoreSearch: true }).then(function (r) { return r || caches.match('index.html'); });
  }));
});
