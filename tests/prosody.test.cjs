#!/usr/bin/env node
/* Reusable, read-only LegalProsody checks.
 * node prosody.test.cjs --dist /path/to/published/files --report report.json
 * Can be placed in tests/: defaults to ../dist or the published repository root.
 * Benchmarks run in disposable workers with deadlines, not the UI thread.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const compact = value => String(value).replace(/\s/gu, '');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

function load(dist, withSpeech = true, fallback = false) {
  const context = { Intl: fallback ? {} : Intl };
  context.window = context;
  context.self = context;
  vm.createContext(context);
  if (withSpeech) vm.runInContext(fs.readFileSync(path.join(dist, 'speech-engine.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(dist, 'prosody-engine.js'), 'utf8'), context);
  return context;
}

function verify(text, chunks, required = []) {
  assert.equal(compact(chunks.map(p => p.text).join('')), compact(text), 'Non-whitespace source characters changed');
  for (const part of chunks) {
    assert(part.text.length > 0, 'Empty chunk');
    assert(Number.isInteger(part.pauseAfter) && part.pauseAfter >= 0 && part.pauseAfter <= 900, 'Unbounded pause');
    assert(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(part.text), 'Broken UTF-16 surrogate pair');
  }
  if (chunks.length) assert.equal(chunks.at(-1).pauseAfter, 0, 'Final pause must be zero');
  for (const term of required) assert(chunks.some(p => compact(p.text).includes(compact(term))), 'Split protected phrase: ' + term);
}

if (!isMainThread) {
  try {
    const context = load(workerData.dist, false);
    const start = performance.now();
    const chunks = context.LegalProsody.plan(workerData.text, { lang: workerData.lang, maxLength: 180 });
    const durationMs = performance.now() - start;
    verify(workerData.text, chunks);
    parentPort.postMessage({ ok: true, durationMs: +durationMs.toFixed(3), chunkCount: chunks.length,
      maxChunkLength: Math.max(0, ...chunks.map(p => p.text.length)),
      overTargetCount: chunks.filter(p => p.text.length > 180).length,
      planSha256: hash(JSON.stringify(chunks)), charactersPreserved: true });
  } catch (error) { parentPort.postMessage({ ok: false, error: error.stack || String(error) }); }
} else {
  main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
}

async function main() {
  const argv = process.argv.slice(2);
  const arg = (flag, fallback) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : fallback; };
  if (argv.includes('--help')) {
    console.log('Usage: node prosody.test.cjs [--dist PATH] [--report FILE] [--label NAME] [--compare REPORT] [--timeout-ms 8000] [--stress-repeat 12]');
    return;
  }
  const defaults = [path.resolve(__dirname, '../dist'), path.resolve(__dirname, '..'), path.resolve(process.cwd(), 'dist'), process.cwd()];
  const inferred = defaults.find(p => fs.existsSync(path.join(p, 'prosody-engine.js')));
  const dist = path.resolve(arg('--dist', inferred || '.'));
  if (!fs.existsSync(path.join(dist, 'prosody-engine.js'))) throw new Error('Use --dist to specify the directory containing prosody-engine.js');
  const reportPath = arg('--report', null);
  const timeoutMs = Math.max(1000, Number(arg('--timeout-ms', '8000')) || 8000);
  const stressRepeat = Math.max(2, Math.min(30, Number(arg('--stress-repeat', '12')) || 12));
  const context = load(dist), plan = context.LegalProsody.plan, tests = [];
  const test = (name, run) => {
    try { run(); tests.push({ name, ok: true }); }
    catch (error) { tests.push({ name, ok: false, error: error.stack || String(error) }); }
  };
  const checked = (text, opts = {}, required = []) => { const result = plan(text, opts); verify(text, result, required); return result; };
  test('empty, whitespace, null and undefined', () => { for (const value of ['', '  \n ', null, undefined]) assert.equal(plan(value).length, 0); });
  const ordinary = 'この法律は、発明の保護及び利用を図ることにより、産業の発達に寄与することを目的とする。';
  test('ordinary sentence remains one utterance', () => assert.equal(checked(ordinary).length, 1));
  test('raw Arabic, full-width and kanji article references', () => checked('適用については、第１２３条の２第４項第５号及び第百二十三条の二第三項第一号の要件を確認する。', { maxLength: 24 }, ['第１２３条の２第４項第５号', '第百二十三条の二第三項第一号']));
  test('prepared kana article references', () => checked('このばあい、だいにじゅうきゅうじょうのにだいさんこうだいいちごうのようけんをかくにんします。', { maxLength: 16 }, ['だいにじゅうきゅうじょうのにだいさんこうだいいちごう']));
  const long = ('特許を受ける権利を有する者は、その発明を実施する場合において、法律に定める要件及び例外を確認し、必要な手続を行うものとするが、').repeat(15) + '詳細は第29条第1項第3号に定める。';
  test('long legal sentence and clause pauses', () => { const result = checked(long, { maxLength: 180 }, ['第29条第1項第3号']); assert(result.length > 1); assert(result.some(p => p.pauseAfter === 120)); });
  const english = 'Under Article 12(1)(a), the applicant must submit an international application. This provision does not require a payment of 10,000.50 dollars.';
  test('English legal references and decimal values', () => checked(english, { lang: 'en-US', maxLength: 35 }, ['Article 12(1)(a)', '10,000.50']));
  const labels = '（目的）\n第一条\nこの法律は発明を保護する。\n\n（定義）\n第二条\n一\n自然法則を利用した技術的思想の創作をいう。\n二\n特許発明とは特許を受けている発明をいう。';
  test('headings merge, item labels stay with content', () => { const result = checked(labels); assert(!result.some(p => /^[一二]$/.test(p.text))); assert(result.some(p => p.text === '（目的） 第一条' && p.pauseAfter === 300)); assert(result.some(p => p.pauseAfter === 400)); });
  test('careful mode lengthens pauses without changing chunks', () => { const a = checked(labels), b = checked(labels, { mode: 'careful' }); assert.equal(a.length, b.length); assert(b.every((p, i) => p.text === a[i].text && p.pauseAfter >= a[i].pauseAfter)); assert(b.some(p => p.pauseAfter === 650)); });
  const emoji = '発明者👩‍🔬は工具🛠️と地球🌏の仕組みを研究し、家族👨‍👩‍👧‍👦と結果を確認した。';
  test('surrogate pairs, variation selectors and ZWJ sequences', () => checked(emoji, { maxLength: 12 }, ['👩‍🔬', '🛠️', '🌏', '👨‍👩‍👧‍👦']));
  test('a long English word remains indivisible', () => checked('The word internationalization remains a single indivisible word alongside patentability.', { lang: 'en', maxLength: 18 }, ['internationalization', 'patentability']));
  test('English soft line wraps do not become sentences', () => assert.equal(checked('This is a\nwrapped sentence with international cooperation.', { lang: 'en' }).length, 1));
  test('English abbreviation does not create a tiny utterance', () => assert.equal(checked('Dr. Smith considers the evidence.', { lang: 'en' }).length, 1));
  test('punctuation, quotes, CRLF and numeric signs retained', () => checked('「第２条を確認する。」\r\n\r\n価格は1,234.50円、率は3.5％。\n\n次へ！', { maxLength: 18 }, ['1,234.50', '3.5％']));
  test('invalid optional values have useful defaults', () => assert.equal(checked(ordinary, { maxLength: NaN, lang: '!!!', mode: 'other' }).length, 1));
  test('fallback without Intl.Segmenter retains text and references', () => { const fallback = load(dist, false, true); const result = fallback.LegalProsody.plan(emoji + '\n\n' + english, { lang: 'en', maxLength: 20 }); verify(emoji + '\n\n' + english, result, ['Article 12(1)(a)', '👨‍👩‍👧‍👦']); });
  test('self-only global and no generated SSML', () => { const s = { Intl }; s.self = s; vm.runInNewContext(fs.readFileSync(path.join(dist, 'prosody-engine.js'), 'utf8'), s); const result = s.LegalProsody.plan(ordinary); verify(ordinary, result); assert(!result.some(p => /<\/?(?:speak|break|prosody)\b/.test(p.text))); });

  // Rank prepared text, not raw character length. Include articles, auxiliary
  // provisions, treaty pages, dictionary definitions and authored learning data.
  const largest = []; let scannedUnits = 0, regressionSamples = 0;
  const scanStart = performance.now();
  function consider(id, title, source, lang = 'ja-JP') {
    if (typeof source !== 'string' || !source.trim()) return;
    const prepared = lang.startsWith('en') ? source : context.LegalSpeech.prepare(source);
    scannedUnits++;
    const entry = { id, title, text: prepared, lang, preparedLength: prepared.length, sourceLength: source.length };
    if (largest.length < 5 || entry.preparedLength > largest.at(-1).preparedLength) {
      largest.push(entry); largest.sort((a, b) => b.preparedLength - a.preparedLength); largest.length = Math.min(largest.length, 5);
    }
  }
  for (const [folder, collection] of [['law-corpus', 'laws'], ['treaty-corpus', 'treaties']]) {
    const manifest = JSON.parse(fs.readFileSync(path.join(dist, folder, 'manifest.json'), 'utf8'));
    for (const meta of manifest[collection]) {
      const document = JSON.parse(fs.readFileSync(path.join(dist, folder, collection === 'laws' ? meta.file : meta.textFile), 'utf8'));
      const lang = document.language === 'en' ? 'en-US' : 'ja-JP';
      for (const [type, list] of [['articles', document.articles || []], ['appendices', document.appendices || []]]) {
        for (let i = 0; i < list.length; i++) {
          const section = list[i];
          consider(folder + '/' + document.id + '/' + (section.id || type + '-' + i), document.title + ' ' + (section.title || ''), section.speechText || section.text, lang);
        }
      }
      if (collection === 'laws') {
        const sample = document.articles.filter(a => a.section === '本則').slice(0, 4);
        sample.push(document.articles.reduce((a, b) => a.text.length > b.text.length ? a : b));
        for (const section of sample) { checked(context.LegalSpeech.prepare(section.speechText || section.text)); regressionSamples++; }
      }
    }
  }
  const glossary = JSON.parse(fs.readFileSync(path.join(dist, 'glossary-data.json'), 'utf8'));
  for (const entry of glossary.entries) for (let i = 0; i < (entry.definitions || []).length; i++) consider('glossary/' + entry.term + '/' + i, entry.term, entry.definitions[i].text);
  const authored = { window: {} }; authored.window = authored;
  vm.createContext(authored);
  for (const file of ['question-bank.js', 'legal-guides.js', 'written-oral.js', 'glossary-study.js']) {
    const filename = path.join(dist, file);
    if (fs.existsSync(filename)) vm.runInContext(fs.readFileSync(filename, 'utf8'), authored, { timeout: 2000 });
  }
  const seen = new Set();
  function visit(value, key) {
    if (typeof value === 'string') { if (!/^https?:/.test(value)) consider('learning/' + key, key, value); return; }
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    for (const [child, item] of Object.entries(value)) visit(item, key + '/' + child);
  }
  for (const [key, value] of Object.entries(authored)) if (key !== 'window') visit(value, key);
  const scanDurationMs = performance.now() - scanStart;
  const jobs = [...largest];
  jobs.push({ id: 'synthetic/repeated-largest', title: 'Stress: largest prepared unit repeated ' + stressRepeat + ' times',
    text: (largest[0].text + ' ').repeat(stressRepeat), lang: largest[0].lang, synthetic: true });
  const benchmarks = [];
  for (const job of jobs) {
    const result = await benchmark(job, timeoutMs, dist);
    const row = { id: job.id, title: job.title, preparedLength: job.text.length, synthetic: !!job.synthetic, ...result };
    benchmarks.push(row);
    console.log(JSON.stringify({ benchmark: row.id, chars: row.preparedLength, ms: row.durationMs, chunks: row.chunkCount, timedOut: !!row.timedOut, ok: row.ok }));
  }
  let comparison = null;
  const comparePath = arg('--compare', null);
  if (comparePath) {
    const previous = JSON.parse(fs.readFileSync(comparePath, 'utf8'));
    comparison = benchmarks.map(row => {
      const old = previous.benchmarks.find(x => x.id === row.id && x.preparedLength === row.preparedLength);
      return { id: row.id, samePlan: old?.planSha256 && row.planSha256 ? old.planSha256 === row.planSha256 : null,
        previousMs: old?.durationMs, currentMs: row.durationMs,
        ratio: old?.durationMs && row.durationMs ? +(row.durationMs / old.durationMs).toFixed(3) : null };
    });
    assert(comparison.every(row => row.samePlan !== false), 'Optimization changed the generated utterance plan');
  }
  const report = { label: arg('--label', 'verification'), verifiedAt: new Date().toISOString(), dist,
    engineSha256: hash(fs.readFileSync(path.join(dist, 'prosody-engine.js'))), versions: { node: process.version, v8: process.versions.v8, icu: process.versions.icu },
    tests, passed: tests.filter(x => x.ok).length, failed: tests.filter(x => !x.ok).length,
    corpusRegressionSamples: regressionSamples, scannedPreparedUnits: scannedUnits, scanAndRegressionMs: +scanDurationMs.toFixed(3),
    benchmarkTimeoutMs: timeoutMs, benchmarks, comparison,
    limitation: 'Benchmarks cover planning on this Node/ICU environment. Browser speed, voice output and perceived intonation are not measured.' };
  if (reportPath) { fs.mkdirSync(path.dirname(path.resolve(reportPath)), { recursive: true }); fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n'); }
  console.log(JSON.stringify({ passed: report.passed, failed: report.failed, regressionSamples, scannedPreparedUnits: scannedUnits, benchmarkFailures: benchmarks.filter(x => !x.ok).length, report: reportPath }));
  if (report.failed || benchmarks.some(x => !x.ok)) process.exitCode = 1;
}

function benchmark(job, timeoutMs, dist) {
  return new Promise(resolve => {
    const worker = new Worker(__filename, { workerData: { dist, text: job.text, lang: job.lang } });
    let done = false;
    const finish = value => { if (done) return; done = true; clearTimeout(timer); resolve(value); };
    const timer = setTimeout(() => { finish({ ok: false, timedOut: true, timeoutMs }); worker.terminate(); }, timeoutMs);
    worker.on('message', result => finish(result));
    worker.on('error', error => finish({ ok: false, error: error.stack || String(error) }));
    worker.on('exit', code => { if (!done) finish({ ok: false, error: 'Worker exited before returning a result: ' + code }); });
  });
}
