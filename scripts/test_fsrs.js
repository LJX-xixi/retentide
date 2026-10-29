// node scripts/test_fsrs.js — checks the scheduler and auto-grading rules in app.js
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const src = fs.readFileSync(__dirname + '/../app.js', 'utf8');
const core = src.slice(0, src.indexOf('// ---------- app state'));
const ctx = { Math, Date, console, L: (zh) => zh, window: { LANG: "zh" } };
vm.createContext(ctx);
vm.runInContext(core + ';this.api={fsrsReview,levelOf,dayStart,DAY};', ctx);
const { fsrsReview, levelOf, dayStart, DAY } = ctx.api;
const t0 = new Date('2026-10-17T10:00:00').getTime();
const days = (c, now) => Math.round((c.due - dayStart(now)) / DAY);

// first answers
let good = fsrsReview({}, 3, t0), again = fsrsReview({}, 1, t0), easy = fsrsReview({}, 4, t0), hard = fsrsReview({}, 2, t0);
console.log('first: again', days(again, t0), 'hard', days(hard, t0), 'good', days(good, t0), 'easy', days(easy, t0));
assert(days(again, t0) === 1 && days(good, t0) === 3 && days(easy, t0) >= 14);
assert(levelOf(again) === 2 && levelOf(good) === 2);

// a run of Good answers on time should grow intervals and climb the ladder
let c = good, now = t0; const ivls = [];
for (let i = 0; i < 6; i++) { now = c.due + 3600e3 * 6; c = fsrsReview(c, 3, now); ivls.push(days(c, now)); }
console.log('good streak intervals', ivls, 'levels', levelOf(c));
for (let i = 1; i < ivls.length; i++) assert(ivls[i] >= ivls[i - 1]);
assert(levelOf(c) === 4);

// lapse after maturity drops stability, counts a lapse, goes to relearning
const lapsed = fsrsReview(c, 1, c.due + DAY);
console.log('lapse: s', c.s.toFixed(1), '->', lapsed.s.toFixed(1), 'st', lapsed.st, 'lapses', lapsed.lapses);
assert(lapsed.s < c.s && lapsed.st === 3 && lapsed.lapses === 1 && days(lapsed, c.due + DAY) === 1);

// prior difficulty: same answer, harder word -> higher D -> slower growth
const easyW = fsrsReview({}, 3, t0, 0.1), hardW = fsrsReview({}, 3, t0, 0.95);
console.log('prior: D easy word', easyW.d.toFixed(2), 'hard word', hardW.d.toFixed(2));
assert(hardW.d > easyW.d);
let e1 = easyW, h1 = hardW, tt = t0;
for (let i = 0; i < 3; i++) { tt = Math.max(e1.due, h1.due) + DAY; e1 = fsrsReview(e1, 3, tt, 0.1); h1 = fsrsReview(h1, 3, tt, 0.95); }
console.log('after 3 Good: S easy', e1.s.toFixed(1), 'hard', h1.s.toFixed(1));
assert(e1.s > h1.s);

// grading
const ratingSrc = src.slice(src.indexOf('// ---------- answer timing'), src.indexOf('// ---------- question building'));
const ctx2 = { Math, console, S: { L: { times: { mc: [4000, 4200, 3900], cloze: [], type: [] } } }, median: (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; }, window: { addEventListener() {} } };
vm.createContext(ctx2);
vm.runInContext(ratingSrc + ';this.rate=rate;', ctx2);
const r = ctx2.rate;
assert.strictEqual(r({ ok: false, ms: 1000, kind: 'mc', type: 'mc_en2zh', lv: 2 }), 1);
assert.strictEqual(r({ ok: true, ms: 9000, kind: 'mc', type: 'mc_en2zh', lv: 2 }), 2);   // slow
assert.strictEqual(r({ ok: true, ms: 4000, kind: 'mc', type: 'mc_en2zh', lv: 2 }), 3);   // normal
assert.strictEqual(r({ ok: true, ms: 1500, kind: 'mc', type: 'mc_en2zh', lv: 2 }), 3);   // fast recognition: never Easy
assert.strictEqual(r({ ok: true, ms: 1500, kind: 'mc', type: 'mc_zh2en', lv: 3 }), 3);   // fast four-choice reverse: never Easy
assert.strictEqual(r({ ok: true, ms: 2000, kind: 'cloze', type: 'cloze_book', lv: 3 }), 4); // fast context item at level 3
assert.strictEqual(r({ ok: true, ms: 2000, kind: 'cloze', type: 'cloze_book', lv: 2 }), 3);
assert.strictEqual(r({ ok: true, ms: 40000, kind: 'type', type: 'type_meaning', lv: 4 }), 3); // typed answers are not timed
assert.strictEqual(r({ ok: true, ms: 1500, kind: 'mc', type: 'mc_zh2en', lv: 3, known: true }), 4); // "I knew it" check
console.log('all scheduler and grading checks passed');
