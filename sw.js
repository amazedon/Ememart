// sw.js  (save in the same folder as index.html and app.html)
// Ememart service worker: offline app shell + push notifications.
// Rule: only our own static files are cached. API calls, Supabase and Squad are NEVER cached.
const VERSION = 'ememart-v46';
const SHELL = ['/', '/index.html', '/app.html', '/backend.js', '/manifest.json', '/icon-180.png', '/icon-192.png', '/icon-512.png', '/support.js', '/privacy.html', '/terms.html'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION).then((c) => Promise.allSettled(SHELL.map((u) => c.add(u)))).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;   // leave other sites and all writes alone

  // Pages: network first, fall back to the saved copy (or the app) when offline
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(req, copy));
        return res;
      }).catch(() => caches.match(req).then((r) => r || caches.match('/app.html')))
    );
    return;
  }

  // Our own files (js, css, icons, manifest): newest copy first so updates show at once; saved copy only when offline
  e.respondWith(
    fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req))
  );
});

// Web push
self.addEventListener('push', (e) => {
  let data = { title: 'Ememart', body: 'You have a new update.', tag: 'ememart-push', url: '/' };
  try { data = Object.assign(data, e.data ? e.data.json() : {}); } catch (_) {}
  e.waitUntil(self.registration.showNotification(data.title, {
    body: data.body, icon: '/icon-192.png', badge: '/icon-192.png',
    tag: data.tag, renotify: true, vibrate: [200, 100, 200], data: { url: data.url || '/' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const open = list.find((c) => 'focus' in c);
      return open ? open.focus() : self.clients.openWindow(target);
    })
  );
});
