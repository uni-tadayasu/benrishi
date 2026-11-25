'use strict';
// Run: node tests/offline-sw-vm-test.cjs [dist-directory] [report-json]
// Executes the production worker and codec without copying their implementation.
// Reports are written only when report-json is explicitly provided.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..');
const DIST = path.resolve(process.argv[2] || (fs.existsSync(path.join(projectRoot, 'dist', 'index.html')) ? path.join(projectRoot, 'dist') : projectRoot));
const REPORT = process.argv[3] ? path.resolve(process.argv[3]) : null;
const SCOPE = 'https://offline-check.invalid/benrishi/';
const MARKER = 'X-Benrishi-Cache-Encoding';
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const href = relative => new URL(relative, SCOPE).href;
const read = relative => fs.readFileSync(path.join(DIST, relative));
const keyOf = request => typeof request === 'string' ? request : request.url;
const mime = relative => ({
  '.js': 'text/javascript; charset=utf-8', '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.css': 'text/css; charset=utf-8', '.pdf': 'application/pdf',
  '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml',
  '.zip': 'application/zip', '.gz': 'application/gzip', '.webp': 'image/webp'
})[path.extname(relative)] || 'application/octet-stream';

const report = {
  passed: false,
  dist: DIST,
  scope: SCOPE,
  startedAt: new Date().toISOString(),
  sourceSha256: Object.fromEntries(['sw.js', 'cache-codec.js', 'offline-assets.json', 'index.html']
    .map(file => [file, sha256(read(file))])),
  checks: []
};
const handlers = new Map();
const cacheMaps = new Map();
const putLog = [];
const fetchLog = [];
let failPut = () => false;
let network = async () => { throw new TypeError('Harness: network is offline'); };
let skipWaitingCalls = 0;

class MockCache {
  constructor(name) { this.name = name; this.entries = new Map(); }
  async match(request) {
    const item = this.entries.get(keyOf(request));
    if (!item) return undefined;
    return new Response(item.bytes.slice(), {
      status: item.status, statusText: item.statusText, headers: item.headers
    });
  }
  async put(request, response) {
    const key = keyOf(request);
    putLog.push({ cache: this.name, key, status: response.status });
    if (failPut(key)) throw new DOMException('Harness: storage quota exceeded', 'QuotaExceededError');
    if (response.status === 206) throw new TypeError('Cache.put cannot store a 206 response');
    if (response.headers.get('Vary') === '*') throw new TypeError('Cache.put cannot store Vary: *');
    const bytes = Buffer.from(await response.arrayBuffer());
    this.entries.set(key, {
      bytes, status: response.status, statusText: response.statusText,
      headers: [...response.headers]
    });
  }
  async delete(request) { return this.entries.delete(keyOf(request)); }
}

const sandbox = {
  Response, Request, Headers, URL, AbortController, CompressionStream, DecompressionStream,
  setTimeout, clearTimeout, console,
  registration: { scope: SCOPE },
  location: new URL('sw.js', SCOPE),
  clients: { claim: async () => {} },
  skipWaiting: async () => { skipWaitingCalls++; },
  addEventListener(name, handler) { handlers.set(name, handler); },
  caches: {
    async open(name) {
      if (!cacheMaps.has(name)) cacheMaps.set(name, new MockCache(name));
      return cacheMaps.get(name);
    },
    async keys() { return [...cacheMaps.keys()]; },
    async delete(name) { return cacheMaps.delete(name); }
  },
  async fetch(request, options) {
    fetchLog.push({ url: keyOf(request), mode: request.mode, cache: request.cache, range: request.headers?.get('Range') });
    return network(request, options);
  }
};
sandbox.self = sandbox;
const context = vm.createContext(sandbox);
sandbox.importScripts = (...scripts) => {
  for (const script of scripts) {
    const filename = path.resolve(DIST, script);
    assert.equal(filename, path.join(DIST, 'cache-codec.js'));
    vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  }
};
vm.runInContext(read('sw.js').toString('utf8'), context, { filename: path.join(DIST, 'sw.js') });
assert.equal(typeof sandbox.CacheCodec.pack, 'function');
assert.equal(typeof handlers.get('fetch'), 'function');
const config = vm.runInContext('({ cache: CACHE, release: RELEASE, core: Array.from(CORE) })', context);
const CACHE_NAME = config.cache;
const RELEASE = config.release;
const CORE = Array.from(config.core);
report.release = RELEASE;

