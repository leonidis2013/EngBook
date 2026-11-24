// EngBook service worker — keeps the app shell available offline.
// Network first (so updates arrive right away), cache as the fallback.
// Notes themselves are stored by the app in IndexedDB, not here.
// Copyright (c) 2026 Jerod Ulicki
const CACHE = 'engbook-shell-v10';
const SHELL = [
  '/', '/index.html', '/css/app.css', '/manifest.webmanifest', '/icons/icon.svg',
  '/js/app.js', '/js/api.js', '/js/store.js', '/js/editor.js', '/js/ink.js', '/js/backgrounds.js',
  '/js/cleanup.js', '/js/library.js', '/js/page-settings.js', '/js/settings-ui.js', '/js/auth-ui.js',
  '/js/export.js', '/js/icons.js', '/js/util.js', '/js/shapes.js', '/js/dims.js', '/js/assets.js', '/js/import.js', '/js/learn.js', '/js/onboarding.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith((async () => {
    try {
      const res = await fetch(e.request);
      if (res.ok) { const c = await caches.open(CACHE); c.put(url.pathname === '/' || !url.pathname.includes('.') ? '/index.html' : e.request, res.clone()); }
      return res;
    } catch {
      const hit = await caches.match(url.pathname.includes('.') ? e.request : '/index.html');
      return hit || new Response('Offline', { status: 503 });
    }
  })());
});
