// TerraX service worker: lets the app open offline after one online visit.
// Same-origin files only; the AI proxy (/api) and other servers are never cached.
const CACHE = 'terrax-v1';

// Every built file (from Vite's asset manifest), so tools never opened online still work offline.
async function buildFiles() {
  try {
    const res = await fetch('./asset-manifest.json', { cache: 'no-store' });
    if (!res.ok) return [];
    const m = await res.json();
    const files = new Set();
    for (const entry of Object.values(m)) {
      if (entry.file) files.add(entry.file);
      for (const k of ['css', 'assets']) for (const f of entry[k] || []) files.add(f);
    }
    return [...files].map(f => `./${f}`);
  } catch {
    return [];
  }
}

self.addEventListener('install', event => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll(['./', './index.html', './manifest.webmanifest']);
      // Best effort: one missing file must not stop installation.
      await Promise.all((await buildFiles()).map(f => cache.add(f).catch(() => undefined)));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches
      .keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.includes('/api/')) return;
  if (req.mode === 'navigate') {
    // Network first for the page, so updates arrive; fall back to the cached shell offline.
    event.respondWith(
      fetch(req)
        .then(res => {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put('./index.html', copy));
          return res;
        })
        .catch(() => caches.match('./index.html')),
    );
    return;
  }
  // Built assets have content hashes in their names, so cache-first is safe.
  event.respondWith(
    caches.match(req).then(
      hit =>
        hit ||
        fetch(req).then(res => {
          if (res.ok && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE).then(c => c.put(req, copy));
          }
          return res;
        }),
    ),
  );
});
