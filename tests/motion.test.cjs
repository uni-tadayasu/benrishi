'use strict';
// Focused DOM/lifecycle harness, not a browser layout or visual-quality test.
// Usage: node tests/motion.test.cjs [dist-directory] [optional-report.json]
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), assert = require('node:assert/strict');
const project = path.resolve(__dirname, '..');
const dist = path.resolve(process.argv[2] || (fs.existsSync(path.join(project, 'dist/motion.js')) ? path.join(project, 'dist') : project));
const observers = [], intersections = [], frames = new Map(), animations = [], rootEvents = new Map();
let frameId = 0, doc;
const dataName = key => 'data-' + key.replace(/[A-Z]/g, letter => '-' + letter.toLowerCase());
function notify(target, addedNodes = [], removedNodes = []) {
  for (const observer of observers) if (observer.roots.some(([root, options]) => target === root || options.subtree && root.contains(target))) observer.records.push({ target, addedNodes, removedNodes, type: 'childList' });
}
function simple(element, selector) {
  let s = selector.trim(), rejected = false;
  s = s.replace(/:not\(([^()]*)\)/g, (_, inner) => { if (simple(element, inner)) rejected = true; return ''; });
  s = s.replace(/\[([\w-]+)(?:="([^"]*)")?\]/g, (_, name, value) => { if (!element.hasAttribute(name) || value !== undefined && element.getAttribute(name) !== value) rejected = true; return ''; });
  if (rejected) return false;
  const ids = [...s.matchAll(/#([\w-]+)/g)].map(x => x[1]);
  if (ids.some(id => element.id !== id)) return false;
  const classes = [...s.matchAll(/\.([\w-]+)/g)].map(x => x[1]);
  if (classes.some(name => !element.className.split(/\s+/).includes(name))) return false;
  const tag = s.replace(/[#.][\w-]+/g, '').trim();
  return !tag || tag === '*' || tag.toUpperCase() === element.tagName;
}
function matches(element, selector) {
  return selector.split(',').some(part => {
    const tokens = part.trim().replace(/\s*>\s*/g, ' > ').split(/\s+/);
    if (!simple(element, tokens.pop())) return false;
    let cursor = element;
    while (tokens.length) {
      const token = tokens.pop();
      if (token === '>') { cursor = cursor.parentElement; if (!cursor || !simple(cursor, tokens.pop())) return false; }
      else { cursor = cursor.parentElement; while (cursor && !simple(cursor, token)) cursor = cursor.parentElement; if (!cursor) return false; }
    }
    return true;
  });
}
class Element {
  constructor(tag = 'div', attrs = {}) {
    this.nodeType = 1; this.tagName = tag.toUpperCase(); this.attributes = new Map(); this.children = []; this.parentElement = null;
    this.style = {}; this.listeners = new Map(); this._text = ''; this.rect = { top: 20, bottom: 80, left: 20, right: 220, width: 200, height: 60 };
    this.dataset = new Proxy({}, { get: (_, key) => this.getAttribute(dataName(key)) ?? undefined, set: (_, key, value) => { this.setAttribute(dataName(key), value); return true; } });
    for (const [key, value] of Object.entries(attrs)) this.setAttribute(key, value);
  }
  get id() { return this.getAttribute('id') || ''; }
  get className() { return this.getAttribute('class') || ''; }
  get hidden() { return this.hasAttribute('hidden'); }
  set hidden(value) { value ? this.setAttribute('hidden', '') : this.removeAttribute('hidden'); }
  get open() { return this.hasAttribute('open'); }
  set open(value) { value ? this.setAttribute('open', '') : this.removeAttribute('open'); }
  get disabled() { return this.hasAttribute('disabled'); }
  get isConnected() { let n = this; while (n.parentElement) n = n.parentElement; return n === doc?.documentElement; }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
  set textContent(value) { this._text = String(value); notify(this); }
  setAttribute(key, value) { this.attributes.set(key, String(value)); }
  getAttribute(key) { return this.attributes.has(key) ? this.attributes.get(key) : null; }
  hasAttribute(key) { return this.attributes.has(key); }
  removeAttribute(key) { this.attributes.delete(key); }
  matches(selector) { return matches(this, selector); }
  closest(selector) { for (let n = this; n; n = n.parentElement) if (n.matches(selector)) return n; return null; }
  querySelectorAll(selector) { const found = []; const visit = node => { for (const child of node.children) { if (child.matches(selector)) found.push(child); visit(child); } }; visit(this); return found; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  contains(node) { for (let n = node; n; n = n.parentElement) if (n === this) return true; return false; }
  appendChild(node) { node.remove(); this.children.push(node); node.parentElement = this; notify(this, [node]); return node; }
  remove() { const p = this.parentElement; if (!p) return; p.children.splice(p.children.indexOf(this), 1); this.parentElement = null; notify(p, [], [this]); }
  getBoundingClientRect() { return { ...this.rect }; }
  animate(keyframes, options) {
    let resolve, reject;
    const animation = { element: this, keyframes, options, finished: new Promise((a, b) => { resolve = a; reject = b; }),
      finish() { resolve(); }, cancel() { this.cancelled = true; reject(new Error('cancelled')); } };
    animations.push(animation); return animation;
  }
}
class Observer {
  constructor(callback) { this.callback = callback; this.roots = []; this.records = []; observers.push(this); }
  observe(root, options) { this.roots.push([root, options]); }
  disconnect() { this.roots = []; this.records = []; }
}
class Intersection {
  constructor(callback) { this.callback = callback; this.items = new Set(); intersections.push(this); }
  observe(element) { this.items.add(element); }
  unobserve(element) { this.items.delete(element); }
  disconnect() { this.items.clear(); }
}
const documentListeners = new Map();
doc = { hidden: false, activeElement: null, documentElement: new Element('html'),
  addEventListener(type, callback) { const list = documentListeners.get(type) || []; list.push(callback); documentListeners.set(type, list); },
  removeEventListener(type, callback) { documentListeners.set(type, (documentListeners.get(type) || []).filter(fn => fn !== callback)); },
  getElementById(id) { return this.documentElement.id === id ? this.documentElement : this.documentElement.querySelector('#' + id); } };
doc.body = doc.documentElement.appendChild(new Element('body'));
function element(tag, attrs, parent) { const node = new Element(tag, attrs); if (parent) parent.appendChild(node); return node; }
const main = element('main', { id: 'main' }, doc.body);
const dialog = element('dialog', { id: 'app-dialog' }, doc.body);
const dock = element('aside', { id: 'speech-dock', hidden: '' }, doc.body);
const card = element('section', { class: 'panel' }, main);
const nested = element('section', { class: 'record-card' }, card);
const progress = element('div', { class: 'progress' }, card), fill = element('i', {}, progress);
const button = element('button', { class: 'btn', 'aria-pressed': 'true' }, card);
element('svg', { class: 'icon' }, button);
const input = element('textarea', {}, card); input.value = '保存前の答案'; input.selectionStart = 2; input.selectionEnd = 4; doc.activeElement = input;
const surface = element('article', { class: 'article-surface' }, main);
const protectedPanel = element('div', { class: 'panel' }, surface);
const canvas = element('canvas', {}, surface);
const slider = element('input', { type: 'range' }, dock); slider.value = '63';
const term = element('span', { class: 'glossary-term', role: 'button' }, main);
const below = element('section', { class: 'subject-card' }, main); below.rect.top = 1800; below.rect.bottom = 1860;
const mediaHandlers = new Set(), media = { matches: false, addEventListener: (_, fn) => mediaHandlers.add(fn), removeEventListener: (_, fn) => mediaHandlers.delete(fn) };
const changes = [];
const context = { document: doc, performance, MutationObserver: Observer, IntersectionObserver: Intersection,
  innerHeight: 800, location: { hash: '#home' },
  matchMedia: () => media, getComputedStyle: el => ({ boxShadow: el.style.boxShadow || 'none' }),
  requestAnimationFrame: fn => { frames.set(++frameId, fn); return frameId; }, cancelAnimationFrame: id => frames.delete(id),
  CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
  addEventListener(type, fn) { const list = rootEvents.get(type) || []; list.push(fn); rootEvents.set(type, list); },
  dispatchEvent(event) { changes.push(event); for (const fn of rootEvents.get(event.type) || []) fn(event); },
  scrollTo() { throw new Error('Motion must not scroll'); }, scrollBy() { throw new Error('Motion must not scroll'); } };
context.window = context;
const events = (type, target, extra = {}) => {
  const event = { type, target, button: 0, defaultPrevented: false, stopped: false,
    preventDefault() { this.defaultPrevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...extra };
  for (const handler of documentListeners.get(type) || []) handler(event);
  return event;
};
async function settle() {
  for (let pass = 0; pass < 12; pass++) {
    let didWork = false;
    for (const observer of observers) if (observer.records.length) { const records = observer.records.splice(0); observer.callback(records); didWork = true; }
    if (frames.size) { const pending = [...frames.values()]; frames.clear(); for (const fn of pending) fn(); didWork = true; }
    await Promise.resolve();
    if (!didWork) return;
  }
  throw new Error('Observer/animation work did not settle');
}
const finishAnimations = async () => { animations.forEach(a => a.finish()); await Promise.resolve(); };
const checks = [];
const pass = name => checks.push(name);
(async () => {
  vm.runInNewContext(fs.readFileSync(path.join(dist, 'motion.js'), 'utf8'), context);
  const api = context.SiteMotion;
  assert.equal(observers.length, 0); assert.equal(documentListeners.size, 0); pass('no automatic initialization or listeners');
  const beforeRect = canvas.getBoundingClientRect();
  api.init({ mode: 'standard' }); api.init({ mode: 'standard' });
  assert.equal(observers.length, 1); assert.equal(observers[0].roots.length, 3); assert.equal(mediaHandlers.size, 1);
  for (const name of ['click', 'toggle', 'visibilitychange']) assert.equal(documentListeners.get(name).length, 1);
  await settle();
  assert.equal(doc.documentElement.dataset.motionEffective, 'standard'); pass('idempotent initialization and one observer over three roots');
  assert(animations.some(a => a.element === card)); assert(!animations.some(a => a.element === nested));
  assert(!animations.some(a => a.element === protectedPanel || a.element === surface || a.element === canvas));
  assert(animations.some(a => a.element === fill)); pass('finite entry and leaf-progress animation; nested and annotation surfaces protected');
  assert.equal(doc.activeElement, input); assert.equal(input.value, '保存前の答案'); assert.equal(input.selectionStart, 2); assert.equal(input.selectionEnd, 4);
  assert.deepEqual(canvas.getBoundingClientRect(), beforeRect); pass('focus, input value, text selection and annotation coordinates remain unchanged');
  assert.equal(api.getDiagnostics().observedCards, 1);
  const io = intersections[0]; io.callback([{ target: below, isIntersecting: true }]);
  const entered = animations.filter(a => a.element === below).length;
  io.callback([{ target: below, isIntersecting: true }]);
  assert.equal(animations.filter(a => a.element === below).length, entered); assert.equal(api.getDiagnostics().observedCards, 0);
  pass('offscreen cards reveal once and are unobserved');
  await finishAnimations();
  const click = events('click', button); assert(!click.defaultPrevented && !click.stopped); assert(animations.some(a => a.element === button));
  pass('ordinary click retains native action and propagation');
  const count = animations.length;
  for (const target of [slider, input, canvas, term]) events('click', target);
  events('click', button, { button: 2 });
  assert.equal(animations.length, count); assert.equal(slider.value, '63'); pass('range, editable text, canvas, glossary and secondary clicks excluded');
  const fold = element('details', {}, main), summary = element('summary', {}, fold), foldText = element('p', {}, fold);
  fold.open = true; events('toggle', fold);
  assert(fold.open); assert(animations.some(a => a.element === foldText)); assert(!animations.some(a => a.element === summary));
  pass('native accordion opens immediately without height manipulation');
  const oldAnimationCount = animations.length;
  context.location.hash = '#laws/334AC0000000121/A2'; dock.hidden = false;
  const followingCard = element('div', { class: 'panel' }, main); await settle();
  assert.equal(animations.length, oldAnimationCount); pass('speech-follow redraws suppress entry animation and never scroll');
  context.location.hash = '#settings'; dock.hidden = true;
  api.setMode('off'); await settle();
  assert.equal(api.getMode(), 'off'); assert.equal(api.getEffectiveMode(), 'off'); assert.equal(api.getDiagnostics().activeAnimations, 0);
  assert.equal(observers[0].roots.length, 0); assert.equal(button.getAttribute('aria-pressed'), 'true');
  const offCount = animations.length; events('click', button); assert.equal(animations.length, offCount);
  pass('off cancels motion and observation while preserving selected state');
  api.setMode('subtle'); const soft = element('div', { class: 'record-card' }, main); await settle();
  const softAnimation = animations.find(a => a.element === soft);
  assert(softAnimation); assert.equal(softAnimation.options.duration, 90); assert.equal(softAnimation.keyframes[0].opacity, .96);
  pass('subtle mode uses short opacity-only entry');
  media.matches = true; for (const fn of mediaHandlers) fn({ matches: true }); await settle();
  assert.equal(api.getMode(), 'subtle'); assert.equal(api.getEffectiveMode(), 'off');
  assert(changes.some(e => e.type === 'site-motion-change' && e.detail.reducedMotion && e.detail.effectiveMode === 'off'));
  api.setMode('standard'); assert.equal(api.getMode(), 'standard'); assert.equal(api.getEffectiveMode(), 'off');
  media.matches = false; for (const fn of mediaHandlers) fn({ matches: false });
  assert.equal(api.getEffectiveMode(), 'standard'); assert.equal(observers[0].roots.length, 3);
  pass('OS reduced motion overrides selection and notifies the settings UI');
  const detached = element('section', { class: 'subject-card' }, main); detached.rect.top = 2100; detached.rect.bottom = 2160;
  await settle(); assert.equal(api.getDiagnostics().observedCards, 1); detached.remove(); await settle();
  assert.equal(api.getDiagnostics().observedCards, 0); pass('removed cards are released by intersection observation');
  assert(animations.every(a => a.options.iterations === 1 && a.options.duration + a.options.delay < 1000));
  assert(animations.every(a => a.keyframes.every(k => !('transform' in k) && !('height' in k) && !('width' in k))));
  pass('all effects are bounded; no geometry-changing JS keyframes');
  api.destroy(); await settle();
  assert.equal(mediaHandlers.size, 0); assert.equal(api.getDiagnostics().observerCount, 0);
  for (const name of ['click', 'toggle', 'visibilitychange']) assert.equal(documentListeners.get(name).length, 0);
  assert.equal(doc.documentElement.getAttribute('data-motion-mode'), null);
  api.init({ mode: 'off' }); assert.equal(api.getDiagnostics().observerCount, 1); assert.equal(documentListeners.get('click').length, 1);
  api.destroy(); pass('destroy and reinitialize clean listeners, pending work and datasets');
  const css = fs.readFileSync(path.join(dist, 'motion.css'), 'utf8');
  assert(!/\binfinite\b/.test(css)); assert(css.includes('prefers-reduced-motion: reduce')); assert(css.includes('min-height: 44px')); assert(css.includes('font-size: 14px'));
  assert(css.includes('repeat(3, minmax(0, 1fr))')); assert(css.includes('[aria-pressed="true"]'));
  pass('finite CSS, reduced-motion override, and accessible three-column settings controls');
  const report = { ok: true, checks: checks.length, passed: checks, animationsExercised: animations.length,
    caveat: 'DOM/lifecycle unit harness only. Browser visual/layout QA remains separate.' };
  if (process.argv[3]) fs.writeFileSync(path.resolve(process.argv[3]), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
