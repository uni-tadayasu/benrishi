/* SiteMotion: finite, optional decoration. No scroll, focus, text or layout writes.
 * Init is explicit and idempotent; profile persistence belongs to the application.
 */
(function (root) {
  'use strict';
  const document = root.document;
  const ENTER = '.page-heading,.illustrated-heading,.hero,.goal-card,.stat-card,.subject-card,.law-book,.record-card,.essential-card,.essay-card,.panel,.task-row,.law-search-result,.empty-state,.explanation,.oral-answer,.notice-inline';
  const PROTECTED = '.article-surface,.law-original,.law-explanation,.law-toc,.annotation-toolbar,.annotation-layer,.annotation-canvas,.glossary-definition-text,canvas,input,textarea,select,[contenteditable="true"],[data-motion="off"]';
  const CONTROLS = 'button,a,summary,[role="button"]';
  const EASE = 'cubic-bezier(.22,1,.36,1)';
  let mode = 'standard', initialized = false, reduced = false;
  let media = null, observer = null, intersection = null, frame = 0, suspendUntil = 0;
  let seen = new WeakSet(), progressSeen = new WeakSet();
  const pending = new Set(), waiting = new Set(), active = new Set(), byElement = new WeakMap();
  let roots = [], lastPlayerTitle = '', originalAttributes = null;

  const normalize = value => ['standard', 'subtle', 'off'].includes(value) ? value : 'standard';
  const now = () => root.performance?.now ? root.performance.now() : Date.now();
  const effective = () => reduced ? 'off' : mode;
  const following = () => {
    const dock = document?.getElementById('speech-dock');
    return !!dock && !dock.hidden && /^#laws\//.test(root.location?.hash || '');
  };
  const quiet = () => effective() === 'off' || document?.hidden || now() < suspendUntil;
  const isProtected = element => !!element?.closest?.(PROTECTED);

  function emitChange() {
    if (typeof root.CustomEvent === 'function') root.dispatchEvent(new root.CustomEvent('site-motion-change', {
      detail: { mode, effectiveMode: effective(), reducedMotion: reduced }
    }));
  }
  function applyMode(notify = true) {
    if (document?.documentElement) {
      document.documentElement.dataset.motionMode = mode;
      document.documentElement.dataset.motionEffective = effective();
    }
    cancelAll();
    if (initialized) observeRoots();
    if (notify) emitChange();
  }
  function cancelAll() {
    if (frame) { root.cancelAnimationFrame(frame); frame = 0; }
    pending.clear();
    for (const animation of Array.from(active)) {
      try { animation.cancel(); } catch (_) { active.delete(animation); }
    }
    active.clear();
    intersection?.disconnect();
    waiting.clear();
  }
  function animate(element, keyframes, duration, delay = 0) {
    if (!element?.isConnected || quiet() || typeof element.animate !== 'function' || active.size >= 32) return null;
    try { byElement.get(element)?.cancel(); } catch (_) {}
    let animation;
    try { animation = element.animate(keyframes, { duration, delay, easing: EASE, iterations: 1, fill: 'none' }); }
    catch (_) { return null; }
    byElement.set(element, animation); active.add(animation);
    const done = () => {
      active.delete(animation);
      if (byElement.get(element) === animation) byElement.delete(element);
    };
    if (animation.finished?.then) animation.finished.then(done, done);
    else { animation.onfinish = done; animation.oncancel = done; }
    return animation;
  }
  function reveal(element, order = 0) {
    if (!element?.isConnected || quiet() || isProtected(element) || following()) return;
    const subtle = effective() === 'subtle';
    animate(element, [{ opacity: subtle ? .96 : .82 }, { opacity: 1 }], subtle ? 90 : 240, subtle ? 0 : Math.min(order * 18, 108));
    if (!subtle) {
      const bars = element.matches('.progress > i') ? [element] : element.querySelectorAll('.progress > i');
      let count = 0;
      for (const bar of bars) {
        if (progressSeen.has(bar) || count++ >= 4) continue;
        progressSeen.add(bar);
        // A leaf progress fill only; its final width and the surrounding layout stay intact.
        animate(bar, [{ clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0 0 0)' }], 420, 25);
      }
    }
  }
  function getIntersection() {
    if (intersection || typeof root.IntersectionObserver !== 'function') return intersection;
    intersection = new root.IntersectionObserver(entries => {
      let order = 0;
      for (const entry of entries) {
        if (!entry.isIntersecting || !waiting.has(entry.target)) continue;
        intersection.unobserve(entry.target); waiting.delete(entry.target);
        reveal(entry.target, order++);
      }
    }, { rootMargin: '24px 0px', threshold: .08 });
    return intersection;
  }
  function cleanupDetached() {
    for (const element of waiting) if (!element.isConnected) {
      intersection?.unobserve(element); waiting.delete(element);
    }
  }
  function flush() {
    frame = 0;
    const added = Array.from(pending); pending.clear(); cleanupDetached();
    if (quiet() || following()) return;
    // Read visibility before starting animations, without interleaving layout reads/writes.
    const visible = [], below = [];
    for (const element of added) {
      if (!element.isConnected || isProtected(element) || element.closest('[hidden],details:not([open])')) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      if (rect.bottom >= 0 && rect.top <= (root.innerHeight || 900) + 24) visible.push(element);
      else below.push(element);
    }
    visible.slice(0, 24).forEach((element, i) => reveal(element, i));
    const io = getIntersection();
    if (io) for (const element of below) {
      if (waiting.size >= 80) break;
      waiting.add(element); io.observe(element);
    }
  }
  function collect(node, instant = false) {
    if (!node || node.nodeType !== 1 || isProtected(node)) return;
    const candidates = [];
    if (node.matches(ENTER)) candidates.push(node);
    for (const child of node.querySelectorAll(ENTER)) {
      if (candidates.length >= 96) break;
      candidates.push(child);
    }
    const selected = [];
    for (const element of candidates) {
      if (seen.has(element) || isProtected(element)) continue;
      seen.add(element);
      // Avoid double fading nested cards/panels; their content is already included.
      if (selected.some(parent => parent.contains(element))) continue;
      selected.push(element);
      if (!instant && !quiet() && !following()) pending.add(element);
    }
    if (pending.size && !frame) frame = root.requestAnimationFrame(flush);
  }
  function playerChanged() {
    const dock = document.getElementById('speech-dock');
    const label = dock?.querySelector('.speech-info strong');
    const title = label?.textContent || '';
    if (title === lastPlayerTitle) return;
    lastPlayerTitle = title;
    if (!dock || dock.hidden || following() || dock.contains(document.activeElement)) return;
    if (label) animate(label, [{ opacity: .88 }, { opacity: 1 }], effective() === 'subtle' ? 80 : 160);
  }
  function onMutations(records) {
    if (quiet()) return;
    let player = false, hadRemoval = false;
    for (const record of records) {
      const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
      if (!target || isProtected(target)) continue;
      if (target.closest('#speech-dock')) { player = true; continue; }
      if (record.removedNodes?.length) hadRemoval = true;
      for (const node of record.addedNodes || []) collect(node);
    }
    if (player) playerChanged();
    if (hadRemoval) cleanupDetached();
  }
  function observeRoots() {
    observer?.disconnect();
    roots = ['main', 'app-dialog', 'speech-dock'].map(id => document.getElementById(id)).filter(Boolean);
    if (!observer || effective() === 'off') return;
    for (const element of roots) observer.observe(element, { childList: true, subtree: true });
  }
  function onClick(event) {
    if (event.defaultPrevented || (event.button !== undefined && event.button !== 0) || quiet()) return;
    const target = event.target?.nodeType === 1 ? event.target : event.target?.parentElement;
    if (!target || target.closest('.glossary-term,.annotation-toolbar,.annotation-layer,canvas,input,textarea,select,[contenteditable="true"]')) return;
    const control = target.closest(CONTROLS);
    if (!control || control.disabled || control.getAttribute('aria-disabled') === 'true' || isProtected(control)) return;
    // Native links, controls and their event propagation are never intercepted.
    if (effective() === 'subtle') {
      animate(control, [{ opacity: .95 }, { opacity: 1 }], 85);
      return;
    }
    const shadow = root.getComputedStyle(control).boxShadow;
    const base = !shadow || shadow === 'none' ? '0 0 0 0 rgba(94,153,122,0)' : shadow;
    animate(control, [{ boxShadow: base }, { boxShadow: '0 0 0 3px rgba(94,153,122,.22)', offset: .35 }, { boxShadow: base }], 230);
    const icon = control.querySelector('.icon');
    if (icon && !control.closest('#speech-dock,.law-reader-toolbar,.law-toc')) {
      animate(icon, [{ opacity: .72 }, { opacity: 1 }], 180);
    }
  }
  function onToggle(event) {
    const details = event.target;
    if (!details?.matches?.('details') || !details.open || quiet() || isProtected(details)) return;
    let index = 0;
    for (const child of details.children) {
      if (child.tagName === 'SUMMARY' || isProtected(child) || index >= 6) continue;
      animate(child, [{ opacity: effective() === 'subtle' ? .97 : .88 }, { opacity: 1 }], effective() === 'subtle' ? 80 : 170, index++ * 10);
    }
  }
  function onVisibility() { if (document.hidden) cancelAll(); }
  function onMedia(event) {
    const next = !!event.matches;
    if (next === reduced) return;
    reduced = next; applyMode();
    if (effective() !== 'off') for (const element of roots) collect(element, true);
  }
  function setMode(value) {
    const next = normalize(value);
    if (next !== mode) {
      mode = next; applyMode();
      if (initialized && effective() !== 'off') for (const element of roots) collect(element, true);
    }
    return mode;
  }
  function init(options = {}) {
    if (!document?.documentElement) return api;
    const next = normalize(options.mode ?? mode);
    if (initialized) { setMode(next); return api; }
    originalAttributes = {
      mode: document.documentElement.getAttribute('data-motion-mode'),
      effective: document.documentElement.getAttribute('data-motion-effective')
    };
    mode = next;
    media = typeof root.matchMedia === 'function' ? root.matchMedia('(prefers-reduced-motion: reduce)') : null;
    reduced = !!media?.matches;
    if (media?.addEventListener) media.addEventListener('change', onMedia);
    else media?.addListener?.(onMedia);
    observer = typeof root.MutationObserver === 'function' ? new root.MutationObserver(onMutations) : null;
    initialized = true;
    document.addEventListener('click', onClick, true);
    document.addEventListener('toggle', onToggle, true);
    document.addEventListener('visibilitychange', onVisibility);
    applyMode();
    for (const element of roots) if (element.id !== 'speech-dock') collect(element);
    return api;
  }
  function destroy() {
    if (!initialized) return;
    cancelAll(); observer?.disconnect(); observer = null;
    intersection?.disconnect(); intersection = null;
    if (media?.removeEventListener) media.removeEventListener('change', onMedia);
    else media?.removeListener?.(onMedia);
    media = null;
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('toggle', onToggle, true);
    document.removeEventListener('visibilitychange', onVisibility);
    for (const [key, value] of Object.entries(originalAttributes || {})) {
      const name = key === 'mode' ? 'data-motion-mode' : 'data-motion-effective';
      if (value === null) document.documentElement.removeAttribute(name);
      else document.documentElement.setAttribute(name, value);
    }
    roots = []; seen = new WeakSet(); progressSeen = new WeakSet(); lastPlayerTitle = '';
    initialized = false; suspendUntil = 0;
  }
  const api = Object.freeze({
    version: '2026-11-25.1', init, destroy, setMode,
    getMode: () => mode, getEffectiveMode: effective,
    refresh(node = document?.getElementById('main'), options = {}) { if (initialized) collect(node, !!options.instant); },
    suspend(milliseconds = 800) { suspendUntil = now() + Math.max(0, Math.min(3000, Number(milliseconds) || 0)); cancelAll(); },
    getDiagnostics: () => ({ initialized, effectiveMode: effective(), reducedMotion: reduced, activeAnimations: active.size,
      pendingNodes: pending.size, observedCards: waiting.size, rootCount: roots.length, observerCount: observer ? 1 : 0, frameQueued: !!frame })
  });
  root.SiteMotion = api;
})(typeof window !== 'undefined' ? window : globalThis);
