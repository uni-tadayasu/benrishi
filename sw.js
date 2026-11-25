/* Release 2026.11.25.2: illustrations, term links and guided continuous listening. */
importScripts('./cache-codec.js');
const CACHE = 'benrishi-v1-20261125';
const RELEASE = '2026.11.25.2';
const CORE = [
  './style.css', './visual.css', './visual.js', './icon.svg', './manifest.webmanifest',
  './app.js', './question-bank.js', './written-oral.js', './speech-engine.js', './prosody-engine.js',
  './annotation.js', './legal-guides.js', './law-library.js', './offline.js',
  './interaction-guard.js', './glossary.js', './glossary-study.js',
  './glossary-data.json.gz', './cache-codec.js', './offline-assets.json',
  './law-corpus/manifest.json', './treaty-corpus/manifest.json',
  './art/manifest.json', './art/hero-small.webp', './art/hero.webp', './art/library-small.webp',
  './index.html', './'
];
const url = path => new URL(path, self.registration.scope).href;
const versionedEntries = new Set(CORE.filter(path => /\.(js|css)$/.test(path)).map(path => new URL(url(path)).pathname));
function canonicalKey(request, target) {
  if (versionedEntries.has(target.pathname) && target.searchParams.get('v') === RELEASE &&
      [...target.searchParams.keys()].length === 1) {
    const clean = new URL(target.href); clean.search = ''; return clean.href;
  }
  return request;
}
async function storeResponse(cache, key, response) {
  const pathname = new URL(typeof key === 'string' ? key : key.url).pathname;
  const stored = pathname.endsWith('/offline-assets.json')
    ? response.clone() : await CacheCodec.pack(response.clone());
  await cache.put(key, stored);
}
async function savedResponse(cache, key) {
  const response = await cache.match(key);
  if (!response) return null;
  try { return await CacheCodec.unpack(response); }
  catch (_) { await cache.delete(key); return null; }
}
self.addEventListener('install', event => event.waitUntil((async () => {
  const cache = await caches.open(CACHE);
  for (const path of CORE) {
    const response = await fetch(new Request(url(path), { cache: 'reload' }));
    if (!response.ok) throw new Error('Offline shell missing: ' + path);
    await storeResponse(cache, url(path), response);
    // Keep the versioned entry usable if the previous worker still serves an open page.
    if (versionedEntries.has(new URL(url(path)).pathname)) {
      await storeResponse(cache, url(path) + '?v=' + RELEASE, response);
    }
  }
  await self.skipWaiting();
})()));
self.addEventListener('activate', event => event.waitUntil((async () => {
  for (const key of await caches.keys()) {
    if (key.startsWith('benrishi-v1-') && key !== CACHE) await caches.delete(key);
  }
  await self.clients.claim();
})()));
self.addEventListener('fetch', event => {
  const request = event.request, target = new URL(request.url);
  if (request.method !== 'GET' || target.origin !== self.location.origin ||
      !target.href.startsWith(self.registration.scope)) return;
  if (target.pathname.endsWith('/sw.js') || target.searchParams.has('__offline_update') ||
      target.searchParams.has('__offline_manifest')) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const key = canonicalKey(request, target);
    const scopePath = new URL(self.registration.scope).pathname;
    const appNavigation = request.mode === 'navigate' &&
      (target.pathname === scopePath || target.pathname === scopePath + 'index.html');
    if (appNavigation) {
      try {
        const abort = new AbortController();
        const timeout = setTimeout(() => abort.abort(), 3000);
        let response;
        try { response = await fetch(request, { signal: abort.signal }); }
        finally { clearTimeout(timeout); }
        if (response.ok) {
          // A full cache must never prevent an otherwise successful online page load.
          try { await storeResponse(cache, url('./index.html'), response); } catch (_) {}
          return response;
        }
      } catch (_) {}
      return await savedResponse(cache, url('./index.html')) || await savedResponse(cache, request) ||
        new Response('初回はオンラインでサイトを開いてください。', {
          status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        });
    }
    const saved = await savedResponse(cache, key);
    if (saved) return saved;
    try {
      const response = await fetch(request);
      // Cache.put rejects partial (206) PDF responses. Return those to the viewer as-is.
      if (response.status === 200 && response.type !== 'opaque') {
        try { await storeResponse(cache, key, response); } catch (_) {}
      }
      return response;
    } catch (_) {
      return new Response('この教材はまだ保存されていません。', {
        status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      });
    }
  })());
});
