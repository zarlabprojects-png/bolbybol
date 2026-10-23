/* বল বাই বল: সার্ভিস ওয়ার্কার। অফলাইনে অ্যাপ খোলে, লাইভ API কখনো ক্যাশ হয় না। */
const V = 'bbb-v109';
const SHELL = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/maskable-512.png', '/icons/apple-touch-icon.png'];
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)));
});
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin && url.pathname.startsWith('/api/')) return; // লাইভ ডেটা সবসময় নেটওয়ার্ক থেকে

  if (req.mode === 'navigate') {
    // ক্যাশ থেকে সঙ্গে সঙ্গে খোলে (নেটের অপেক্ষা নেই), পেছনে নতুন ভার্সন এনে রাখে। ক্যাশ না থাকলে নেট থেকে আনে।
    e.respondWith(caches.open(V).then(async c => {
      const hit = await c.match('/');
      const net = fetch('/', { cache: 'no-cache' }).then(res => {
        if (res.ok && !res.redirected) {
          const changed = hit && hit.headers.get('etag') && res.headers.get('etag') && hit.headers.get('etag') !== res.headers.get('etag');
          c.put('/', res.clone());
          if (changed) self.clients.matchAll({ type: 'window' }).then(cl => cl.forEach(w => w.postMessage({ t: 'bbb-upd' })));
        }
        return res;
      }).catch(() => null);
      if (hit) { e.waitUntil(net); return hit; }
      return (await net) || new Response('অফলাইন। নেট এলে আবার খোলো।', { status: 503, headers: { 'content-type': 'text/plain;charset=utf-8' } });
    }));
    return;
  }

  if (url.origin === location.origin || FONT_HOSTS.includes(url.hostname)) {
    e.respondWith(
      caches.open(V).then(c => c.match(req).then(hit => {
        const net = fetch(req).then(res => {
          if (res.ok || res.type === 'opaque') c.put(req, res.clone());
          return res;
        }).catch(() => hit);
        return hit || net;
      }))
    );
  }
});

/* পুশ নোটিফিকেশন: উইকেট, চার-ছক্কা, ম্যাচ শুরু ও শেষ */
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { t: 'বল বাই বল', b: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.t || 'বল বাই বল', {
    body: d.b || '',
    tag: d.g || 'bbb',
    renotify: true,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    vibrate: [120, 60, 120],
    data: { u: d.u || '/' }
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const u = new URL((e.notification.data && e.notification.data.u) || '/', self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cl => {
    const hit = cl.find(c => c.url === u) || cl.find(c => c.url.split('?')[0] === u.split('?')[0] && c.url.includes('watch='));
    if (hit) return hit.focus();
    return self.clients.openWindow(u);
  }));
});