function requestFor(relative, navigation = false, headers) {
  const request = new Request(href(relative), { headers });
  // Native Request intentionally forbids constructing navigate-mode requests;
  // the worker receives these browser-owned read-only values on document loads.
  if (navigation) {
    Object.defineProperty(request, 'mode', { value: 'navigate' });
    Object.defineProperty(request, 'destination', { value: 'document' });
  }
  return request;
}

async function dispatch(relative, navigation = false, headers) {
  let result;
  let calls = 0;
  handlers.get('fetch')({
    request: requestFor(relative, navigation, headers),
    respondWith(promise) { calls++; result = promise; }
  });
  assert.equal(calls, 1, `fetch handler must claim ${relative}`);
  return result;
}

async function dispatchInstall() {
  let result, calls = 0;
  handlers.get('install')({ waitUntil(promise) { calls++; result = promise; } });
  assert.equal(calls, 1, 'install event must have one completion promise');
  return result;
}

function sourcePath(request) {
  const target = new URL(keyOf(request)), scope = new URL(SCOPE);
  assert.equal(target.origin, scope.origin);
  assert(target.pathname.startsWith(scope.pathname));
  return decodeURIComponent(target.pathname.slice(scope.pathname.length)) || 'index.html';
}

function fileResponse(relative, body = read(relative)) {
  return new Response(body, {
    headers: { 'Content-Type': mime(relative), 'Content-Length': String(body.byteLength) }
  });
}

function check(name, details = {}) { report.checks.push({ name, passed: true, ...details }); }

