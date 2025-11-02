const CACHE = 'vlite-v1';
const CORE = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'ai.js',
  'manifest.webmanifest',
  'wordlists/demo.json',
  'wordlists/cet4.json'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // 仅同源静态资源走 cache-first；其它走网络
  if (url.origin === location.origin) {
    e.respondWith(
      caches.match(e.request).then(r => r || fetch(e.request).then(resp => {
        // 动态缓存词表
        if (url.pathname.startsWith('/wordlists/')) {
          const copy = resp.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return resp;
      }).catch(() => caches.match('index.html')))
    );
  }
});
