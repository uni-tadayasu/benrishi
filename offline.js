(function () {
  'use strict';
  const CACHE = 'benrishi-v1-20261125';
  const BASE = new URL('./', document.baseURI);
  const MANIFEST_URL = new URL('offline-assets.json', BASE).href;
  const RECEIPT_URL = new URL('.benrishi-offline-receipt.json', BASE).href;
  let running = null, checking = null;
  let capacity = null, capacityStatus = 'loading', estimating = null, lastEstimate = 0;
  let progress = { phase: 'idle', completed: 0, total: 0, bytes: 0, totalBytes: 0, failures: [] };
  const formatBytes = value => value >= 1048576 ? (value / 1048576).toFixed(1) + ' MB' : Math.ceil(value / 1024) + ' KB';
  const formatCapacity = value => value >= 1073741824 ? (value / 1073741824).toFixed(2) + ' GB' : formatBytes(value);
  const message = text => window.App && window.App.toast(text);
  const supported = () => 'caches' in window && 'serviceWorker' in navigator;
  function paintCapacity() {
    const status = document.querySelector('#offline-status');
    if (!status) return;
    let note = document.querySelector('#offline-storage');
    if (!note) { note = document.createElement('p'); note.id = 'offline-storage'; note.className = 'small-note'; status.insertAdjacentElement('afterend', note); }
    if (capacityStatus === 'loading') note.textContent = 'この配信元の保存容量を確認しています…';
    else if (capacity) {
      const usage = capacity.usage === null ? '不明' : formatCapacity(capacity.usage);
      const quota = capacity.quota === null ? '不明' : formatCapacity(capacity.quota);
      const free = capacity.usage !== null && capacity.quota !== null ? ` · 空き ${formatCapacity(Math.max(0, capacity.quota - capacity.usage))}` : '';
      note.textContent = `この配信元の保存領域（目安）：使用 ${usage} / 上限 ${quota}${free}。同じ配信元の他のページと共有されます。`;
    } else note.textContent = capacityStatus === 'unsupported' ? 'このブラウザでは保存容量の目安を表示できません。' : '保存容量の目安を取得できませんでした。';
  }
  function refreshCapacity() {
    if (estimating) return estimating;
    if (!navigator.storage || typeof navigator.storage.estimate !== 'function') { capacityStatus = 'unsupported'; paintCapacity(); return Promise.resolve(null); }
    estimating = (async () => {
      try {
        const estimate = await Promise.resolve().then(() => navigator.storage.estimate());
        const value = number => Number.isFinite(number) && number >= 0 ? number : null;
        capacity = { usage: value(estimate.usage), quota: value(estimate.quota) };
        capacityStatus = 'available'; return capacity;
      } catch (_) { capacity = null; capacityStatus = 'unavailable'; return null; }
      finally { lastEstimate = Date.now(); estimating = null; paintCapacity(); }
    })();
    return estimating;
  }
  function paint(text) {
    const status = document.querySelector('#offline-status');
    const bar = document.querySelector('#offline-progress');
    if (status) {
      status.textContent = text || (progress.phase === 'downloading'
        ? `教材を保存しています。${progress.completed} / ${progress.total}件${progress.totalBytes ? '（' + formatBytes(progress.bytes) + ' / ' + formatBytes(progress.totalBytes) + '）' : ''}${progress.reused ? ' · 検証済み ' + progress.reused + '件を再利用' : ''}`
        : progress.phase === 'preparing' ? '保存する教材を確認しています…' : '保存状態を確認しています…');
      status.setAttribute('aria-live', 'polite');
    }
    if (bar) bar.style.width = (progress.total ? Math.min(100, progress.completed / progress.total * 100) : 0) + '%';
    document.querySelectorAll('[data-action="download-offline"]').forEach(button => { button.disabled = !!running; });
    const prior = document.querySelector('#offline-errors');
    if (prior) prior.remove();
    if (status && progress.failures.length) {
      const details = document.createElement('details'); details.id = 'offline-errors'; details.className = 'small-note';
      const summary = document.createElement('summary'); summary.textContent = '保存できなかった教材を確認';
      const list = document.createElement('ul');
      progress.failures.forEach(failure => { const item = document.createElement('li'); item.textContent = `${failure.label || failure.path}：${failure.reason || '未保存'}`; list.appendChild(item); });
      details.append(summary, list); status.insertAdjacentElement('afterend', details);
    }
    paintCapacity();
  }
  function validateManifest(raw) {
    if (!raw || !Array.isArray(raw.files) || !raw.files.length || !['string', 'number'].includes(typeof raw.version)) throw new Error('教材一覧の形式を確認できません。');
    const seen = new Set();
    const files = raw.files.map(entry => {
      const item = typeof entry === 'string' ? { path: entry } : entry;
      if (!item || typeof item.path !== 'string') throw new Error('教材一覧に不正なファイル指定があります。');
      const url = new URL(item.path, BASE);
      if (url.origin !== BASE.origin || !url.pathname.startsWith(BASE.pathname) || url.username || url.password || url.search || url.hash) throw new Error('保存範囲外の教材が指定されています。');
      if (seen.has(url.href)) throw new Error('教材一覧に重複があります。');
      seen.add(url.href);
      return { path: item.path, url: url.href, label: typeof item.label === 'string' ? item.label : item.path.split('/').pop(), bytes: Number.isSafeInteger(item.bytes) && item.bytes >= 0 ? item.bytes : null, sha256: typeof item.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(item.sha256) ? item.sha256.toLowerCase() : null };
    });
    const version = String(raw.version);
    return { version, files, raw, token: JSON.stringify([version, ...files.map(file => [file.path, file.bytes, file.sha256])]) };
  }
  async function request(url, timeout = 30000) {
    const abort = new AbortController(); const timer = setTimeout(() => abort.abort(), timeout);
    try { return await fetch(url, { credentials: 'same-origin', cache: 'reload', redirect: 'follow', signal: abort.signal }); }
    finally { clearTimeout(timer); }
  }
  async function manifest(allowSaved) {
    const cache = await caches.open(CACHE);
    let onlineError;
    if (navigator.onLine) {
      try {
        const url = new URL(MANIFEST_URL); url.searchParams.set('__offline_manifest', String(Date.now()));
        const response = await request(url.href, 12000);
        if (!response.ok || response.type === 'opaque') throw new Error('教材一覧を取得できませんでした。');
        if (response.url && new URL(response.url).pathname !== new URL(MANIFEST_URL).pathname) throw new Error('サインイン状態を確認してください。');
        const raw = await response.json(); const data = validateManifest(raw);
        try { await cache.put(MANIFEST_URL, new Response(JSON.stringify(raw), { headers: { 'Content-Type': 'application/json; charset=utf-8' } })); } catch (error) { if (error.name !== 'QuotaExceededError') throw error; /* Recompress existing assets before retrying this small metadata write. */ }
        return { ...data, fromSaved: false };
      } catch (error) { onlineError = error; }
    }
    if (allowSaved) {
      const saved = await cache.match(MANIFEST_URL);
      if (saved) return { ...validateManifest(await saved.json()), fromSaved: true };
    }
    throw onlineError || new Error('最初の保存はオンラインで行ってください。');
  }
  async function verify(response, file) {
    const responseUrl = response && response.url;
    if (response && window.CacheCodec && typeof window.CacheCodec.unpack === 'function') response = await window.CacheCodec.unpack(response);
    if (!response || !response.ok || ['opaque', 'opaqueredirect'].includes(response.type)) throw new Error('ファイルが保存されていません。');
    if (responseUrl || response.url) {
      const actual = new URL(responseUrl || response.url), expected = new URL(file.url);
      const indexAlias = /\/index\.html$/i.test(expected.pathname) && actual.pathname === expected.pathname.replace(/index\.html$/i, '');
      if (actual.origin !== expected.origin || (actual.pathname !== expected.pathname && !indexAlias)) throw new Error('ファイルの取得先を確認できません。');
    }
    const type = response.headers.get('Content-Type') || '';
    if (!/\.html?$/i.test(file.path) && /text\/html/i.test(type)) throw new Error('教材の代わりに案内画面が返されました。');
    const buffer = await response.arrayBuffer();
    if (file.bytes !== null && buffer.byteLength !== file.bytes) throw new Error(`保存サイズが教材一覧と一致しません（実際 ${buffer.byteLength.toLocaleString()} bytes / 期待 ${file.bytes.toLocaleString()} bytes）。`);
    if (/\.json$/i.test(file.path)) {
      try { JSON.parse(new TextDecoder().decode(buffer)); } catch (_) { throw new Error('教材データの内容を確認できません。'); }
    }
    if (file.sha256) {
      if (!window.crypto || !crypto.subtle) throw new Error('教材の検証機能を利用できません。');
      const digest = await crypto.subtle.digest('SHA-256', buffer);
      const hex = Array.from(new Uint8Array(digest)).map(value => value.toString(16).padStart(2, '0')).join('');
      if (hex !== file.sha256) throw new Error('教材の内容が保存対象の版と一致しません。');
    }
    return buffer.byteLength;
  }
  async function workers(items, action, concurrency = 2) {
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (cursor < items.length) { const index = cursor++; await action(items[index], index); }
    }));
  }
  async function registrationActive() {
    const registration = await navigator.serviceWorker.getRegistration(BASE.href);
    return !!(registration && registration.active);
  }
  async function waitForWorker() {
    if (await registrationActive()) return;
    let timer;
    try { await Promise.race([navigator.serviceWorker.ready, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('オフライン機能の準備中です。少し待ってから再度保存してください。')), 12000); })]); }
    finally { clearTimeout(timer); }
    if (!await registrationActive()) throw new Error('オフライン機能を開始できませんでした。再読み込みしてお試しください。');
  }
  async function inspect(data) {
    const cache = await caches.open(CACHE), missing = [];
    let available = 0, bytes = 0;
    await workers(data.files, async file => {
      try { const size = await verify(await cache.match(file.url), file); bytes += size; available++; }
      catch (error) { missing.push({ path: file.path, label: file.label, reason: error.message }); }
    });
    let receipt = null;
    try { const response = await cache.match(RECEIPT_URL); if (response) receipt = await response.json(); } catch (_) { /* An invalid receipt is incomplete, not success. */ }
    const confirmed = !!(receipt && receipt.token === data.token && receipt.complete === true);
    const workerReady = await registrationActive();
    return { complete: missing.length === 0 && confirmed && workerReady, total: data.files.length, available, bytes, missing, confirmed, workerReady, version: data.version, fromSaved: data.fromSaved };
  }
  function showInspection(result, notify) {
    progress = { phase: result.complete ? 'complete' : 'incomplete', completed: result.available, total: result.total, bytes: result.bytes, totalBytes: 0, failures: result.missing };
    let text;
    if (result.complete) text = `全${result.total}件の教材を保存済みです。この端末でオフライン学習できます。${result.reused ? ' 検証済みの' + result.reused + '件は再取得せず利用しました。' : ''}`;
    else if (!result.workerReady) text = 'オフライン機能を準備しています。オンラインで再読み込みし、全教材を一括保存してください。';
    else if (!result.missing.length) text = '保存済みの教材はありますが、全教材の保存完了を確認できません。「全教材を一括保存」で確認してください。';
    else text = `${result.available} / ${result.total}件を保存済みです。残りの教材を利用するには「全教材を一括保存」を押してください。`;
    if (result.fromSaved && navigator.onLine) text += ' 現在は端末に保存された教材一覧で確認しています。';
    paint(text); if (notify) message(result.complete ? '全教材のオフライン保存を確認しました。' : '未保存の教材があります。保存状態を確認してください。');
  }
  function check(notify = false) {
    refreshCapacity();
    if (running) { paint(); return running; }
    if (checking) return checking;
    if (!supported()) { paint('このブラウザではオフライン保存を利用できません。HTTPSで開いた対応ブラウザをご利用ください。'); return Promise.resolve({ complete: false, unsupported: true }); }
    progress.phase = 'checking'; paint();
    checking = (async () => {
      try { const data = await manifest(true), result = await inspect(data); showInspection(result, !!notify); return result; }
      catch (error) { progress = { phase: 'error', completed: 0, total: 0, bytes: 0, totalBytes: 0, failures: [] }; paint(navigator.onLine ? '教材一覧を確認できませんでした。少し待ってから再度確認してください。' : '全教材はまだ保存されていません。最初はオンラインで一括保存してください。'); if (notify) message(error.message); return { complete: false, error: error.message }; }
      finally { await refreshCapacity(); checking = null; }
    })();
    return checking;
  }
  function download() {
    refreshCapacity();
    if (running) { paint(); return running; }
    if (!supported()) { paint('このブラウザではオフライン保存を利用できません。'); return Promise.resolve({ complete: false, unsupported: true }); }
    if (!navigator.onLine) { paint('新しい教材の保存にはネット接続が必要です。接続後にもう一度お試しください。'); return Promise.resolve({ complete: false, offline: true }); }
    running = (async () => {
      try {
        if (checking) await checking;
        progress = { phase: 'preparing', completed: 0, total: 0, bytes: 0, totalBytes: 0, failures: [] }; paint();
        await waitForWorker();
        const data = await manifest(false), cache = await caches.open(CACHE);
        if (navigator.storage && navigator.storage.persist) { try { await navigator.storage.persist(); } catch (_) { /* Persistence is optional. */ } }
        await cache.delete(RECEIPT_URL);
        progress = { phase: 'downloading', completed: 0, total: data.files.length, bytes: 0, totalBytes: data.files.reduce((sum, file) => sum + (file.bytes || 0), 0), failures: [], reused: 0 }; paint();
        const stamp = data.version + '-' + Date.now();
        await workers(data.files, async file => {
          try {
            let size = null, saved = null, reused = false;
            // A matching digest identifies the exact manifest version, not merely the same length.
            if (file.sha256) {
              saved = await cache.match(file.url);
              if (saved) { try { size = await verify(saved.clone(), file); reused = true; } catch (_) { /* Replace stale or damaged content from the network. */ } }
            }
            if (reused) {
              if (saved.headers.get('X-Benrishi-Cache-Encoding') !== 'gzip' && window.CacheCodec && typeof window.CacheCodec.pack === 'function') {
                const packed = await window.CacheCodec.pack(saved);
                if (packed.headers.get('X-Benrishi-Cache-Encoding') === 'gzip') await cache.put(file.url, packed);
              }
            } else {
              const url = new URL(file.url); url.searchParams.set('__offline_update', stamp);
              const response = await request(url.href, 45000);
              size = await verify(response.clone(), file);
              const packed = window.CacheCodec && typeof window.CacheCodec.pack === 'function' ? await window.CacheCodec.pack(response) : response;
              await cache.put(file.url, packed);
            }
            if (new URL(file.url).pathname === new URL('index.html', BASE).pathname) {
              const alias = await cache.match(BASE.href); let validAlias = false;
              if (alias) { try { await verify(alias.clone(), file); validAlias = true; } catch (_) { /* Repair a stale navigation alias. */ } }
              const index = await cache.match(file.url);
              if (index && (!validAlias || alias.headers.get('X-Benrishi-Cache-Encoding') !== index.headers.get('X-Benrishi-Cache-Encoding'))) await cache.put(BASE.href, index);
            }
            if (reused) progress.reused++;
            progress.completed++; progress.bytes += size;
          } catch (error) { progress.failures.push({ path: file.path, label: file.label, reason: error.name === 'AbortError' ? '通信が時間内に完了しませんでした。' : error.name === 'QuotaExceededError' ? '保存領域の上限を超えました（QuotaExceededError）。容量表示を確認してください。' : error.message }); }
          paint();
          if (Date.now() - lastEstimate > 2000) refreshCapacity();
        });
        if (progress.failures.length) { progress.phase = 'incomplete'; paint(`${progress.failures.length}件の教材を保存できませんでした。接続や保存領域を確認して、もう一度「全教材を一括保存」を押してください。${progress.reused ? ' 検証済みの' + progress.reused + '件は再取得せず利用しました。' : ''}`); message('一部の教材を保存できませんでした。'); return { complete: false, missing: progress.failures.slice(), available: progress.completed, total: progress.total, reused: progress.reused }; }
        await cache.put(MANIFEST_URL, new Response(JSON.stringify(data.raw), { headers: { 'Content-Type': 'application/json; charset=utf-8' } }));
        await cache.put(RECEIPT_URL, new Response(JSON.stringify({ complete: true, token: data.token, version: data.version, savedAt: new Date().toISOString() }), { headers: { 'Content-Type': 'application/json; charset=utf-8' } }));
        const result = await inspect(data); result.reused = progress.reused; showInspection(result, true); return result;
      } catch (error) { progress.phase = 'error'; paint(error.name === 'QuotaExceededError' ? '端末の空き容量が不足しています。空き容量を増やしてから、再度保存してください。' : error.message || '教材を保存できませんでした。'); message('教材の保存が完了していません。保存状態を確認してください。'); return { complete: false, error: error.message }; }
      finally { await refreshCapacity(); running = null; document.querySelectorAll('[data-action="download-offline"]').forEach(button => { button.disabled = false; }); }
    })();
    paint(); return running;
  }
  function install() { if (window.App) window.App.offline = { check, download, cacheName: CACHE }; }
  if (window.App) install(); else document.addEventListener('DOMContentLoaded', install, { once: true });
})();