(async () => {
  const manifest = JSON.parse(read('offline-assets.json'));
  assert(Array.isArray(manifest.files) && manifest.files.length > 0, 'inventory must contain files');
  assert.equal(new Set(manifest.files.map(file => file.path)).size, manifest.files.length);
  assert.equal(manifest.version, RELEASE, 'inventory and worker releases must agree');
  const html = read('index.html').toString('utf8');
  const entryReferences = [
    ...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>/g),
    ...html.matchAll(/<link\b(?=[^>]*\brel="stylesheet")[^>]*\bhref="([^"]+)"[^>]*>/g)
  ].map(match => match[1]);
  assert(entryReferences.length > 0, 'HTML must reference entry assets');
  const entryFiles = entryReferences.map(reference => {
    const target = new URL(reference, SCOPE), scope = new URL(SCOPE);
    assert.equal(target.origin, scope.origin);
    assert(target.pathname.startsWith(scope.pathname));
    assert.equal(target.searchParams.get('v'), RELEASE, reference);
    assert.equal([...target.searchParams.keys()].length, 1, reference);
    const relative = target.pathname.slice(scope.pathname.length);
    assert(/\.(?:js|css)$/.test(relative));
    const file = manifest.files.find(file => file.path === relative);
    assert(file, 'versioned entry must be in offline inventory: ' + relative);
    return { ...file, reference };
  });
  assert.equal(new Set(entryFiles.map(file => file.path)).size, entryFiles.length);
  const cache = await sandbox.caches.open(CACHE_NAME);
  let originalBytes = 0, storedBytes = 0, compressedFiles = 0;
  for (const file of manifest.files) {
    const bytes = read(file.path);
    assert.equal(bytes.byteLength, file.bytes, `source bytes: ${file.path}`);
    assert.equal(sha256(bytes), file.sha256, `source SHA: ${file.path}`);
    const packed = await sandbox.CacheCodec.pack(fileResponse(file.path, bytes));
    if (packed.headers.get(MARKER) === 'gzip') compressedFiles++;
    await cache.put(href(file.path), packed);
    originalBytes += bytes.byteLength;
    storedBytes += cache.entries.get(href(file.path)).bytes.byteLength;
  }
  assert.equal(originalBytes, manifest.totalBytes);
  check('manifest sources and compressed cache population', {
    files: manifest.files.length, originalBytes, storedBytes, compressedFiles,
    rawFiles: manifest.files.length - compressedFiles
  });

  const readsBefore = fetchLog.length;
  for (const file of manifest.files) {
    const response = await dispatch(file.path);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(response.status, 200, `offline status: ${file.path}`);
    assert.equal(bytes.byteLength, file.bytes, `restored bytes: ${file.path}`);
    assert.equal(sha256(bytes), file.sha256, `restored SHA: ${file.path}`);
    assert.equal(response.headers.get(MARKER), null, `internal marker: ${file.path}`);
    assert.equal(response.headers.get('Content-Type'), mime(file.path));
  }
  assert.equal(fetchLog.length, readsBefore, 'cached asset reads must not fetch');
  check('offline fetch events restore all manifest files', { files: manifest.files.length, hash: 'SHA-256' });

  const beforeVersionedFetches = fetchLog.length;
  for (const file of entryFiles) {
    assert.equal(cache.entries.has(href(file.reference)), false, 'test begins without a query alias');
    const response = await dispatch(file.reference);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(response.status, 200);
    assert.equal(bytes.byteLength, file.bytes);
    assert.equal(sha256(bytes), file.sha256, 'versioned canonical restore: ' + file.path);
    assert.equal(response.headers.get(MARKER), null);
  }
  assert.equal(fetchLog.length, beforeVersionedFetches, 'release entry URLs resolve offline from canonical keys');
  check('versioned HTML entry JS and CSS restore from canonical cache without network', { files: entryFiles.length });

  const sampleEntry = entryFiles.find(file => file.path === 'app.js') || entryFiles[0];
  const differentQueries = [
    `${sampleEntry.path}?v=not-this-release`,
    `${sampleEntry.path}?v=${RELEASE}&extra=1`,
    `${sampleEntry.path}?v=${RELEASE}&v=${RELEASE}`,
    `${sampleEntry.path}?V=${RELEASE}`
  ];
  const nonEntry = 'law-corpus/worker-fixture.js';
  await cache.put(href(nonEntry), new Response('unlisted canonical fixture'));
  differentQueries.push(`${nonEntry}?v=${RELEASE}`);
  const imageFile = manifest.files.find(file => file.path.endsWith('.webp'));
  if (imageFile) differentQueries.push(`${imageFile.path}?v=${RELEASE}`);
  for (const reference of differentQueries) {
    const before = fetchLog.length;
    const response = await dispatch(reference);
    assert.equal(response.status, 503, 'must not collapse query into canonical asset: ' + reference);
    assert.equal(fetchLog.length, before + 1);
    assert.equal(fetchLog.at(-1).url, href(reference));
  }
  const exactAlias = differentQueries[0], exactBody = 'exact old-version cache entry';
  await cache.put(href(exactAlias), new Response(exactBody));
  const exactReads = fetchLog.length;
  assert.equal(await (await dispatch(exactAlias)).text(), exactBody);
  assert.equal(fetchLog.length, exactReads, 'other versions can still use their own exact cache key');
  await cache.delete(href(exactAlias));
  await cache.delete(href(nonEntry));
  check('other versions, extra/duplicate parameters and non-entry assets are not canonicalized', { cases: differentQueries.length });

  await cache.delete(href(sampleEntry.path));
  network = async request => {
    assert.equal(request.url, href(sampleEntry.reference), 'network request keeps its version');
    return fileResponse(sampleEntry.path);
  };
  const beforeCanonicalWrite = putLog.length;
  const repairedEntry = await dispatch(sampleEntry.reference);
  assert.equal(sha256(Buffer.from(await repairedEntry.arrayBuffer())), sampleEntry.sha256);
  assert.deepEqual(putLog.slice(beforeCanonicalWrite).map(item => item.key), [href(sampleEntry.path)]);
  assert.equal(cache.entries.has(href(sampleEntry.reference)), false);
  network = async () => { throw new TypeError('Harness: network is offline'); };
  check('versioned cache miss fetches original URL and stores the canonical entry');

  const indexFile = manifest.files.find(file => file.path === 'index.html');
  const indexKey = href('index.html');
  const indexSnapshot = sha256(cache.entries.get(indexKey).bytes);
  const staleRootBody = '<!doctype html><title>Stale root alias</title>';
  await cache.put(href('./'), new Response(staleRootBody, { headers: { 'Content-Type': 'text/html' } }));
  for (const location of ['./', 'index.html', './?offline-check=1', 'index.html?offline-check=1']) {
    const before = fetchLog.length;
    const response = await dispatch(location, true);
    assert.equal(fetchLog.length, before + 1, 'navigation attempts the offline network once');
    assert.equal(sha256(Buffer.from(await response.arrayBuffer())), indexFile.sha256);
  }
  assert.equal(await (await cache.match(href('./'))).text(), staleRootBody, 'canonical choice did not depend on rewriting the stale alias');
  check('home and index navigation prefer canonical index over stale root alias', { variants: 4 });

  const documents = [
    manifest.files.find(file => file.path.startsWith('treaty-corpus/') && file.path.endsWith('.pdf')),
    manifest.files.find(file => file.path.startsWith('treaty-corpus/') && file.path.endsWith('.html'))
  ];
  for (const file of documents) {
    const before = fetchLog.length;
    const response = await dispatch(file.path, true);
    assert.equal(fetchLog.length, before, 'cached source document does not hit the network');
    assert.equal(sha256(Buffer.from(await response.arrayBuffer())), file.sha256);
    assert.equal(sha256(cache.entries.get(indexKey).bytes), indexSnapshot);
  }
  check('offline treaty PDF and HTML document navigation preserve app index');

  for (const file of documents) {
    await cache.delete(href(file.path));
    network = async request => {
      assert.equal(request.url, href(file.path));
      return fileResponse(file.path);
    };
    const before = putLog.length;
    const response = await dispatch(file.path, true);
    assert.equal(sha256(Buffer.from(await response.arrayBuffer())), file.sha256);
    assert.deepEqual(putLog.slice(before).map(item => item.key), [href(file.path)]);
    assert.equal(sha256(cache.entries.get(indexKey).bytes), indexSnapshot);
  }
  check('online treaty PDF and HTML document navigation cache only their own URL');

  const pdf = documents[0];
  const partial = read(pdf.path).subarray(0, 1024);
  await cache.delete(href(pdf.path));
  network = async () => new Response(partial, {
    status: 206, headers: { 'Content-Type': 'application/pdf', 'Content-Range': `bytes 0-1023/${pdf.bytes}` }
  });
  for (const navigate of [false, true]) {
    const before = putLog.length;
    const response = await dispatch(pdf.path, navigate, { Range: 'bytes=0-1023' });
    assert.equal(response.status, 206);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), partial);
    assert.equal(putLog.length, before);
    assert.equal(cache.entries.has(href(pdf.path)), false);
    assert.equal(sha256(cache.entries.get(indexKey).bytes), indexSnapshot);
  }
  check('online 206 PDF passes through without any cache.put', { modes: ['asset', 'document'] });

  failPut = () => true;
  const assetBody = Buffer.from('容量不足時でも取得済み教材を表示する。'.repeat(300));
  network = async () => new Response(assetBody, { headers: { 'Content-Type': 'application/json' } });
  const failedAssetKey = 'treaty-corpus/storage-quota-test.json';
  const beforeAssetPut = putLog.length;
  const assetResponse = await dispatch(failedAssetKey);
  assert.equal(assetResponse.status, 200);
  assert.deepEqual(Buffer.from(await assetResponse.arrayBuffer()), assetBody);
  assert.equal(putLog.length, beforeAssetPut + 1);
  assert.equal(cache.entries.has(href(failedAssetKey)), false);

  const onlinePage = Buffer.concat([read('index.html'), Buffer.from('\n<!-- online quota test -->')]);
  network = async () => new Response(onlinePage, { headers: { 'Content-Type': 'text/html' } });
  const beforePagePut = putLog.length;
  const pageResponse = await dispatch('./', true);
  assert.equal(pageResponse.status, 200);
  assert.deepEqual(Buffer.from(await pageResponse.arrayBuffer()), onlinePage);
  assert.equal(putLog.length, beforePagePut + 1);
  assert.equal(sha256(cache.entries.get(indexKey).bytes), indexSnapshot);
  failPut = () => false;
  check('Cache.put quota errors preserve successful online responses', { modes: ['asset', 'home navigation'] });

  network = async request => {
    assert.equal(request.url, href('offline-assets.json'));
    return fileResponse('offline-assets.json');
  };
  const manifestResponse = await dispatch('offline-assets.json');
  assert.equal(sha256(Buffer.from(await manifestResponse.arrayBuffer())), sha256(read('offline-assets.json')));
  const savedManifest = await cache.match(href('offline-assets.json'));
  assert.equal(savedManifest.headers.get(MARKER), null);
  assert.equal((await savedManifest.json()).files.length, manifest.files.length);
  check('offline-assets.json remains directly JSON-readable in cache');

  // Installation is exercised against fresh cache mocks containing a previous shell.
  // A failed dependency must never publish either new HTML entry point.
  const htmlKeys = new Set([href('./'), href('index.html')]);
  const dependencies = CORE.filter(relative => !htmlKeys.has(href(relative)));
  const lastDependency = dependencies.at(-1);
  assert(lastDependency, 'worker must have dependencies before its HTML shell');
  const oldShell = '<!doctype html><title>Previously installed shell</title>';
  async function previousInstallCache() {
    const old = new MockCache(CACHE_NAME);cacheMaps.set(CACHE_NAME, old);
    for (const key of htmlKeys) await old.put(key, new Response(oldShell, { headers: { 'Content-Type': 'text/html' } }));
    return old;
  }
  for (const failure of ['network', 'quota']) {
    const old = await previousInstallCache(), before = putLog.length, beforeSkip = skipWaitingCalls;
    network = async request => {
      assert.equal(request.cache, 'reload');
      if (failure === 'network' && request.url === href(lastDependency)) return new Response('dependency unavailable', { status: 503 });
      return fileResponse(sourcePath(request));
    };
    failPut = key => failure === 'quota' && key === href(lastDependency);
    await assert.rejects(dispatchInstall(), failure === 'quota' ? { name: 'QuotaExceededError' } : /Offline shell missing/);
    failPut = () => false;
    assert.equal(skipWaitingCalls, beforeSkip, 'failed install cannot activate');
    assert.equal(putLog.slice(before).some(item => htmlKeys.has(item.key)), false, 'HTML must be written after every dependency succeeds');
    for (const key of htmlKeys) assert.equal(await (await old.match(key)).text(), oldShell);
  }
  check('failed install dependency fetch or cache write leaves previous HTML untouched', { failureModes: ['HTTP 503', 'QuotaExceededError'], failedDependency: lastDependency });

  const installed = await previousInstallCache(), beforeInstall = putLog.length, beforeSkip = skipWaitingCalls;
  network = async request => {
    assert.equal(request.cache, 'reload');
    return fileResponse(sourcePath(request));
  };
  await dispatchInstall();
  assert.equal(skipWaitingCalls, beforeSkip + 1);
  const installationWrites = putLog.slice(beforeInstall);
  const firstHtmlWrite = installationWrites.findIndex(item => htmlKeys.has(item.key));
  assert.equal(firstHtmlWrite, installationWrites.length - 2, 'both HTML entry points follow all dependencies and aliases');
  assert.deepEqual(installationWrites.slice(-2).map(item => item.key), [href('index.html'), href('./')]);
  for (const file of entryFiles) {
    const canonical = await installed.match(href(file.path)), alias = await installed.match(href(file.reference));
    assert(canonical && alias, 'install populates canonical and old-worker exact query keys: ' + file.path);
    for (const saved of [canonical, alias]) {
      const response = await sandbox.CacheCodec.unpack(saved);
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(bytes.byteLength, file.bytes);
      assert.equal(sha256(bytes), file.sha256);
    }
  }
  for (const key of htmlKeys) assert.equal(sha256(Buffer.from(await (await sandbox.CacheCodec.unpack(await installed.match(key))).arrayBuffer())), indexFile.sha256);
  const installManifest = await installed.match(href('offline-assets.json'));
  assert.equal(installManifest.headers.get(MARKER), null);
  assert.equal((await installManifest.json()).files.length, manifest.files.length);
  network = async () => { throw new TypeError('Harness: network is offline'); };
  const installedReads = fetchLog.length;
  for (const file of entryFiles) assert.equal(sha256(Buffer.from(await (await dispatch(file.reference)).arrayBuffer())), file.sha256);
  assert.equal(fetchLog.length, installedReads);
  check('successful install publishes HTML last and provides exact version aliases for previous workers', { entryAliases: entryFiles.length, coreFiles: CORE.length });

  report.passed = true;
  report.finishedAt = new Date().toISOString();
  if (REPORT) {
    fs.mkdirSync(path.dirname(REPORT), { recursive: true });
    fs.writeFileSync(REPORT, JSON.stringify(report, null, 2) + '\n');
  }
  console.log(JSON.stringify({ passed: true, checks: report.checks.length, files: manifest.files.length,
    originalBytes, storedBytes, compressedFiles, report: REPORT || undefined }));
})().catch(error => {
  report.error = { message: error.message, stack: error.stack };
  report.finishedAt = new Date().toISOString();
  if (REPORT) {
    fs.mkdirSync(path.dirname(REPORT), { recursive: true });
    fs.writeFileSync(REPORT, JSON.stringify(report, null, 2) + '\n');
  }
  console.error(error);
  process.exitCode = 1;
});
