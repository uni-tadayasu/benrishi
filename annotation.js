/* Browser-local annotation layer. Text marks follow character offsets; ink is saved by reading width. */
(function () {
  'use strict';
  const STORAGE_KEY = 'benrishi-ink-v1';
  const PALETTE = ['#f5c451', '#47c9ad', '#71aaf1', '#e68dab'];
  const COLOR_NAMES = ['黄', '緑', '青', '桃'];
  const MODES = [['select', '読む'], ['text', '文字マーカー'], ['pen', 'ペン'], ['marker', '自由マーカー'], ['underline', '直線'], ['eraser', '消しゴム']];
  const clone = value => JSON.parse(JSON.stringify(value));
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  function signature(text) {
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
    return text.length + '-' + (hash >>> 0).toString(36);
  }
  function installStyles() {
    if (document.getElementById('benrishi-annotation-style')) return;
    const style = document.createElement('style');
    style.id = 'benrishi-annotation-style';
    style.textContent = `
      .annotation-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:12px;border:1px solid rgba(130,153,170,.25);border-radius:12px;background:rgba(130,153,170,.07);color:inherit;margin:12px 0;font-size:14px;line-height:1.5}
      .annotation-toolbar button{min-height:36px;padding:7px 10px;border:1px solid rgba(130,153,170,.32);border-radius:8px;background:transparent;color:inherit;font:inherit;cursor:pointer;touch-action:manipulation}
      .annotation-toolbar button:focus-visible,.annotation-toolbar input:focus-visible{outline:3px solid #47c9ad;outline-offset:3px}
      .annotation-toolbar button[aria-pressed="true"]{background:#47c9ad;border-color:#47c9ad;color:#092b25}
      .annotation-toolbar button:disabled{opacity:.42;cursor:not-allowed}
      .annotation-toolbar .annotation-color{min-height:30px;width:30px;padding:0;border-radius:50%;background:var(--ink-color);border:3px solid transparent;box-shadow:inset 0 0 0 1px rgba(0,0,0,.2)}
      .annotation-toolbar .annotation-color[aria-pressed="true"]{background:var(--ink-color);border-color:currentColor;outline:1px solid rgba(130,153,170,.5);outline-offset:2px}
      .annotation-tools{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
      .annotation-tools+.annotation-tools{padding-left:8px;border-left:1px solid rgba(130,153,170,.25)}
      .annotation-width{display:inline-flex;align-items:center;gap:7px;white-space:nowrap}
      .annotation-width input{width:86px;accent-color:#47c9ad}
      .annotation-help{flex:1 0 100%;margin:0;font-size:14px;opacity:.82}
      .annotation-confirm{flex:1 0 100%;display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:8px;border-radius:8px;background:rgba(230,141,171,.12)}
      .annotation-confirm[hidden]{display:none}
      .annotation-status{flex:1 0 100%;margin:0;font-size:14px;color:#d17953}
      .annotation-status:empty{display:none}
      [data-benrishi-reading],[data-benrishi-reading] *{user-select:none!important;-webkit-user-select:none!important;-webkit-touch-callout:none!important}
      mark[data-benrishi-ink]{color:inherit;padding:0;border-radius:2px;box-decoration-break:clone;-webkit-box-decoration-break:clone}
      .annotation-canvas{position:absolute!important;inset:0 auto auto 0!important;display:block!important;margin:0!important;padding:0!important;border:0!important;z-index:3;user-select:none;-webkit-user-select:none;pointer-events:none;touch-action:auto}
      @media(max-width:560px){.annotation-toolbar{gap:7px;padding:10px}.annotation-tools+.annotation-tools{padding-left:0;border-left:0}.annotation-toolbar button{padding:7px 8px}}
    `;
    document.head.appendChild(style);
  }
  function textNodes(root) {
    const list = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return node.parentElement && node.parentElement.closest('script,style,canvas,[data-annotation-ui]')
          ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      }
    });
    while (walker.nextNode()) list.push(walker.currentNode);
    return list;
  }
  function pointSegmentDistance(point, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const scale = dx * dx + dy * dy;
    const t = scale ? clamp(((point.x - a.x) * dx + (point.y - a.y) * dy) / scale, 0, 1) : 0;
    return Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy);
  }
  function segmentDistance(a, b, c, d) {
    const cross = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
    const x1 = cross(a, b, c), x2 = cross(a, b, d), x3 = cross(c, d, a), x4 = cross(c, d, b);
    if (((x1 > 0 && x2 < 0) || (x1 < 0 && x2 > 0)) && ((x3 > 0 && x4 < 0) || (x3 < 0 && x4 > 0))) return 0;
    return Math.min(pointSegmentDistance(a, c, d), pointSegmentDistance(b, c, d), pointSegmentDistance(c, a, b), pointSegmentDistance(d, a, b));
  }
  function mount(options) {
    if (!options || !(options.host instanceof HTMLElement)) throw new TypeError('AnnotationLayer.mount requires a host element.');
    installStyles();
    const host = options.host;
    const target = host.querySelector('.law-original') || host;
    const key = String(options.key || 'law-note');
    const baseText = textNodes(target).map(node => node.data).join('');
    const textVersion = signature(baseText);
    const originalPosition = target.style.position;
    const originalReadingAttribute = target.getAttribute('data-benrishi-reading');
    target.setAttribute('data-benrishi-reading', 'false');
    if (getComputedStyle(target).position === 'static') target.style.position = 'relative';
    let destroyed = false, mode = 'select', color = PALETTE[0], width = 3;
    let state, storageHealthy = true, warning = '';
    let active = null, lastStylusTime = -Infinity, bucket = '', cssWidth = 1, cssHeight = 1, dpr = 1;
    let frame = 0, resizeFrame = 0, lastErasePoint = null, eraserChanged = false;
    const undoStack = [], redoStack = [];
    const toolbar = document.createElement('div');
    toolbar.className = 'annotation-toolbar';
    toolbar.dataset.annotationUi = 'true';
    toolbar.setAttribute('aria-label', '条文への書き込み');
    const modes = document.createElement('div'); modes.className = 'annotation-tools';
    const colors = document.createElement('div'); colors.className = 'annotation-tools';
    const actions = document.createElement('div'); actions.className = 'annotation-tools';
    const help = document.createElement('p'); help.className = 'annotation-help';
    const status = document.createElement('p'); status.className = 'annotation-status'; status.setAttribute('role', 'status');
    const confirm = document.createElement('div'); confirm.className = 'annotation-confirm'; confirm.hidden = true;
    const canvas = document.createElement('canvas'); canvas.className = 'annotation-canvas'; canvas.setAttribute('aria-hidden', 'true'); canvas.dataset.annotationUi = 'true';
    const cachedCanvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { desynchronized: true });
    const cachedContext = cachedCanvas.getContext('2d');
    if (!context || !cachedContext) throw new Error('Canvas 2D is unavailable.');
    target.appendChild(canvas);
    function freshState() { return { marks: [], drawings: {} }; }
    function readRoot() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return { version: 1, pages: {} };
        const root = JSON.parse(raw);
        if (root.version !== 1 || !root.pages || typeof root.pages !== 'object') throw new Error('Unsupported annotation data');
        return root;
      } catch (_) {
        storageHealthy = false;
        warning = '端末保存を利用できません。書き込みは、この画面を閉じるまで有効です。';
        return { version: 1, pages: {} };
      }
    }
    function cleanState(saved) {
      const clean = freshState();
      if (!saved || typeof saved !== 'object') return clean;
      if (Array.isArray(saved.marks)) clean.marks = saved.marks.filter(mark => mark && Number.isInteger(mark.start) && Number.isInteger(mark.end) && mark.start >= 0 && mark.end <= baseText.length && mark.end > mark.start).map(mark => ({ id: String(mark.id || uid()), start: mark.start, end: mark.end, color: PALETTE.includes(mark.color) ? mark.color : PALETTE[0] }));
      if (saved.drawings && typeof saved.drawings === 'object') {
        for (const [name, strokes] of Object.entries(saved.drawings)) {
          if (!/^w\d+$/.test(name) || !Array.isArray(strokes)) continue;
          clean.drawings[name] = strokes.filter(stroke => stroke && ['pen', 'marker', 'underline'].includes(stroke.kind) && finite(stroke.refWidth) && stroke.refWidth > 0 && finite(stroke.refHeight) && stroke.refHeight > 0 && Array.isArray(stroke.points)).map(stroke => ({
            id: String(stroke.id || uid()), kind: stroke.kind, color: PALETTE.includes(stroke.color) ? stroke.color : PALETTE[0], width: clamp(Number(stroke.width) || 3, 1, 14), refWidth: stroke.refWidth, refHeight: stroke.refHeight,
            points: stroke.points.filter(point => point && finite(point.x) && finite(point.y) && finite(point.p)).map(point => ({ x: clamp(point.x, 0, 1), y: clamp(point.y, 0, 1), p: clamp(point.p, .08, 1) }))
          })).filter(stroke => stroke.points.length);
        }
      }
      return clean;
    }
    const initialRoot = readRoot();
    const page = Object.prototype.hasOwnProperty.call(initialRoot.pages, key) ? initialRoot.pages[key] : null;
    state = cleanState(page && page.versions && page.versions[textVersion]);
    if (page && page.versions && !page.versions[textVersion] && Object.keys(page.versions).length) warning = '本文の更新を検出しました。旧本文の書き込みは、元の本文用として保持しています。';
    function currentStrokes() { return state.drawings[bucket] || []; }
    function save() {
      if (destroyed) return;
      if (storageHealthy) {
        const root = readRoot();
        if (storageHealthy) {
          try {
            const prior = Object.prototype.hasOwnProperty.call(root.pages, key) ? root.pages[key] : null;
            const versions = prior && prior.versions && typeof prior.versions === 'object' ? prior.versions : {};
            versions[textVersion] = clone(state);
            Object.defineProperty(root.pages, key, { value: { versions, updatedAt: new Date().toISOString() }, enumerable: true, writable: true, configurable: true });
            localStorage.setItem(STORAGE_KEY, JSON.stringify(root));
            if (warning.startsWith('端末への保存に失敗')) warning = '';
          } catch (_) { warning = '端末への保存に失敗しました。空き容量やブラウザの保存設定を確認してください。'; }
        }
      }
      if (typeof options.onSave === 'function') {
        try { options.onSave({ key, textVersion, textMarks: state.marks.length, strokes: Object.values(state.drawings).reduce((sum, list) => sum + list.length, 0) }); } catch (_) { /* A caller callback must not interrupt writing. */ }
      }
      updateToolbar();
    }
    function remember() { undoStack.push(clone(state)); if (undoStack.length > 50) undoStack.shift(); redoStack.length = 0; }
    function button(label, action, parent) {
      const element = document.createElement('button'); element.type = 'button'; element.textContent = label;
      element.addEventListener('click', action); (parent || actions).appendChild(element); return element;
    }
    const modeButtons = MODES.map(([value, label]) => {
      const element = button(label, () => setMode(value), modes);
      element.dataset.mode = value; return element;
    });
    const colorButtons = PALETTE.map((value, index) => {
      const element = button('', () => { color = value; updateToolbar(); }, colors);
      element.className = 'annotation-color'; element.style.setProperty('--ink-color', value);
      element.title = COLOR_NAMES[index]; element.setAttribute('aria-label', COLOR_NAMES[index] + '色'); return element;
    });
    const widthLabel = document.createElement('label'); widthLabel.className = 'annotation-width';
    const widthText = document.createElement('span'); widthText.textContent = '太さ';
    const widthInput = document.createElement('input'); widthInput.type = 'range'; widthInput.min = '1'; widthInput.max = '14'; widthInput.step = '.5'; widthInput.value = String(width); widthInput.setAttribute('aria-label', 'ペンの太さ');
    widthInput.addEventListener('input', () => { width = Number(widthInput.value); });
    widthLabel.append(widthText, widthInput); colors.appendChild(widthLabel);
    const undoButton = button('元に戻す', undo);
    const redoButton = button('やり直す', redo);
    button('書き込みを消去', () => { confirm.hidden = false; });
    const confirmText = document.createElement('span'); confirmText.textContent = 'この本文の文字マークと手書きを消去しますか？'; confirm.appendChild(confirmText);
    button('消去する', () => { cancelActive(); remember(); state = freshState(); confirm.hidden = true; renderTextMarks(); resize(); save(); }, confirm);
    button('キャンセル', () => { confirm.hidden = true; }, confirm);
    toolbar.append(modes, colors, actions, confirm, help, status);
    function updateToolbar() {
      modeButtons.forEach(element => element.setAttribute('aria-pressed', String(element.dataset.mode === mode)));
      colorButtons.forEach((element, index) => element.setAttribute('aria-pressed', String(PALETTE[index] === color)));
      undoButton.disabled = undoStack.length === 0; redoButton.disabled = redoStack.length === 0;
      help.textContent = mode === 'select'
        ? '読むときはスクロールできます。文字を正確に塗るには「文字マーカー」を選び、本文をなぞってください。'
        : mode === 'text' ? '本文の文字をドラッグして塗ります。長押しや標準の文字選択は不要です。文字マークは画面幅が変わっても同じ文字に残ります。'
        : mode === 'eraser' ? 'なぞった手書きの線や文字マークを消します。「読む」でスクロールに戻ります。'
        : 'ペン・指で本文に書けます。手書きは画面幅ごとに保存します。スクロールは「読む」に切り替えてください。';
      status.textContent = warning;
    }
    function setMode(next) {
      if (!MODES.some(([value]) => value === next)) return;
      if (next !== 'select' && window.App?.glossary?.mode) window.App.glossary.disable();
      cancelActive(); mode = next;
      target.setAttribute('data-benrishi-reading', 'false');
      canvas.style.pointerEvents = mode === 'select' ? 'none' : 'auto';
      canvas.style.touchAction = mode === 'select' ? 'auto' : 'none';
      canvas.style.cursor = mode === 'eraser' ? 'cell' : 'crosshair';
      updateToolbar(); render();
    }
    function unwrapMarks() {
      target.querySelectorAll('mark[data-benrishi-ink]').forEach(mark => mark.replaceWith(...mark.childNodes));
      target.normalize();
    }
    function renderTextMarks(preview = null) {
      unwrapMarks();
      const marks = preview ? state.marks.concat(preview) : state.marks;
      if (!marks.length) return;
      let offset = 0;
      for (const node of textNodes(target)) {
        const start = offset, end = offset + node.data.length; offset = end;
        const matches = marks.filter(mark => mark.start < end && mark.end > start);
        if (!matches.length) continue;
        const bounds = new Set([start, end]);
        matches.forEach(mark => { bounds.add(Math.max(start, mark.start)); bounds.add(Math.min(end, mark.end)); });
        const points = [...bounds].sort((a, b) => a - b);
        const fragment = document.createDocumentFragment();
        for (let i = 0; i < points.length - 1; i++) {
          const from = points[i], to = points[i + 1];
          const applied = matches.filter(mark => mark.start <= from && mark.end >= to).pop();
          const text = document.createTextNode(node.data.slice(from - start, to - start));
          if (applied) {
            const mark = document.createElement('mark'); mark.dataset.benrishiInk = applied.id;
            mark.style.backgroundColor = applied.color + '66'; mark.appendChild(text); fragment.appendChild(mark);
          } else fragment.appendChild(text);
        }
        node.replaceWith(fragment);
      }
    }
    function caretOffset(event) {
      const rect = canvas.getBoundingClientRect();
      const x = clamp(event.clientX, rect.left + 1, Math.max(rect.left + 1, rect.right - 1));
      const y = clamp(event.clientY, rect.top + 1, Math.max(rect.top + 1, rect.bottom - 1));
      const before = canvas.style.pointerEvents;
      canvas.style.pointerEvents = 'none';
      try {
        let container, offset;
        if (typeof document.caretPositionFromPoint === 'function') {
          const position = document.caretPositionFromPoint(x, y);
          if (position) { container = position.offsetNode; offset = position.offset; }
        }
        if ((!container || !target.contains(container)) && typeof document.caretRangeFromPoint === 'function') {
          const range = document.caretRangeFromPoint(x, y);
          if (range) { container = range.startContainer; offset = range.startOffset; }
        }
        if (!container || !target.contains(container) || container === canvas || canvas.contains(container)) return null;
        const prefix = document.createRange(); prefix.selectNodeContents(target); prefix.setEnd(container, offset);
        return clamp(prefix.toString().length, 0, baseText.length);
      } catch (_) { return null; }
      finally { canvas.style.pointerEvents = before; }
    }
    function updateTextPreview(event) {
      if (!active || active.kind !== 'text') return;
      const offset = caretOffset(event); if (offset === null) return;
      active.endOffset = offset;
      const start = Math.min(active.startOffset, offset), end = Math.max(active.startOffset, offset);
      active.preview = end > start ? { id: 'preview-' + active.id, start, end, color: active.color } : null;
      requestRender();
    }
    function undo() {
      if (!undoStack.length) return;
      cancelActive(); redoStack.push(clone(state)); state = undoStack.pop();
      renderTextMarks(); resize(); save();
    }
    function redo() {
      if (!redoStack.length) return;
      cancelActive(); undoStack.push(clone(state)); state = redoStack.pop();
      renderTextMarks(); resize(); save();
    }
    function displayedPoints(stroke) {
      const scale = cssWidth / stroke.refWidth;
      return stroke.points.map(point => ({ x: point.x * cssWidth, y: point.y * stroke.refHeight * scale, p: point.p }));
    }
    function strokeWidth(stroke) { return stroke.width * (stroke.kind === 'marker' ? 5 : 1) * cssWidth / stroke.refWidth; }
    function drawStroke(ctx, stroke) {
      const points = displayedPoints(stroke); if (!points.length) return;
      const lineWidth = strokeWidth(stroke);
      ctx.save(); ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = stroke.color; ctx.fillStyle = stroke.color;
      ctx.globalAlpha = stroke.kind === 'marker' ? .27 : .96;
      if (points.length === 1) {
        ctx.beginPath(); ctx.arc(points[0].x, points[0].y, lineWidth * (stroke.kind === 'pen' ? .35 + .65 * points[0].p : 1) / 2, 0, Math.PI * 2); ctx.fill(); ctx.restore(); return;
      }
      if (stroke.kind === 'underline') {
        ctx.lineWidth = lineWidth; ctx.beginPath(); ctx.moveTo(points[0].x, points[0].y); const last = points[points.length - 1]; ctx.lineTo(last.x, last.y); ctx.stroke();
      } else if (stroke.kind === 'marker') {
        ctx.lineWidth = lineWidth; ctx.beginPath(); ctx.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length - 1; i++) ctx.quadraticCurveTo(points[i].x, points[i].y, (points[i].x + points[i + 1].x) / 2, (points[i].y + points[i + 1].y) / 2);
        const last = points[points.length - 1]; ctx.lineTo(last.x, last.y); ctx.stroke();
      } else {
        let start = points[0];
        for (let i = 1; i < points.length; i++) {
          const control = points[i], next = points[i + 1];
          const end = next ? { x: (control.x + next.x) / 2, y: (control.y + next.y) / 2 } : control;
          ctx.lineWidth = lineWidth * (.35 + .65 * (points[i - 1].p + control.p) / 2);
          ctx.beginPath(); ctx.moveTo(start.x, start.y); ctx.quadraticCurveTo(control.x, control.y, end.x, end.y); ctx.stroke(); start = end;
        }
      }
      ctx.restore();
    }
    function buildCache() {
      cachedContext.setTransform(dpr, 0, 0, dpr, 0, 0); cachedContext.clearRect(0, 0, cssWidth, cssHeight);
      currentStrokes().forEach(stroke => drawStroke(cachedContext, stroke));
    }
    function render() {
      if (destroyed) return;
      if (active && active.kind === 'text') renderTextMarks(active.preview);
      context.setTransform(dpr, 0, 0, dpr, 0, 0); context.clearRect(0, 0, cssWidth, cssHeight);
      context.drawImage(cachedCanvas, 0, 0, cachedCanvas.width, cachedCanvas.height, 0, 0, cssWidth, cssHeight);
      if (active && active.stroke) drawStroke(context, active.stroke);
    }
    function requestRender() {
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; render(); });
    }
    function resize() {
      if (destroyed) return;
      const nextWidth = Math.max(1, target.clientWidth), nextHeight = Math.max(1, target.clientHeight);
      const nextBucket = 'w' + Math.max(80, Math.round(nextWidth / 80) * 80);
      if (active && (nextBucket !== bucket || Math.abs(nextWidth - cssWidth) > 1)) cancelActive();
      cssWidth = nextWidth; cssHeight = nextHeight; bucket = nextBucket;
      dpr = Math.min(window.devicePixelRatio || 1, 3, 8192 / cssWidth, 8192 / cssHeight, Math.sqrt(16000000 / (cssWidth * cssHeight)));
      const pixelWidth = Math.max(1, Math.round(cssWidth * dpr)), pixelHeight = Math.max(1, Math.round(cssHeight * dpr));
      canvas.width = cachedCanvas.width = pixelWidth; canvas.height = cachedCanvas.height = pixelHeight;
      canvas.style.width = cssWidth + 'px'; canvas.style.height = cssHeight + 'px';
      buildCache(); render(); updateToolbar();
    }
    function requestResize() {
      if (!resizeFrame) resizeFrame = requestAnimationFrame(() => { resizeFrame = 0; resize(); });
    }
    function eventPoint(event, stroke) {
      const rect = canvas.getBoundingClientRect();
      const x = clamp(event.clientX - rect.left, 0, cssWidth), y = clamp(event.clientY - rect.top, 0, cssHeight);
      const pressure = event.pointerType === 'pen' ? clamp(event.pressure > 0 ? event.pressure : .45, .08, 1) : 1;
      return { x: x / (stroke ? stroke.refWidth : cssWidth), y: y / (stroke ? stroke.refHeight : cssHeight), p: pressure };
    }
    function pixelEventPoint(event) {
      const rect = canvas.getBoundingClientRect(); return { x: clamp(event.clientX - rect.left, 0, cssWidth), y: clamp(event.clientY - rect.top, 0, cssHeight) };
    }
    function eraseAt(event) {
      const point = pixelEventPoint(event), last = lastErasePoint || point, radius = Math.max(12, width * 3);
      const strokes = currentStrokes();
      const remaining = strokes.filter(stroke => {
        const points = displayedPoints(stroke), threshold = radius + strokeWidth(stroke) / 2;
        if (points.length === 1) return pointSegmentDistance(points[0], last, point) > threshold;
        for (let i = 1; i < points.length; i++) if (segmentDistance(last, point, points[i - 1], points[i]) <= threshold) return false;
        return true;
      });
      let changed = remaining.length !== strokes.length;
      if (changed) state.drawings[bucket] = remaining;
      const markedElement = document.elementsFromPoint(event.clientX, event.clientY).map(element => element.closest && element.closest('mark[data-benrishi-ink]')).find(element => element && target.contains(element));
      if (markedElement) {
        state.marks = state.marks.filter(mark => mark.id !== markedElement.dataset.benrishiInk); renderTextMarks(); changed = true;
      }
      if (changed) { eraserChanged = true; buildCache(); requestRender(); }
      lastErasePoint = point;
    }
    function pointerDown(event) {
      if (mode === 'select' || event.button !== 0) return;
      if (event.pointerType === 'touch' && (performance.now() - lastStylusTime < 1200 || (active && active.pointerType === 'pen'))) { event.preventDefault(); return; }
      if (active) {
        if (event.pointerType === 'pen' && active.pointerType === 'touch') cancelActive(); else return;
      }
      if (event.pointerType === 'pen') lastStylusTime = performance.now();
      event.preventDefault();
      const before = clone(state);
      const startOffset = mode === 'text' ? caretOffset(event) : null;
      if (mode === 'text' && startOffset === null) { warning = '文字の上からなぞってください。このブラウザで文字位置を取得できない場合は、自由マーカーをご利用ください。'; updateToolbar(); return; }
      if (mode === 'text' && warning.startsWith('文字の上から')) warning = '';
      active = { id: uid(), kind: mode, pointerId: event.pointerId, pointerType: event.pointerType, before, stroke: null, startOffset, endOffset: startOffset, preview: null, color };
      try { canvas.setPointerCapture(event.pointerId); } catch (_) { /* Capture is optional if the pointer has already ended. */ }
      if (mode === 'text') { updateTextPreview(event); }
      else if (mode === 'eraser') { lastErasePoint = null; eraserChanged = false; eraseAt(event); }
      else {
        const stroke = { id: uid(), kind: mode, color, width, refWidth: cssWidth, refHeight: cssHeight, points: [] };
        stroke.points.push(eventPoint(event, stroke)); active.stroke = stroke; requestRender();
      }
    }
    function appendPoint(event) {
      const stroke = active && active.stroke; if (!stroke) return;
      const point = eventPoint(event, stroke), previous = stroke.points[stroke.points.length - 1];
      if (stroke.kind === 'underline') { stroke.points = [stroke.points[0], point]; return; }
      if (previous && Math.hypot((point.x - previous.x) * stroke.refWidth, (point.y - previous.y) * stroke.refHeight) < .3 && Math.abs(point.p - previous.p) < .05) return;
      stroke.points.push(point);
    }
    function pointerMove(event) {
      if (event.pointerType === 'pen') lastStylusTime = performance.now();
      if (!active || active.pointerId !== event.pointerId) return;
      event.preventDefault();
      const events = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : [];
      const samples = events.length ? events : [event];
      if (mode === 'text') updateTextPreview(samples[samples.length - 1]);
      else if (mode === 'eraser') samples.forEach(eraseAt); else { samples.forEach(appendPoint); requestRender(); }
    }
    function pointerUp(event) {
      if (!active || active.pointerId !== event.pointerId) return;
      event.preventDefault();
      if (event.pointerType === 'pen') lastStylusTime = performance.now();
      if (active.kind === 'text') updateTextPreview(event);
      const wasTextMode = active.kind === 'text';
      const textMark = wasTextMode ? active.preview : null;
      const changed = !!active.stroke || eraserChanged || !!textMark;
      if (textMark) state.marks.push({ ...textMark, id: uid() });
      if (active.stroke) { appendPoint(event); (state.drawings[bucket] || (state.drawings[bucket] = [])).push(active.stroke); }
      if (changed) { undoStack.push(active.before); if (undoStack.length > 50) undoStack.shift(); redoStack.length = 0; }
      const pointerId = active.pointerId; active = null; lastErasePoint = null; eraserChanged = false;
      try { if (canvas.hasPointerCapture(pointerId)) canvas.releasePointerCapture(pointerId); } catch (_) { /* No capture remains. */ }
      if (wasTextMode) renderTextMarks();
      buildCache(); render(); if (changed) save(); else updateToolbar();
    }
    function cancelActive() {
      if (!active) return;
      const previous = active; active = null; lastErasePoint = null; eraserChanged = false;
      if (!previous.stroke) { state = previous.before; renderTextMarks(); }
      try { if (canvas.hasPointerCapture(previous.pointerId)) canvas.releasePointerCapture(previous.pointerId); } catch (_) { /* No capture remains. */ }
      buildCache(); render(); updateToolbar();
    }
    function pointerCancel(event) { if (active && active.pointerId === event.pointerId) cancelActive(); }
    function lostCapture(event) { if (active && active.pointerId === event.pointerId) cancelActive(); }
    canvas.addEventListener('pointerdown', pointerDown);
    canvas.addEventListener('pointermove', pointerMove);
    canvas.addEventListener('pointerup', pointerUp);
    canvas.addEventListener('pointercancel', pointerCancel);
    canvas.addEventListener('lostpointercapture', lostCapture);
    const suppressNative = event => event.preventDefault();
    target.addEventListener('contextmenu', suppressNative);
    target.addEventListener('dblclick', suppressNative);
    target.addEventListener('selectstart', suppressNative);
    window.addEventListener('resize', requestResize);
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(requestResize) : null;
    if (observer) observer.observe(target);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { if (!destroyed) requestResize(); });
    renderTextMarks(); resize(); updateToolbar();
    function destroy() {
      if (destroyed) return;
      cancelActive(); destroyed = true;
      cancelAnimationFrame(frame); cancelAnimationFrame(resizeFrame);
      if (observer) observer.disconnect();
      target.removeEventListener('contextmenu', suppressNative);
      target.removeEventListener('dblclick', suppressNative);
      target.removeEventListener('selectstart', suppressNative);
      window.removeEventListener('resize', requestResize);
      canvas.remove(); toolbar.remove(); unwrapMarks(); target.style.position = originalPosition;
      if (originalReadingAttribute === null) target.removeAttribute('data-benrishi-reading'); else target.setAttribute('data-benrishi-reading', originalReadingAttribute);
    }
    return { toolbar, destroy, setMode, undo, redo, getState: () => clone(state) };
  }
  window.AnnotationLayer = { mount, storageKey: STORAGE_KEY };
})();
