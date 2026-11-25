/* LegalProsody 2026-11-25
 * Plan utterance boundaries and pauses for already prepared speech text.
 * This does not change pronunciation, numbers, pitch, or displayed legal text.
 * maxLength is a target: an indivisible word/reference may exceed it.
 * The final segment has pauseAfter: 0. No SSML is produced.
 */
(function (root) {
  'use strict';
  const NUM = '[0-9０-９〇零一二三四五六七八九十百千万億壱弐参]+';
  const REF_PART = '(?:第\\s*)?' + NUM + '\\s*[条項号章節款目編](?:\\s*の\\s*' + NUM + ')*';
  const RAW_REF = '(?:' + REF_PART + ')(?:\\s*' + REF_PART + ')*';
  const KNUM = '(?:じゅう|じゅっ|じっ|ひゃく|びゃく|ぴゃく|きゅう|ちょう|いち|いっ|さん|よん|ろく|ろっ|なな|しち|はち|はっ|せん|ぜん|まん|おく|れい|ぜろ|に|し|ご|く){1,32}';
  const KPART = 'だい' + KNUM + '(?:じょう|こう|ごう|しょう|せつ|かん|もく|へん)(?:の' + KNUM + ')*';
  const KANA_REF = '(?:' + KPART + ')(?:\\s*' + KPART + ')*';
  const PAUSES = {
    natural: { continuation: 45, clause: 120, line: 160, sentence: 260, heading: 300, paragraph: 400 },
    careful: { continuation: 85, clause: 180, line: 260, sentence: 420, heading: 500, paragraph: 650 }
  };
  const RANK = { continuation: 0, clause: 1, line: 2, sentence: 3, heading: 4, paragraph: 5 };

  function segmenter(lang, granularity) {
    try {
      return typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
        ? new Intl.Segmenter(lang, { granularity }) : null;
    } catch (_) {
      try { return new Intl.Segmenter('ja', { granularity }); } catch (_) { return null; }
    }
  }

  function protectedRanges(text) {
    const patterns = [
      new RegExp(RAW_REF, 'gu'), new RegExp(KANA_REF, 'gu'),
      /\b(?:Articles?|Sections?|Rules?|Chapters?|Art\.?|Sec\.?)\s+\d+(?:[.\-]\d+)*(?:\s*\([A-Za-z0-9]+\))*/giu,
      /§\s*\d+(?:\s*\([A-Za-z0-9]+\))*/gu,
      /[0-9０-９]+(?:[.,，．][0-9０-９]+)*(?:\s*[%％])?/gu,
      /https?:\/\/[^\s]+/gu
    ];
    const ranges = [];
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) ranges.push([match.index, match.index + match[0].length]);
    }
    ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const merged = [];
    for (const range of ranges) {
      const last = merged[merged.length - 1];
      if (last && range[0] < last[1]) last[1] = Math.max(last[1], range[1]);
      else merged.push(range.slice());
    }
    return merged;
  }

  function isHeading(line) {
    const t = line.trim();
    if (!t || t.length > 64 || /[。.!?！？;；]$/.test(t)) return false;
    if (/^[（(【][^\n（）()【】]{1,42}[）)】]$/u.test(t)) {
      return !/^[（(【][0-9０-９一二三四五六七八九十百イロハニホヘトa-zA-Z]+[）)】]$/u.test(t);
    }
    if (new RegExp('^(?:' + RAW_REF + '|' + KANA_REF + ')(?: +[^、。！？;；]{1,28})?$', 'u').test(t)) return true;
    if (/^(?:目的|定義|要点|注意|原則|例外|見出し|適用範囲|総則|附則|まとめ)[：:]?$/u.test(t)) return true;
    if (/^[^、,;；]{1,40}[：:]$/u.test(t)) return true;
    if (/^(?:Article|Section|Chapter|Rule)\s+\d+(?:[.\-]\d+)*(?:\s*[—–:]\s*.+)?$/u.test(t)) return true;
    // Explicit title case, not arbitrary lower-case lines in wrapped English text.
    if (/^[A-Z][A-Za-z0-9 '&:/\-]{0,45}$/u.test(t)) {
      return t.split(/\s+/).every(w => /^[A-Z0-9]/.test(w) || /^(?:of|the|and|in|on|to|for|a|an|&)$/u.test(w));
    }
    return false;
  }

  function plan(value, options) {
    if (value === null || value === undefined) return [];
    const opts = options && typeof options === 'object' ? options : {};
    const text = String(value).replace(/\r\n?/g, '\n').replace(/[\t\v\f \u00a0\u3000]+/g, ' ').replace(/\n[ ]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (!text) return [];
    const lang = typeof opts.lang === 'string' && opts.lang ? opts.lang : 'ja-JP';
    const mode = opts.mode === 'careful' ? 'careful' : 'natural';
    const requested = Number(opts.maxLength);
    const maxLength = Number.isFinite(requested) && requested > 0 ? Math.max(8, Math.min(2000, Math.floor(requested))) : 180;
    const pauses = PAUSES[mode], protectedSpans = protectedRanges(text);
    const graphemes = segmenter(lang, 'grapheme');
    const safeGraphemeEnds = graphemes ? new Set([0, ...Array.from(graphemes.segment(text), s => s.index + s.segment.length)]) : null;
    const isSafe = pos => {
      if (pos <= 0 || pos > text.length) return false;
      if (safeGraphemeEnds && !safeGraphemeEnds.has(pos)) return false;
      // Even without Segmenter, never cut a UTF-16 surrogate pair.
      if (pos < text.length && /[\uD800-\uDBFF]/.test(text[pos - 1]) && /[\uDC00-\uDFFF]/.test(text[pos])) return false;
      return !protectedSpans.some(([start, end]) => start < pos && pos < end);
    };
    const wordEnds = new Set(), marks = new Map(), hard = new Map();
    function mark(map, pos, type) {
      if (!isSafe(pos)) return;
      const previous = map.get(pos);
      if (!previous || RANK[type] > RANK[previous]) map.set(pos, type);
    }
    const words = segmenter(lang, 'word');
    if (words) {
      for (const part of words.segment(text)) {
        const end = part.index + part.segment.length;
        if (isSafe(end)) wordEnds.add(end);
      }
    } else {
      // No guessed character-level word boundaries in a browser without ICU
      // segmentation. Unbroken long words may remain longer than the target.
      for (const m of text.matchAll(/\s+|[、，,;；:：。！？!?]+[」』”’）)\]】]*/gu)) {
        const end = m.index + m[0].length;
        if (isSafe(end)) wordEnds.add(end);
      }
    }
    for (const [start, end] of protectedSpans) {
      if (isSafe(start)) wordEnds.add(start);
      if (isSafe(end)) wordEnds.add(end);
    }
    wordEnds.add(text.length);
    for (const m of text.matchAll(/[、，,;；:：]+[」』”’）)\]】]*/gu)) mark(marks, m.index + m[0].length, 'clause');
    for (const m of text.matchAll(/\n+/g)) {
      const pos = m.index + m[0].length;
      mark(marks, pos, m[0].length > 1 ? 'paragraph' : 'line');
      if (m[0].length > 1) mark(hard, pos, 'paragraph');
    }
    const lines = [], linePattern = /[^\n]*(?:\n|$)/g;
    let match;
    while ((match = linePattern.exec(text)) && match[0]) {
      lines.push({ text: match[0].replace(/\n$/, ''), end: match.index + match[0].length });
    }
    for (let i = 0; i < lines.length - 1; i++) {
      if (isHeading(lines[i].text) && !isHeading(lines[i + 1].text)) mark(hard, lines[i].end, 'heading');
    }
    const sentences = segmenter(lang, 'sentence');
    if (sentences) {
      for (const part of sentences.segment(text)) {
        const ending = part.segment.trim();
        // ICU can classify an isolated item number or a soft newline as a
        // sentence. Only punctuation closes a spoken sentence; headings and
        // blank-line paragraphs are handled separately above.
        if (!/[。.!?！？][」』”’）)\]】]*$/u.test(ending)) continue;
        if (/\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|vs|etc|e\.g|i\.e)\.$/iu.test(ending)) continue;
        mark(hard, part.index + part.segment.length, 'sentence');
      }
    } else {
      for (const m of text.matchAll(/[。！？!?]+[」』”’）)\]】]*|\.(?=\s+[A-Z]|$)/gu)) mark(hard, m.index + m[0].length, 'sentence');
    }
    mark(hard, text.length, 'sentence');
    const allEnds = Array.from(wordEnds).sort((a, b) => a - b);
    const result = [];
    function emit(start, end, type) {
      const spoken = text.slice(start, end).replace(/\s+/gu, ' ').trim();
      const pauseAfter = Math.min(900, Math.max(0, Math.round(pauses[type] || pauses.continuation)));
      if (spoken) result.push({ text: spoken, pauseAfter });
      else if (result.length) result[result.length - 1].pauseAfter = Math.max(result[result.length - 1].pauseAfter, pauseAfter);
    }
    let unitStart = 0, boundaryIndex = 0;
    for (const [unitEnd, ending] of Array.from(hard).sort((a, b) => a[0] - b[0])) {
      let cursor = unitStart;
      while (unitEnd - cursor > maxLength) {
        const target = cursor + maxLength;
        const minimum = cursor + Math.floor(maxLength * 0.45);
        // Advance through the sorted boundaries instead of rescanning the whole
        // document for every chunk. Only the current target window is inspected.
        while (boundaryIndex < allEnds.length && allEnds[boundaryIndex] <= cursor) boundaryIndex++;
        let cut = 0, preferred = 0;
        for (let i = boundaryIndex; i < allEnds.length && allEnds[i] <= target && allEnds[i] < unitEnd; i++) {
          cut = allEnds[i];
          if (cut >= minimum && marks.has(cut)) preferred = cut;
        }
        if (preferred) cut = preferred;
        if (!cut) cut = boundaryIndex < allEnds.length && allEnds[boundaryIndex] <= unitEnd ? allEnds[boundaryIndex] : unitEnd;
        // A long indivisible reference/word is emitted intact, even past target.
        const type = cut === unitEnd ? ending : (marks.get(cut) || 'continuation');
        emit(cursor, cut, type);
        cursor = cut;
      }
      if (cursor < unitEnd) emit(cursor, unitEnd, ending);
      unitStart = unitEnd;
    }
    if (result.length) result[result.length - 1].pauseAfter = 0;
    return result;
  }

  root.LegalProsody = Object.freeze({ version: '2026-11-25.1', plan });
})(typeof window !== 'undefined' ? window : typeof self !== 'undefined' ? self : globalThis);
