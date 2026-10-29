'use strict';
/* 填空实战 — AI 助教-written text completion (1–3 blanks) and sentence equivalence items.
   The answer to each item is a word the student has learned; wrong options are words at a similar level,
   some deliberately not learned yet, so the practice is eliminating among unfamiliar words.
   Every item carries an answer key, clue words, an explanation and a trap note per wrong option.
   Scoring: each learned answer word is graded on its own blank (a context question); distractors
   are not graded, but wrong picks are logged for the mistake diagnosis. A conversation can be
   opened about an item — before submitting AI 助教 only hints, afterwards it reviews the
   student's reasoning against the key; asking for hints caps that item's grades at Hard. */

const PR_FORMATS = { tc1: L('单空', 'One blank'), tc2: L('双空', 'Two blanks'), tc3: L('三空', 'Three blanks'), se: L('六选二', 'Sentence equivalence') };
const PR_BATCH = 3;
// pacing per item (the teacher's advice for the exercise set): one blank / SE 50 s, two 60 s, three 90 s
const PR_TIME = { tc1: 50, se: 50, tc2: 60, tc3: 90 };

// ---------- 习题集: a question set the learner imports (Settings → 题集; format in data/schema.md) ----------
const DRILLS_KEY = 'ovd-drills';
const hasDrills = () => { try { return !!localStorage.getItem(DRILLS_KEY); } catch (e) { return false; } };
async function loadDrills() {
  if (S.drills) return S.drills;
  let d = null;
  try { d = JSON.parse(localStorage.getItem(DRILLS_KEY) || 'null'); } catch (e) { d = null; }
  if (!d?.items?.length) throw new Error('no_drills');
  S.drills = { ...d, byId: new Map(d.items.map((x) => [x.id, x])) };
  return S.drills;
}
const drillRec = (id) => S.L.drill?.[id];
// records from before first attempts were kept separately had only one attempt, so latest = first
const firstOk = (r) => ((r.f ?? r.ok) ? 1 : 0);
function drillStats() {
  const D = S.drills;
  const secs = [...new Set(D.items.map((x) => x.sec))].sort((a, b) => a - b);
  const left = (sec) => D.items.filter((x) => x.sec === sec && !drillRec(x.id)).length;
  return {
    secs, next: secs.find((sec) => left(sec) > 0) ?? null,
    wrong: D.items.filter((x) => drillRec(x.id) && !drillRec(x.id).ok),
    done: D.items.filter((x) => drillRec(x.id)).length, total: D.items.length,
  };
}
function startDrill(items, label, exam = false) {
  if (!items.length) { toast(L('没有可做的题', 'No questions to do')); return; }
  const sid = dayKey() + '-x' + rid();
  S.L.sessions[sid] = { sid, date: dayKey(), start: Date.now(), kind: 'drill', label, items: [] };
  S.practice = { sid, drill: true, exam, view: 'q', label, order: items.map((x) => x.type), targets: [], idx: 0, loading: null, done: 0, blanksRight: 0, blanksAll: 0, itemsRight: 0,
    items: items.map((x) => ({ ...x, src: 'drill', clues: '', traps: {}, target: null, picks: x.type === 'se' ? [] : x.blanks.map(() => null) })) };
  const d = S.L.examDraft;
  if (exam && d?.label === label) {
    for (const it of S.practice.items) { const r = d.items?.[it.id]; if (r) { it.picks = [...r.picks]; it.flag = r.flag; it.tms = r.tms || 0; } }
    toast(L('接着上次没交卷的作答', 'Picking up your unsubmitted answers from last time'));
  }
  $('#tabs').hidden = true;
  paintPractice();
}

// ---------- 同义词配对: tap a word, then its synonym; a quick game for odd minutes ----------
// Pairs come from learned words first (topped up with unlearned bank words), each with one of its own
// synonyms; no tile may fit two pairs. Nothing is graded: it's practice, not a review.
function synMatchPairs(n) {
  const has = (w) => synOptions(w).length;
  const pool = [...shuffle(S.words.filter((w) => S.L.cards[w.id]?.st && has(w))), ...shuffle(S.words.filter((w) => !S.L.cards[w.id]?.st && has(w) && (w.df ?? 0.5) >= 0.4))];
  const out = [], used = new Set();
  for (const w of pool) {
    if (out.length >= n) break;
    const key = w.w.toLowerCase(), syn = pick(synOptions(w));
    if (used.has(key) || used.has(syn)) continue;
    if (out.some((p) => synOptions(S.byId.get(p.id)).includes(syn) || synOptions(w).includes(p.syn) || p.syn === key || syn === p.w.toLowerCase())) continue;
    out.push({ id: w.id, w: w.w, syn }); used.add(key); used.add(syn);
  }
  return out;
}
function startSynMatch(n = 8) {
  const pairs = synMatchPairs(n);
  if (pairs.length < 4) { toast(L('有同义词的词还不够，先背一些再来', 'Not enough words with synonyms yet — learn some more first')); return; }
  const tiles = shuffle(pairs.flatMap((p, i) => [{ k: i, t: p.w, side: 'w' }, { k: i, t: p.syn, side: 's' }]));
  S.game = { pairs, tiles, sel: null, done: new Set(), miss: 0, start: Date.now(), bad: null };
  $('#tabs').hidden = true;
  markView();
  paintSynMatch();
}
function paintSynMatch() {
  const G = S.game;
  if (!G) return;
  const finished = G.done.size === G.pairs.length;
  const secs = Math.round(((G.end || Date.now()) - G.start) / 1000);
  const top = `<div class="sess-top"><button class="x" id="gmexit" aria-label="${L('退出', 'Exit')}">×</button><div class="prog"><span style="width:${(G.done.size / G.pairs.length * 100).toFixed(1)}%"></span></div><span class="muted small num" id="gmclock">${mmss(secs)}</span></div>`;
  if (finished) {
    if (!G.end) { G.end = Date.now(); markView(); clearInterval(S.gameClock); }
    app().innerHTML = `${top}
    <div class="card ruled today">
      <div class="today-head"><b>${L('同义词配对 · 完成', 'Synonym match · done')}</b><span class="muted small">${L(`${G.pairs.length} 对`, `${G.pairs.length} pairs`)}</span></div>
      <div class="counts">
        <div class="count"><div class="n">${mmss(Math.round((G.end - G.start) / 1000))}</div><div class="l">${L('用时', 'Time')}</div></div>
        <div class="count"><div class="n">${G.miss}</div><div class="l">${L('配错次数', 'Mismatches')}</div></div>
        <div class="count"><div class="n">${G.pairs.filter((p) => S.L.cards[p.id]?.st).length}/${G.pairs.length}</div><div class="l">${L('学过的词', 'Learned words')}</div></div>
      </div>
      <div class="list">${G.pairs.map((p) => `<button class="item" data-word="${esc(p.id)}"><div><div class="t">${esc(p.w)} ≈ ${esc(p.syn)}</div><div class="s">${esc(zhGloss(senseFor(S.byId.get(p.id))))}</div></div>${cardChip(S.L.cards[p.id])}</button>`).join('')}</div>
      <div class="row"><button class="btn primary" id="gmagain">${L('再来一局', 'Play again')}</button><button class="btn" id="gmback">${L('回到今日', 'Back to Today')}</button></div>
    </div>`;
    $('#gmexit').addEventListener('click', exitSynMatch);
    $('#gmback').addEventListener('click', exitSynMatch);
    $('#gmagain').addEventListener('click', () => startSynMatch(G.pairs.length));
    app().querySelectorAll('[data-word]').forEach((b) => b.addEventListener('click', () => openWord(b.dataset.word)));
    return;
  }
  app().innerHTML = `${top}
  <div class="muted small" style="margin-top:-12px">${L(`同义词配对 · 先点一个词，再点它的同义词 · 配错 ${G.miss} 次`, `Synonym match · tap a word, then its synonym · ${G.miss} mismatches`)}</div>
  <div class="gmgrid">${G.tiles.map((t, i) => `<button class="gmtile${G.done.has(t.k) ? ' done' : ''}${G.sel === i ? ' sel' : ''}${G.bad?.includes(i) ? ' bad' : ''}" data-t="${i}" ${G.done.has(t.k) ? 'disabled' : ''}>${esc(t.t)}</button>`).join('')}</div>`;
  $('#gmexit').addEventListener('click', exitSynMatch);
  app().querySelectorAll('[data-t]').forEach((b) => b.addEventListener('click', () => tapTile(+b.dataset.t)));
  clearInterval(S.gameClock);
  S.gameClock = setInterval(() => { const el = $('#gmclock'); if (!S.game || S.game.end || !el) { clearInterval(S.gameClock); return; } el.textContent = mmss(Math.round((Date.now() - S.game.start) / 1000)); }, 1000);
}
function tapTile(i) {
  const G = S.game;
  if (!G || G.done.has(G.tiles[i].k)) return;
  G.bad = null;
  if (G.sel == null) G.sel = i;
  else if (G.sel === i) G.sel = null;
  else {
    const a = G.tiles[G.sel], b = G.tiles[i];
    if (a.k === b.k && a.side !== b.side) G.done.add(a.k);
    else { G.miss++; G.bad = [G.sel, i]; setTimeout(() => { if (S.game === G && G.bad) { G.bad = null; paintSynMatch(); } }, 600); }
    G.sel = null;
  }
  paintSynMatch();
}
function exitSynMatch() {
  clearInterval(S.gameClock);
  S.game = null;
  render();
  markView();
}

// ---------- 整套: a section done like the exam, checked only when it's handed in ----------
// Move freely between questions, change answers, mark some for later; an overview before handing in.
// Time is counted per question while it's on screen; the set's total is shown against its reference
// and never cuts anything off. No hints and no lookups until it's handed in.
function examLeave() {
  const P = S.practice;
  if (P?.vis) { const it = P.items[P.vis.i]; if (it) it.tms = (it.tms || 0) + Date.now() - P.vis.t; P.vis = null; }
}
const examUsed = (P) => P.items.reduce((a, x) => a + (x.tms || 0), 0) + (P.vis ? Date.now() - P.vis.t : 0);
const examRef = (P) => P.items.reduce((a, x) => a + PR_TIME[x.type], 0) * 1000;
const answered = (it) => (it.type === 'se' ? it.picks.length === 2 : it.picks.every((p) => p != null));
function examTimerHtml(P) {
  const used = examUsed(P), ref = examRef(P);
  return `<span id="extimer" class="num small ${used > ref ? 'over' : 'muted'}">${mmss(used / 1000)} / ${mmss(ref / 1000)}</span>`;
}
function startExamClock() {
  clearInterval(S.examClock);
  S.examClock = setInterval(() => {
    const P = S.practice, el = $('#extimer');
    if (!P?.exam || P.graded || !el) { clearInterval(S.examClock); return; }
    el.outerHTML = examTimerHtml(P);
  }, 1000);
}
function saveExamDraft() {
  const P = S.practice;
  if (!P?.exam || P.graded) return;
  examLeave();
  S.L.examDraft = { label: P.label, at: Date.now(), items: Object.fromEntries(P.items.map((it) => [it.id, { picks: [...it.picks], flag: !!it.flag, tms: it.tms || 0 }])) };
  saveLocal(true);
}
function paintExam() {
  const P = S.practice;
  const total = P.items.length;
  if (P.view === 'overview') return paintExamOverview();
  const it = P.items[P.idx];
  examLeave(); P.vis = { i: P.idx, t: Date.now() };
  const vk = `exam|${P.idx}`;
  if (vk !== P.vk) { P.vk = vk; markView(); }
  app().innerHTML = `<div class="sess-top"><button class="x" id="prexit" aria-label="${L('退出', 'Exit')}">×</button><div class="prog"><span style="width:${(P.items.filter(answered).length / total * 100).toFixed(1)}%"></span></div>${examTimerHtml(P)}</div>
  <div class="muted small" style="margin-top:-12px">${L('习题集', 'Question set')} · ${esc(P.label)} · ${L('整套做完再对答案 · 计时只做参考', 'answers are checked after the whole set · timing is just a guide')}</div>
  <div class="card ruled q">
    <div class="q-meta"><span>${L(`第 ${P.idx + 1}/${total} 题`, `Question ${P.idx + 1}/${total}`)} · ${PR_FORMATS[it.type]}${it.type === 'se' ? L('：选两个', ': pick two') : it.blanks.length > 1 ? L('：每空选一个', ': pick one per blank') : ''}</span><span class="row" style="gap:6px">${it.flag ? `<span class="tag trap">${L('已标记', 'Marked')}</span>` : ''}<span class="tag">S${it.sec}-${it.n}</span></span></div>
    <div class="sent pr-text">${practiceText(it, false)}</div>
  </div>
  ${practiceOpts(it, false)}
  <div class="row exam-nav">
    <button class="btn" id="exprev" ${P.idx ? '' : 'disabled'}>${L('上一题', 'Previous')}</button>
    <button class="btn" id="exflag">${it.flag ? L('取消标记', 'Unmark') : L('标记', 'Mark')}</button>
    <button class="btn" id="exall">${L('总览', 'Overview')}</button>
    <button class="btn primary" id="exnext">${P.idx < total - 1 ? L('下一题', 'Next') : L('去总览交卷', 'Overview & submit')}</button>
  </div>`;
  $('#prexit').addEventListener('click', () => exitPractice());
  app().querySelectorAll('[data-se]').forEach((b) => b.addEventListener('click', () => { const k = +b.dataset.se; it.picks = it.picks.includes(k) ? it.picks.filter((x) => x !== k) : [...it.picks, k].slice(-2); paintExam(); }));
  app().querySelectorAll('[data-b]').forEach((b) => b.addEventListener('click', () => { const bi = +b.dataset.b, k = +b.dataset.k; it.picks[bi] = it.picks[bi] === k ? null : k; paintExam(); }));
  $('#exprev').addEventListener('click', () => { P.idx--; paintExam(); window.scrollTo(0, 0); });
  $('#exflag').addEventListener('click', () => { it.flag = !it.flag; paintExam(); });
  $('#exall').addEventListener('click', () => { P.view = 'overview'; paintExam(); });
  $('#exnext').addEventListener('click', () => { if (P.idx < total - 1) P.idx++; else P.view = 'overview'; paintExam(); window.scrollTo(0, 0); });
  startExamClock();
}
function paintExamOverview() {
  const P = S.practice;
  examLeave();
  if (P.vk !== 'exam|overview') { P.vk = 'exam|overview'; markView(); }
  const open = P.items.filter((x) => !answered(x)).length;
  const flagged = P.items.filter((x) => x.flag).length;
  app().innerHTML = `<div class="sess-top"><button class="x" id="prexit" aria-label="${L('退出', 'Exit')}">×</button><div class="prog"><span style="width:${((P.items.length - open) / P.items.length * 100).toFixed(1)}%"></span></div>${examTimerHtml(P)}</div>
  <div class="card ruled today">
    <div class="today-head"><b>${L('总览', 'Overview')} · ${esc(P.label)}</b><span class="muted small">${L(`已答 ${P.items.length - open}/${P.items.length}`, `Answered ${P.items.length - open}/${P.items.length}`)}${flagged ? L(` · 标记 ${flagged}`, ` · ${flagged} marked`) : ''}</span></div>
    <div class="list">${P.items.map((x, i) => `<button class="item" data-go="${i}"><div><div class="t">${i + 1}. ${PR_FORMATS[x.type]} ${x.flag ? `<span class="tag trap">${L('已标记', 'Marked')}</span>` : ''}</div><div class="s">${esc(x.text.replace(/\((i{1,3})\)_+/g, '____').slice(0, 50))}…</div></div><span class="${answered(x) ? 'verdict ok' : 'muted'} small">${answered(x) ? L('已答', 'Answered') : L('未答', 'Unanswered')}</span></button>`).join('')}</div>
    <div id="exconfirm"></div>
    <div class="row"><button class="btn primary" id="exsubmit">${L('交卷，对答案', 'Submit and check answers')}</button><button class="btn" id="exback">${L(`回到第 ${P.idx + 1} 题`, `Back to question ${P.idx + 1}`)}</button></div>
  </div>`;
  $('#prexit').addEventListener('click', () => exitPractice());
  app().querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => { P.idx = +b.dataset.go; P.view = 'q'; paintExam(); window.scrollTo(0, 0); }));
  $('#exback').addEventListener('click', () => { P.view = 'q'; paintExam(); });
  $('#exsubmit').addEventListener('click', () => {
    if (open && !P.confirming) {
      P.confirming = true;
      $('#exconfirm').innerHTML = `<div class="feedback small">${L(`还有 ${open} 题没答（没答按错算）。确定交卷？`, `${open} question(s) still unanswered (counted as wrong). Submit anyway?`)} <button class="btn sm" id="exsure">${L('确定交卷', 'Submit')}</button></div>`;
      $('#exsure').addEventListener('click', submitExam);
      return;
    }
    submitExam();
  });
  startExamClock();
}
function submitExam() {
  const P = S.practice;
  if (!P || P.graded) return;
  examLeave(); clearInterval(S.examClock);
  P.used = examUsed(P);
  for (const it of P.items) submitPractice(it, false, { silent: true, ms: it.tms || 0 });
  P.graded = true; P.view = 'results'; P.idx = 0;
  if (S.L.examDraft?.label === P.label) delete S.L.examDraft;
  saveLocal(true); push();
  paintPractice();
  window.scrollTo(0, 0);
}
function paintExamResults() {
  const P = S.practice;
  if (P.vk !== 'exam|results') { P.vk = 'exam|results'; markView(); }
  const next = S.drills ? drillStats().next : null;
  app().innerHTML = `<div class="sess-top"><button class="x" id="prexit" aria-label="${L('退出', 'Exit')}">×</button><div class="prog"><span style="width:100%"></span></div><span class="muted small num">${L('已交卷', 'Submitted')}</span></div>
  <div class="card ruled today">
    <div class="today-head"><b>${esc(P.label)} · ${L('成绩', 'Results')}</b><span class="muted small">${L('点一题看解析', 'Tap a question to see the explanation')}</span></div>
    <div class="counts">
      <div class="count"><div class="n">${P.itemsRight}/${P.items.length}</div><div class="l">${L('整题全对', 'Fully correct')}</div></div>
      <div class="count"><div class="n">${P.blanksAll ? Math.round(P.blanksRight / P.blanksAll * 100) : 0}%</div><div class="l">${L('空格正确率', 'Blank accuracy')}</div></div>
      <div class="count"><div class="n">${mmss(P.used / 1000)}</div><div class="l">${L(`用时（参考 ${mmss(examRef(P) / 1000)}）`, `Time (guide ${mmss(examRef(P) / 1000)})`)}</div></div>
    </div>
    <div class="list">${P.items.map((x, i) => { const ok = x.results?.every((r) => r.ok); return `<button class="item" data-rv="${i}"><div><div class="t">${i + 1}. ${PR_FORMATS[x.type]} ${x.flag ? `<span class="tag trap">${L('标记过', 'Marked')}</span>` : ''}</div><div class="s">${L(`${Math.round((x.tms || 0) / 1000)} 秒（参考 ${PR_TIME[x.type]} 秒）`, `${Math.round((x.tms || 0) / 1000)} s (guide ${PR_TIME[x.type]} s)`)}</div></div><span class="verdict ${ok ? 'ok' : 'bad'} small">${ok ? L('对', 'Right') : answered(x) ? L('错', 'Wrong') : L('没答', 'Skipped')}</span></button>`; }).join('')}</div>
    <div class="row">${next != null ? `<button class="btn primary" id="exnextsec">${L(`下一套：Section ${next}`, `Next set: Section ${next}`)}</button>` : ''}<button class="btn" id="prback">${L('回到习题集', 'Back to question set')}</button></div>
  </div>`;
  $('#prexit').addEventListener('click', () => exitPractice(true));
  $('#prback').addEventListener('click', () => exitPractice(true));
  app().querySelectorAll('[data-rv]').forEach((b) => b.addEventListener('click', () => { P.idx = +b.dataset.rv; P.view = 'item'; paintPractice(); window.scrollTo(0, 0); }));
  $('#exnextsec')?.addEventListener('click', () => { const all = S.drills.items.filter((x) => x.sec === next); const left = all.filter((x) => !drillRec(x.id)); startDrill(left.length ? left : all, `Section ${next}`, true); });
}
// ---------- 习题集 page: progress over the 100 sections, accuracy by type, daily work ----------
const mmss = (t) => `${Math.floor(t / 60)}:${String(Math.round(t) % 60).padStart(2, '0')}`;
function drillSummary() {
  const D = S.drills, recs = S.L.drill || {};
  const bySec = new Map();
  for (const x of D.items) { if (!bySec.has(x.sec)) bySec.set(x.sec, []); bySec.get(x.sec).push(x); }
  const types = Object.fromEntries(Object.keys(PR_FORMATS).map((k) => [k, { n: 0, ok: 0, ms: 0 }]));
  let done = 0, ok = 0, wrongFirst = 0, fixed = 0;
  const days = {};
  for (const x of D.items) {
    const r = recs[x.id]; if (!r) continue;
    done++;
    const f = firstOk(r);
    ok += f;
    if (!f) { wrongFirst++; if (r.ok) fixed++; }
    const t = types[x.type]; t.n++; t.ok += f; t.ms += r.fms ?? r.ms ?? 0;
    const d = dayKey(r.ft ?? r.t);
    (days[d] ||= { n: 0, ok: 0 }); days[d].n++; days[d].ok += f;
  }
  return { bySec, types, done, ok, wrongFirst, fixed, total: D.items.length, days };
}
function secState(items) {
  const rs = items.map((x) => drillRec(x.id)).filter(Boolean);
  const ms = rs.reduce((a, r) => a + (r.fms ?? r.ms ?? 0), 0) / 1000;
  return { done: rs.length, n: items.length, ok: rs.reduce((a, r) => a + firstOk(r), 0), wrong: items.filter((x) => drillRec(x.id) && !drillRec(x.id).ok), left: items.filter((x) => !drillRec(x.id)), ms, ref: items.reduce((a, x) => a + PR_TIME[x.type], 0) };
}
async function openDrillPage(sec = null) {
  S.sub = 'drill'; S.drillSec = sec;
  window.scrollTo(0, 0);
  if (!S.drills) {
    app().innerHTML = `${topBar()}<div class="empty"><span class="spin"></span> ${L('加载习题集', 'Loading question set')}</div>`;
    try { await loadDrills(); } catch (e) { app().innerHTML = `${topBar()}<div class="empty">${L('习题集没有加载出来，检查网络后再试。', 'The question set didn\'t load. Check your connection and try again.')}<br><button class="btn" id="drback">${L('回到今日', 'Back to Today')}</button></div>`; $('#drback').addEventListener('click', () => { S.sub = null; render(); }); return; }
  }
  if (S.sub === 'drill') renderDrill();
}
function renderDrill() {
  if (S.drillSec != null) return renderDrillSection(S.drillSec);
  const sm = drillSummary(), st = drillStats();
  const next = st.next;
  const nextSt = next != null ? secState(sm.bySec.get(next)) : null;
  const allSecs = st.secs;
  const cell = (sec) => {
    const items = sm.bySec.get(sec);
    if (!items) return `<div class="dcell gone" title="Section ${sec}${L('：原文档这一套没法可靠解析，未导入', ': this set couldn\'t be parsed reliably from the source and wasn\'t imported')}">${sec}</div>`;
    const c = secState(items);
    const cls = !c.done ? '' : c.done < c.n ? 'part' : 'done';
    const acc = c.done ? c.ok / c.done : 0;
    return `<button class="dcell ${cls}" data-sec="${sec}" style="--a:${(0.25 + acc * 0.75).toFixed(2)}" title="Section ${sec}${c.done ? L(`：做了 ${c.done}/${c.n}，首次全对 ${c.ok}`, `: ${c.done}/${c.n} done, ${c.ok} right first time`) : ''}"><b>${sec}</b>${c.done ? `<span>${c.ok}/${c.done}</span>` : ''}</button>`;
  };
  const days = Array.from({ length: 14 }, (_, i) => dayKey(Date.now() - (13 - i) * DAY));
  const maxN = Math.max(10, ...days.map((d) => sm.days[d]?.n || 0));
  app().innerHTML = `${topBar()}
  <div class="row" style="justify-content:space-between"><button class="link" id="drhome">‹ ${L('今日', 'Today')}</button><span class="muted small">${L('计时只做参考', 'Timing is just a guide')}</span></div>
  <section class="card ruled today">
    <div class="today-head"><b>${L('习题集', 'Question set')}</b><span class="muted small">${esc(S.drills?.name || L('题集', 'Question set'))} · ${L(`${sm.total} 题`, `${sm.total} questions`)}</span></div>
    <div class="counts">
      <div class="count"><div class="n">${sm.done}</div><div class="l">${L(`已做（共 ${sm.total}）`, `Done (of ${sm.total})`)}</div></div>
      <div class="count"><div class="n">${sm.done ? Math.round(sm.ok / sm.done * 100) : 0}%</div><div class="l">${L('首次全对率', 'First-try accuracy')}</div></div>
      <div class="count"><div class="n">${sm.fixed}<small>/${sm.wrongFirst}</small></div><div class="l">${L('错题已订正', 'Mistakes fixed')}</div></div>
    </div>
    ${next != null ? `<button class="btn primary" id="drnext">${S.L.examDraft?.label === `Section ${next}` ? L(`接着做 Section ${next}（上次没交卷）`, `Continue Section ${next} (not submitted last time)`) : nextSt.left.length < nextSt.n ? L(`接着做 Section ${next}（还剩 ${nextSt.left.length} 题）`, `Continue Section ${next} (${nextSt.left.length} left)`) : L(`开始 Section ${next}`, `Start Section ${next}`)}</button>
    <div class="muted small">${L(`这套 ${nextSt.left.length} 题，参考用时约 ${mmss(nextSt.left.reduce((a, x) => a + PR_TIME[x.type], 0))}；整套做完再对答案，可以前后翻、改答案、标记，建议一次做完。`, `${nextSt.left.length} questions, about ${mmss(nextSt.left.reduce((a, x) => a + PR_TIME[x.type], 0))} as a guide. Answers are checked after the whole set; you can move back and forth, change answers and mark questions. Best done in one sitting.`)}</div>` : `<div class="feedback">${L('全部做完了。', 'All done.')}</div>`}
    ${st.wrong.length ? `<button class="btn" id="drwrong">${L(`错题重做（${st.wrong.length} 题）`, `Redo mistakes (${st.wrong.length})`)}</button>` : ''}
  </section>
  <section class="sec">
    <div class="sec-head"><h2>${L(`${new Set(S.drills.items.map((x) => x.sec)).size} 套`, `${new Set(S.drills.items.map((x) => x.sec)).size} sets`)}</h2><span class="muted small">${L('颜色越深首次全对率越高 · 点一格看这套', 'Darker = higher first-try accuracy · tap a cell to open the set')}</span></div>
    <div class="dgrid">${allSecs.map(cell).join('')}</div>
  </section>
  <section class="sec">
    <h2>${L('按题型', 'By question type')}</h2>
    <div class="list">${Object.entries(sm.types).map(([k, t]) => `<div class="item"><div><div class="t">${PR_FORMATS[k]}</div><div class="s">${t.n ? L(`做了 ${t.n} 题 · 平均 ${Math.round(t.ms / t.n / 1000)} 秒（参考 ${PR_TIME[k]} 秒）`, `${t.n} done · avg ${Math.round(t.ms / t.n / 1000)} s (guide ${PR_TIME[k]} s)`) : L('还没做', 'Not started')}</div></div>${t.n ? `<span class="verdict ${t.ok / t.n >= 0.8 ? 'ok' : t.ok / t.n >= 0.6 ? 'mid' : 'bad'} small">${Math.round(t.ok / t.n * 100)}%</span>` : ''}</div>`).join('')}</div>
  </section>
  <section class="sec">
    <div class="sec-head"><h2>${L('最近两周', 'Last two weeks')}</h2><span class="muted small">${L('每天第一次做的题数', 'First attempts per day')}</span></div>
    <div class="acts">${days.map((d, i) => { const x = sm.days[d]; return `<div class="act${i === 13 ? ' now' : ''}" title="${d}: ${x ? L(`${x.n} 题，首次全对 ${Math.round(x.ok / x.n * 100)}%`, `${x.n} questions, ${Math.round(x.ok / x.n * 100)}% right first time`) : L('没做', 'none')}"><div class="b${x ? '' : ' zero'}" style="height:${Math.max(2, (x?.n || 0) / maxN * 64)}px"></div><div class="d">${+d.slice(8)}</div></div>`; }).join('')}</div>
  </section>`;
  $('#drhome').addEventListener('click', () => { S.sub = null; render(); });
  $('#drnext')?.addEventListener('click', () => { const all = sm.bySec.get(next); const left = all.filter((x) => !drillRec(x.id)); startDrill(left.length ? left : all, `Section ${next}`, true); });
  $('#drwrong')?.addEventListener('click', () => startDrill(st.wrong, L('错题重做', 'Redo mistakes')));
  app().querySelectorAll('[data-sec]').forEach((b) => b.addEventListener('click', () => { S.drillSec = +b.dataset.sec; renderDrill(); window.scrollTo(0, 0); }));
}
function renderDrillSection(sec) {
  const items = S.drills.items.filter((x) => x.sec === sec);
  const c = secState(items);
  app().innerHTML = `${topBar()}
  <div class="row"><button class="link" id="drup">‹ ${L('习题集', 'Question set')}</button></div>
  <section class="card ruled today">
    <div class="today-head"><b>Section ${sec}</b><span class="muted small">${L(`${items.length} 题 · 参考用时 ${mmss(c.ref)}`, `${items.length} questions · guide ${mmss(c.ref)}`)}</span></div>
    <div class="counts">
      <div class="count"><div class="n">${c.done}<small>/${c.n}</small></div><div class="l">${L('已做', 'Done')}</div></div>
      <div class="count"><div class="n">${c.ok}<small>/${c.done || 0}</small></div><div class="l">${L('首次全对', 'Right first time')}</div></div>
      <div class="count"><div class="n">${c.done ? mmss(c.ms) : '—'}</div><div class="l">${L('首次用时', 'First-try time')}</div></div>
    </div>
    <div class="row">
      ${c.left.length ? `<button class="btn primary" id="drgo">${c.left.length < c.n ? L(`接着做（还剩 ${c.left.length} 题）`, `Continue (${c.left.length} left)`) : L('做这一套', 'Do this set')}</button>` : ''}
      ${c.wrong.length ? `<button class="btn" id="drsecwrong">${L(`重做这套的错题（${c.wrong.length}）`, `Redo this set's mistakes (${c.wrong.length})`)}</button>` : ''}
      ${c.done ? `<button class="btn" id="drredo">${L('整套重做', 'Redo whole set')}</button>` : ''}
    </div>
    ${c.left.length ? `<div class="muted small">${L('建议一次做完；没做的题不显示答案。', 'Best done in one sitting; answers stay hidden for questions you haven\'t done.')}</div>` : ''}
  </section>
  <section class="sec"><div class="list">${items.map((x) => {
    const r = drillRec(x.id);
    const mark = !r ? `<span class="muted small">${L('未做', 'Not done')}</span>` : `<span class="verdict ${firstOk(r) ? 'ok' : r.ok ? 'mid' : 'bad'} small">${firstOk(r) ? L('对', 'Right') : r.ok ? L('已订正', 'Fixed') : L('错', 'Wrong')}</span>`;
    return `<button class="item" ${r ? `data-rev="${esc(x.id)}"` : 'disabled'}><div><div class="t">${x.n}. ${PR_FORMATS[x.type]}${r && r.n > 1 ? ` <span class="muted small">${L(`做过 ${r.n} 次`, `done ${r.n} times`)}</span>` : ''}</div><div class="s">${r ? L(`首次 ${Math.round((r.fms ?? r.ms) / 1000)} 秒（参考 ${PR_TIME[x.type]} 秒） · `, `first try ${Math.round((r.fms ?? r.ms) / 1000)} s (guide ${PR_TIME[x.type]} s) · `) : ''}${esc(x.text.replace(/\((i{1,3})\)_+/g, '____').slice(0, 60))}…</div></div>${mark}</button>`;
  }).join('')}</div></section>`;
  $('#drup').addEventListener('click', () => { S.drillSec = null; renderDrill(); window.scrollTo(0, 0); });
  $('#drgo')?.addEventListener('click', () => startDrill(c.left, `Section ${sec}`, true));
  $('#drsecwrong')?.addEventListener('click', () => startDrill(c.wrong, L(`Section ${sec} 错题`, `Section ${sec} mistakes`)));
  $('#drredo')?.addEventListener('click', () => startDrill(items, L(`Section ${sec} 重做`, `Section ${sec} redo`), true));
  app().querySelectorAll('[data-rev]').forEach((b) => b.addEventListener('click', () => openDrillReview(S.drills.byId.get(b.dataset.rev))));
}
// look at a done item again: answer, your latest pick, explanation; redo it or ask AI 助教
function openDrillReview(x) {
  const r = drillRec(x.id);
  const it = { ...x, src: 'drill', clues: '', traps: {}, target: null, submitted: true, gaveUp: !r.p, picks: r.p ? [...r.p] : x.type === 'se' ? [] : x.blanks.map(() => null) };
  const roman = ['i', 'ii', 'iii'];
  const optList = (opts, right, picked) => `<div class="opts">${opts.map((o, k) => `<div class="opt en done ${right.includes(k) ? 'right' : picked.includes(k) ? 'wrong' : ''}"><span class="v">${esc(o)}</span></div>`).join('')}</div>`;
  const body = x.type === 'se' ? optList(x.options, x.answers, it.picks)
    : x.blanks.map((b, bi) => `${x.blanks.length > 1 ? `<div class="muted small">${L('空', 'Blank')} (${roman[bi]})</div>` : ''}${optList(b.options, [b.answer], it.picks[bi] != null ? [it.picks[bi]] : [])}`).join('');
  openSheet(`
    <div class="sheet-head"><h2 style="font-size:18px">Section ${x.sec} · ${L(`第 ${x.n} 题`, `Question ${x.n}`)} · ${PR_FORMATS[x.type]}</h2><button class="x" data-close aria-label="${L('关闭', 'Close')}">×</button></div>
    <div class="muted small">${L(`首次${firstOk(r) ? '全对' : '没全对'}，用时 ${Math.round((r.fms ?? r.ms) / 1000)} 秒（参考 ${PR_TIME[x.type]} 秒）${r.n > 1 ? ` · 做过 ${r.n} 次，最近一次${r.ok ? '全对' : '没全对'}` : ''}；红色是你最近一次的选择`, `First try ${firstOk(r) ? 'fully right' : 'not fully right'}, ${Math.round((r.fms ?? r.ms) / 1000)} s (guide ${PR_TIME[x.type]} s)${r.n > 1 ? ` · done ${r.n} times, latest ${r.ok ? 'fully right' : 'not fully right'}` : ''}; red marks your latest pick`)}</div>
    <div class="sent pr-text">${practiceText(it, true)}</div>
    ${body}
    ${x.why ? `<div class="feedback"><b>${L('解析（习题集）', 'Explanation (question set)')}</b>　${esc(x.why)}</div>` : ''}
    <div class="row"><button class="btn" id="rvredo">${L('重做这题', 'Redo this question')}</button>${S.sample && !S.aiOff ? `<button class="btn" id="rvask">${L('和 AI 助教 讨论这题', 'Discuss with the AI tutor')}</button>` : ''}</div>`, (ov, close) => {
    $('#rvredo', ov).addEventListener('click', () => { close(); startDrill([x], L(`Section ${x.sec} 第 ${x.n} 题`, `Section ${x.sec} question ${x.n}`)); });
    $('#rvask', ov)?.addEventListener('click', () => { close(); it.results = []; openPracticeChat(it, 'review'); });
  });
}

// answer words for AI 助教's own items: an imported question set's answer pool if there is one, else the
// learner's word list; words used today are skipped
function poolTargets(n) {
  const used = new Set(S.L.prToday?.day === dayKey() ? S.L.prToday.words || [] : []);
  const pool = S.drills?.pool?.length ? S.drills.pool : S.words.map((w) => w.w);
  return shuffle(pool.filter((w) => !used.has(w) && !/^(a|an|the)\s/.test(w))).slice(0, n);
}
// a few real items of the requested formats, as a style and difficulty reference for AI 助教
function drillExamples(formats) {
  const D = S.drills;
  if (!D) return '';
  const roman = ['i', 'ii', 'iii'];
  const ex = [...new Set(formats)].map((f) => pick(D.items.filter((x) => x.type === f))).filter(Boolean);
  return ex.map((x) => {
    const opts = x.type === 'se' ? `options: ${x.options.join(', ')}; answers: ${x.answers.map((a) => x.options[a]).join(' + ')}`
      : x.blanks.map((b, bi) => `(${roman[bi]}) ${b.options.join(' / ')} -> ${b.options[b.answer]}`).join('; ');
    return `- [${x.type}] ${x.text}\n  ${opts}`;
  }).join('\n');
}

// learned words to build items around: the shakiest first, with some randomness
function practiceTargets(n) {
  const now = Date.now();
  const wrong = wrongCounts();
  const done = new Set(S.L.prToday?.day === dayKey() ? S.L.prToday.ids : []);
  const cands = S.words.filter((w) => {
    const c = S.L.cards[w.id];
    return c?.st && w.senses?.[0]?.en && !/\s/.test(w.w) && !done.has(w.id);
  }).map((w) => {
    const c = S.L.cards[w.id];
    const r = retrievability((now - c.last) / DAY, c.s);
    return { id: w.id, score: (1 - r) * 3 + (c.d || 5) / 10 + (wrong[w.id] || 0) * 0.5 + Math.random() };
  });
  return cands.sort((a, b) => b.score - a.score).slice(0, n).map((x) => x.id);
}
// unlearned words at a similar level AI 助教 may use as wrong options
function practicePool(k) {
  const pool = S.words.filter((w) => !S.L.cards[w.id]?.st && w.senses?.[0]?.en && !/\s/.test(w.w) && (w.df ?? 0.5) >= 0.55);
  return shuffle(pool).slice(0, k).map((w) => w.w);
}

function practicePrompt(formats, targets, mode = 'learned') {
  const lines = targets.map((t0) => {
    if (mode === 'rand') return `- word=${t0}`;
    const id = t0;
    const w = S.byId.get(id);
    const t = senseFor(w);
    const m = mwFor(w);
    const syn = [...mwThesWords(id)].slice(0, 15);
    return `- id=${id}; word=${w.w}; sense: ${t.pos} ${zhGloss(t)} (${MW_TO_AI && m && m.conf !== 'low' ? 'MW ' + m.sid + ': ' + m.def : t.en})${MW_TO_AI && syn.length ? '; MW thesaurus synonyms: ' + syn.join(', ') : ''}`;
  }).join('\n');
  const examples = drillExamples(formats);
  return `[填空实战] You write sentence-completion practice items (text completion and sentence equivalence formats) for a Chinese-speaking learner of advanced English vocabulary. Write exactly ${formats.length} items, formats in this order: ${formats.join(', ')}.
Formats:
- "tc1": a sentence or short passage with one blank written "(i)____", 5 options.
- "tc2" / "tc3": two / three blanks written "(i)____", "(ii)____", "(iii)____", 3 options per blank; the blanks must constrain each other like real multi-blank exam items.
- "se": one sentence with one blank "____" and 6 options; exactly TWO options both fit and give sentences alike in meaning.
${mode === 'rand' ? `Each item uses one word from the list below as a correct answer (one per item, in order); these come from the learner's word list or question set. If a word cannot carry the requested format well, use another word of the same kind and level instead. Other blanks' answers and all wrong options may be any words of a similar level; in "se" the second answer must be a true synonym.` : `Each item uses one target word below as a correct answer, in the sense given (one target per item, in order). Other blanks' answers in tc2/tc3 may be any words of a similar level; in "se" the second answer must be a true synonym of the target in that sense.`}
${examples ? `Real items from the learner's question set, for style, length and difficulty only (do not reuse their sentences or answers):\n${examples}\n` : ''}
Difficulty: medium-hard, like the harder half of real exam items. Write so that matching words to a remembered definition is not enough:
- The clue must take one step of reasoning: a contrast or concession (although, belied, far from, rather than), a cause or consequence, or an evaluation the reader has to infer. Never put a paraphrase of the answer's definition in the sentence (bad: "proved prescient, since things happened just as she had predicted").
- Prefer academic subjects (science, history, art, social science, criticism) and sentences of 20-40 words.
- "se" options must defeat the shortcut of just finding the synonym pair: besides the correct pair, include a DECOY PAIR (two options that are synonyms of each other and belong to the same topic, but do not fit the sentence's logic), and one LONE option that would fit the blank reasonably on its own but has no synonym among the options. The sixth option is a degree or polarity trap. No other pair of options may both fit.
- "tc1"/"tc2"/"tc3" wrong options include at least one that fits the local grammar and topic but has the wrong polarity or degree; in tc2/tc3 at least one wrong option per item fits its own blank in isolation but contradicts another blank's answer.
Wrong options: words at a similar level. Where they fit naturally, use one or two of these words the student hasn't learned yet: ${practicePool(18).join(', ')}. Never use as a wrong option a word that would also correctly fill the blank (the target's MW thesaurus synonyms are listed — they may only appear as the "se" pair).
Before replying, check every item: exactly one correct option per blank ("se": exactly one valid pair), the clue is not a restatement of the answer's definition, natural academic prose. Leave out any item that fails rather than including a weak one.
Reply with only a JSON array:
[{"type":"tc2","text":"... (i)____ ... (ii)____ ...","blanks":[{"options":["a","b","c"],"answer":1},{"options":["d","e","f"],"answer":0}],"target":"<target id>","clues":"${L('中文：关键线索词和句子逻辑', 'in English: the key clue words and the sentence logic')}","why":"${L('中文：逐空说明答案为什么对', 'in English: why each answer is right, blank by blank')}","traps":{"<wrong option>":"${L('陷阱类型：一句中文说明', 'trap type: a one-sentence explanation in English')}"}}]
For "se": {"type":"se","text":"... ____ ...","options":["6 words"],"answers":[i,j],"decoy":[k,l],"lone":m,"target":"<target id>","clues":"...","why":"...","traps":{...}} where decoy is the decoy pair's indexes and lone the lone option's index.
Trap types: ${L('同义陷阱（互为同义但填不进去的一对）, 单独能填但无同义搭档, 褒贬相反, 逻辑方向相反, 程度不对, 形近词, 搭配不当, 无关', 'synonym decoy (a synonym pair that does not fit), fits alone but has no synonym partner, opposite polarity, opposite logical direction, wrong degree, look-alike word, wrong collocation, unrelated')}.

${mode === 'rand' ? 'Answer words' : 'Targets'}:
${lines}`;
}

function validItem(x) {
  if (!x || !PR_FORMATS[x.type] || typeof x.text !== 'string') return null;
  const it = { type: x.type, text: x.text.trim(), target: S.byId.has(x.target) ? x.target : null, clues: String(x.clues || ''), why: String(x.why || ''), traps: x.traps && typeof x.traps === 'object' ? x.traps : {} };
  if (x.type === 'se') {
    if (!Array.isArray(x.options) || x.options.length !== 6 || !Array.isArray(x.answers) || x.answers.length !== 2) return null;
    const [a, b] = x.answers.map(Number);
    if (a === b || ![a, b].every((k) => k >= 0 && k < 6)) return null;
    if (!it.text.includes('____')) return null;
    // real exam structure: a decoy synonym pair that doesn't fit, separate from the answers
    const dc = Array.isArray(x.decoy) ? x.decoy.map(Number) : [];
    if (dc.length !== 2 || dc[0] === dc[1] || dc.some((k) => !(k >= 0 && k < 6) || k === a || k === b)) return null;
    it.options = x.options.map(String); it.answers = [a, b]; it.decoy = dc;
  } else {
    const nb = { tc1: 1, tc2: 2, tc3: 3 }[x.type];
    if (!Array.isArray(x.blanks) || x.blanks.length !== nb) return null;
    const per = x.type === 'tc1' ? 5 : 3;
    for (const b of x.blanks) if (!Array.isArray(b.options) || b.options.length !== per || !(b.answer >= 0 && b.answer < per)) return null;
    if ((it.text.match(/____/g) || []).length < nb) return null;
    it.blanks = x.blanks.map((b) => ({ options: b.options.map(String), answer: Number(b.answer) }));
  }
  // answer uniqueness against MW thesaurus (when the target's thesaurus is cached)
  if (it.target) {
    const syn = mwThesWords(it.target);
    const wrongOpts = it.type === 'se' ? it.options.filter((_, k) => !it.answers.includes(k)) : it.blanks.flatMap((b) => b.options.filter((_, k) => k !== b.answer));
    if (wrongOpts.some((o) => syn.has(o.toLowerCase()))) return null;
  }
  return it;
}

async function generatePractice(formats, targets, mode = 'learned') {
  if (mode !== 'rand') await Promise.all(targets.map((id) => Promise.race([ensureMw(id), sleepMs(4000)])));
  // writing items that satisfy all the constraints is worth the stronger tier
  const res = await S.sample.json(practicePrompt(formats, targets, mode), { modelTier: 'complex' });
  return (Array.isArray(res) ? res : []).map(validItem).filter(Boolean);
}

// ---------- session ----------
function startPractice(formats, count, mode = 'learned') {
  const targets = mode === 'rand' ? poolTargets(count + 3) : practiceTargets(count + 3);
  if (targets.length < 2) { toast(mode === 'rand' ? L('词表里可用的词太少', 'Too few usable words in the word list') : L('学过的词还太少，先背一些再来实战', 'Not enough learned words yet — learn some more before practicing')); return; }
  const order = Array.from({ length: count }, (_, i) => formats[i % formats.length]);
  const sid = dayKey() + '-p' + rid();
  S.L.sessions[sid] = { sid, date: dayKey(), start: Date.now(), kind: 'practice', items: [] };
  S.practice = { sid, mode, order, targets, items: [], idx: 0, loading: null, done: 0, blanksRight: 0, blanksAll: 0, itemsRight: 0 };
  $('#tabs').hidden = true;
  fetchPracticeBatch().then(() => paintPractice());
  paintPractice();
}
function fetchPracticeBatch() {
  const P = S.practice;
  if (!P || P.loading || P.items.length >= P.order.length) return P?.loading || Promise.resolve();
  const start = P.items.length;
  const formats = P.order.slice(start, start + PR_BATCH);
  const targets = P.targets.splice(0, formats.length);
  if (!targets.length) return Promise.resolve();
  P.loading = generatePractice(formats, targets, P.mode)
    .then((items) => { if (S.practice === P) { P.items.push(...items.map((x) => ({ ...x, picks: x.type === 'se' ? [] : x.blanks.map(() => null) }))); if (!items.length && !P.items.length) P.error = L('AI 助教 这次没写出合格的题，再试一次', 'The AI tutor didn\'t produce any usable questions this time — try again'); } })
    .catch((e) => { if (S.practice === P) P.error = aiErr(e); })
    .finally(() => { if (S.practice === P) P.loading = null; });
  return P.loading;
}
function exitPractice(force = false) {
  const P = S.practice;
  if (P?.exam && !P.graded && !force) {
    const n = P.items.filter(answered).length;
    if (!n) { saveExamDraft(); clearInterval(S.examClock); S.practice = null; render(); markView(); return; }
    openSheet(`<div class="sheet-head"><h2>${L('这套还没交卷', 'This set isn\'t submitted yet')}</h2><button class="x" data-close aria-label="${L('关闭', 'Close')}">×</button></div>
      <div class="muted small">${L(`已答 ${n}/${P.items.length} 题。建议一次做完再交卷；退出的话，已选的答案和用时都会保留在这台设备上，下次开始这一套时接着做。`, `${n}/${P.items.length} answered. It's best to finish before submitting; if you leave, your answers and time are kept on this device and you'll pick up where you left off next time.`)}</div>
      <div class="row"><button class="btn primary" data-close>${L('继续做', 'Keep going')}</button><button class="btn" id="prquit">${L('保留答案，退出', 'Keep answers and exit')}</button></div>`, (ov, close) => { $('#prquit', ov).addEventListener('click', () => { close(); saveExamDraft(); clearInterval(S.examClock); S.practice = null; saveLocal(true); render(); markView(); }); });
    return;
  }
  const left = P?.drill ? P.items.filter((x) => !x.submitted).length : 0;
  if (left && !force && P.done) {
    openSheet(`<div class="sheet-head"><h2>${L(`这套还剩 ${left} 题`, `${left} question(s) left in this set`)}</h2><button class="x" data-close aria-label="${L('关闭', 'Close')}">×</button></div>
      <div class="muted small">${L('建议一次做完一套，计时和正确率才有参考价值。退出的话，做过的题都已保存，下次从剩下的题接着做。', 'Finishing a set in one go makes the timing and accuracy meaningful. If you leave, finished questions are saved and you\'ll continue with the rest next time.')}</div>
      <div class="row"><button class="btn primary" data-close>${L('继续做', 'Keep going')}</button><button class="btn" id="prquit">${L('仍然退出', 'Exit anyway')}</button></div>`, (ov, close) => { $('#prquit', ov).addEventListener('click', () => { close(); exitPractice(true); }); });
    return;
  }
  S.practice = null;
  saveLocal(true); push();
  render();
  markView();
}
// blanks in the text: (i)____ or ____ -> labelled slots showing the current pick
function practiceText(it, reveal) {
  const roman = ['i', 'ii', 'iii'];
  let k = 0;
  return esc(it.text).replace(/(\((?:i{1,3})\))?\s*_{3,}/g, () => {
    const b = k++;
    if (it.type === 'se') {
      const picked = it.picks.map((p) => it.options[p]);
      return `<span class="blank pr-slot">${reveal ? esc(it.answers.map((a) => it.options[a]).join(' / ')) : esc(picked.join(' / ') || '　')}</span>`;
    }
    const bl = it.blanks[b];
    if (!bl) return '____';
    const p = it.picks[b];
    const txt = reveal ? bl.options[bl.answer] : p != null ? bl.options[p] : '';
    const cls = reveal ? (p === bl.answer ? 'fill' : 'fill bad') : 'blank';
    return `<span class="${cls} pr-slot"><span class="muted small">(${roman[b]})</span> ${esc(txt) || '　'}</span>`;
  });
}

function practiceOpts(it, done) {
  const roman = ['i', 'ii', 'iii'];
  const optBtn = (text, cls, attrs) => `<button class="opt en ${cls}" ${attrs} ${done ? 'disabled' : ''}><span class="v">${esc(text)}</span></button>`;
  if (it.type === 'se') {
    return `<div class="opts">${it.options.map((o, k) => {
      const picked = it.picks.includes(k), right = it.answers.includes(k);
      const cls = done ? (right ? 'right' : picked ? 'wrong' : '') : picked ? 'picked' : '';
      return optBtn(o, cls, `data-se="${k}"`);
    }).join('')}</div>`;
  }
  return it.blanks.map((b, bi) => `<div class="pr-group">${it.blanks.length > 1 ? `<div class="muted small">${L('空', 'Blank')} (${roman[bi]})</div>` : ''}<div class="opts">${b.options.map((o, k) => {
    const picked = it.picks[bi] === k, right = b.answer === k;
    const cls = done ? (right ? 'right' : picked ? 'wrong' : '') : picked ? 'picked' : '';
    return optBtn(o, cls, `data-b="${bi}" data-k="${k}"`);
  }).join('')}</div></div>`).join('');
}
function paintPractice() {
  const P = S.practice;
  if (!P) return;
  if (P.exam && !P.graded) return paintExam();
  if (P.exam && P.view === 'results') return paintExamResults();
  // a new item, its feedback or the summary is a new screen (picking options is not)
  const vk = `${P.idx}|${P.items[P.idx] ? 1 : 0}|${P.items[P.idx]?.submitted ? 1 : 0}`;
  if (vk !== P.vk) { P.vk = vk; markView(); }
  const total = P.order.length;
  const top = `<div class="sess-top"><button class="x" id="prexit" aria-label="${L('退出', 'Exit')}">×</button><div class="prog"><span style="width:${(P.idx / total * 100).toFixed(1)}%"></span></div><span class="muted small num">${Math.min(P.idx + 1, total)}/${total}</span></div>
    <div class="muted small" style="margin-top:-12px">${P.drill ? `${L('习题集', 'Question set')} · ${esc(P.label)} · ${L(`参考用时约 ${Math.round(P.items.reduce((a, x) => a + PR_TIME[x.type], 0) / 60)} 分钟，计时只做参考，建议一次做完`, `about ${Math.round(P.items.reduce((a, x) => a + PR_TIME[x.type], 0) / 60)} min as a guide; timing is just a reference, best done in one sitting`)}` : L('填空实战', 'Fill-in practice')}${P.blanksAll ? L(` · 空格正确率 ${Math.round(P.blanksRight / P.blanksAll * 100)}%`, ` · blank accuracy ${Math.round(P.blanksRight / P.blanksAll * 100)}%`) : ''}</div>`;
  if (P.idx >= total || (P.idx >= P.items.length && !P.loading && P.items.length && P.targets.length === 0)) return practiceSummary(top);
  const it = P.items[P.idx];
  if (!it) {
    app().innerHTML = `${top}<div class="card ruled q"><div class="q-meta"><span>${L('填空实战', 'Fill-in practice')}</span></div>${P.error ? `<p>${esc(P.error)}</p><div class="row"><button class="btn primary" id="prretry">${L('再试一次', 'Try again')}</button></div>` : `<p class="muted"><span class="spin"></span> ${L('AI 助教 正在出题（单次约半分钟到一分钟）…', 'The AI tutor is writing questions (usually 30 seconds to a minute)…')}</p>`}</div>`;
    $('#prexit').addEventListener('click', () => exitPractice());
    $('#prretry')?.addEventListener('click', () => { P.error = null; if (!P.targets.length) P.targets = P.mode === 'rand' ? poolTargets(PR_BATCH) : practiceTargets(PR_BATCH); fetchPracticeBatch().then(paintPractice); paintPractice(); });
    if (!P.loading && !P.error) fetchPracticeBatch().then(paintPractice);
    return;
  }
  if (P.idx >= P.items.length - 1) fetchPracticeBatch();   // keep the next batch coming
  it.start ||= Date.now();
  const done = it.submitted;
  const opts = practiceOpts(it, done);
  const complete = it.type === 'se' ? it.picks.length === 2 : it.picks.every((p) => p != null);
  app().innerHTML = `${top}
  <div class="card ruled q">
    <div class="q-meta"><span>${PR_FORMATS[it.type]}${it.type === 'se' ? L('：选两个意思相同、都能填入的词', ': pick the two words that both fit and give the same meaning') : it.blanks.length > 1 ? L('：每空选一个', ': pick one per blank') : ''}</span><span class="row" style="gap:6px"><span class="muted small">${L(`参考 ${PR_TIME[it.type]} 秒`, `guide ${PR_TIME[it.type]} s`)}</span>${it.src === 'drill' ? `<span class="tag">${L('习题集', 'Set')} S${it.sec}-${it.n}</span>` : `<span class="tag ai">${L('AI 助教 出题', 'Written by AI tutor')}</span>`}${it.hinted ? `<span class="tag">${L('用过提示', 'Hint used')}</span>` : ''}</span></div>
    <div class="sent pr-text">${practiceText(it, done)}</div>
  </div>
  ${opts}
  ${done ? practiceFeedback(it) : `<div class="row"><button class="btn primary" id="prsubmit" ${complete ? '' : 'disabled'}>${L('提交', 'Submit')}</button><button class="btn" id="prhint">${L('卡住了，问 AI 助教（不看答案）', 'Stuck? Ask the AI tutor (no answer shown)')}</button></div>
  <button class="btn ghost sm unk" id="prgiveup">${L('不会，看答案', 'Don\'t know — show answer')}</button>`}`;
  $('#prexit').addEventListener('click', () => exitPractice());
  if (!done) {
    app().querySelectorAll('[data-se]').forEach((b) => b.addEventListener('click', () => {
      const k = +b.dataset.se;
      it.picks = it.picks.includes(k) ? it.picks.filter((x) => x !== k) : [...it.picks, k].slice(-2);
      paintPractice();
    }));
    app().querySelectorAll('[data-b]').forEach((b) => b.addEventListener('click', () => {
      const bi = +b.dataset.b, k = +b.dataset.k;
      it.picks[bi] = it.picks[bi] === k ? null : k;
      paintPractice();
    }));
    $('#prsubmit').addEventListener('click', () => submitPractice(it));
    $('#prgiveup').addEventListener('click', () => submitPractice(it, true));
    $('#prhint').addEventListener('click', () => openPracticeChat(it, 'hint'));
  } else {
    if (P.exam) {
      $('#prnext').textContent = P.idx < total - 1 ? L('下一题', 'Next') : L('回到成绩', 'Back to results');
      $('#prnext').insertAdjacentHTML('beforebegin', `<button class="btn" id="exresults">${L('成绩单', 'Results')}</button>`);
      $('#exresults').addEventListener('click', () => { P.view = 'results'; paintPractice(); window.scrollTo(0, 0); });
    }
    $('#prnext').addEventListener('click', () => { if (P.exam && P.idx >= total - 1) P.view = 'results'; else P.idx++; paintPractice(); window.scrollTo(0, 0); });
    $('#prdiscuss')?.addEventListener('click', () => openPracticeChat(it, 'review'));
    app().querySelectorAll('[data-word]').forEach((b) => b.addEventListener('click', () => openWord(b.dataset.word)));
    app().querySelectorAll('[data-look]').forEach((b) => b.addEventListener('click', () => openLookup(b.dataset.look)));
    app().querySelectorAll('[data-today]').forEach((b) => b.addEventListener('click', () => { addToToday(b.dataset.today); b.disabled = true; b.textContent = L('已加入', 'Added'); }));
  }
}

// bank word behind an answer or option: the same word (any inflection) for grading; derived words
// too when only listing what's worth learning
function bankIdOf(text, loose = false) {
  const hit = findInBank(String(text).toLowerCase());
  return hit && (loose || hit.how === '' || hit.how === 'form') ? hit.id : null;
}
// ---------- grading ----------
function gradePracticeWord(id, ok, ms, hinted) {
  const card = S.L.cards[id];
  if (!card?.st) return 0;                     // only learned words are graded
  const now = Date.now();
  const firstToday = card.day !== dayKey(now);
  let g = 0;
  if (firstToday) {
    g = ok ? rate({ ok, ms, kind: 'cloze', type: 'ai_cloze', lv: levelOf(card) }) : 1;
    if (hinted && g > 2) g = 2;               // hints asked for: at most Hard
    if (g === 4 && lookedUpRecently(id)) g = 3;   // looked up within 24 h: at most Good
    S.L.cards[id] = fsrsReview(card, g, now, S.byId.get(id)?.df ?? 0.5);
  } else if (!ok) {
    S.L.cards[id] = { ...card, due: Math.min(card.due, dayStart(now) + DAY), u: now };
  }
  markDirty(id);
  return g;
}
function submitPractice(it, gaveUp = false, { silent = false, ms: given = null } = {}) {
  if (it.submitted) return;
  const P = S.practice;
  const ms = given ?? Date.now() - it.start;
  const chat = it.cid && S.L.chats[it.cid];
  it.hinted = !!(chat && chat.msgs.some((m) => m.r === 'u'));
  it.submitted = true; it.gaveUp = gaveUp; it.ms = ms;
  if (gaveUp) it.picks = it.type === 'se' ? [] : it.picks.map(() => null);
  const log = S.L.sessions[P.sid];
  const results = [];
  if (it.type === 'se') {
    const hits = it.answers.filter((a) => it.picks.includes(a)).length;
    P.blanksAll += 2; P.blanksRight += hits;
    const wrongPicks = it.picks.filter((p) => !it.answers.includes(p)).map((p) => it.options[p]);
    for (const a of it.answers) {
      const id = bankIdOf(it.options[a]);
      const ok = it.picks.includes(a);
      results.push({ word: it.options[a], ok });
      if (id && !ok && !S.L.cards[id]?.st) pullForward(id);
      if (id) { const g = gradePracticeWord(id, ok, ms / 2, it.hinted); log.items.push({ t: Date.now(), i: id, k: 'practice', pt: 'se', ok: ok ? 1 : 0, ms: Math.round(ms / 2), g, ...(ok ? {} : { c: wrongPicks.join(' / ') || '（未选）' }), ...(it.hinted ? { h: 1 } : {}) }); }
    }
  } else {
    const per = ms / it.blanks.length;
    it.blanks.forEach((b, bi) => {
      const ok = it.picks[bi] === b.answer;
      P.blanksAll++; if (ok) P.blanksRight++;
      const word = b.options[b.answer];
      results.push({ word, ok });
      const id = bankIdOf(word);
      if (id && !ok && !S.L.cards[id]?.st) pullForward(id);
      if (id) { const g = gradePracticeWord(id, ok, per, it.hinted); log.items.push({ t: Date.now(), i: id, k: 'practice', pt: it.type, ok: ok ? 1 : 0, ms: Math.round(per), g, ...(ok ? {} : { c: it.picks[bi] != null ? b.options[it.picks[bi]] : '（未选）' }), ...(it.hinted ? { h: 1 } : {}) }); }
    });
  }
  it.results = results;
  const allOk = !gaveUp && results.every((r) => r.ok);
  if (allOk) P.itemsRight++;
  if (it.src === 'drill') {
    const prev = drillRec(it.id), now = Date.now();
    // the first attempt is the honest measure and is never overwritten; ok/ms/p are the latest
    (S.L.drill ||= {})[it.id] = { ok: allOk ? 1 : 0, t: now, ms, n: (prev?.n || 0) + 1, p: gaveUp ? null : [...it.picks],
      f: prev ? firstOk(prev) : allOk ? 1 : 0, fms: prev ? prev.fms ?? prev.ms : ms, ft: prev ? prev.ft ?? prev.t : now };
    S.L.dirtyDr = true;
    log.items.push({ t: Date.now(), i: it.id, k: 'drill', ok: allOk ? 1 : 0, ms });
  }
  S.L.dirtyS[P.sid] = 1;
  const today = S.L.prToday?.day === dayKey() ? S.L.prToday : (S.L.prToday = { day: dayKey(), ids: [], words: [] });
  if (it.target) today.ids.push(it.target);
  if (P.mode === 'rand') (today.words ||= []).push(...results.map((r) => r.word.toLowerCase()));
  P.done++;
  // a hint conversation about this item now becomes the review conversation
  if (chat) { chat.item = practiceItemForChat(it, 'review'); saveChat(chat); }
  saveLocal(); schedulePush();
  if (!silent) paintPractice();
}

function practiceFeedback(it) {
  const roman = ['i', 'ii', 'iii'];
  const right = it.results.filter((r) => r.ok).length;
  const n = it.results.length;
  const verdict = it.gaveUp ? L('看了答案', 'Answer viewed') : right === n ? L('全对', 'All right') : it.type === 'se' ? L(`选对 ${right}/2`, `${right}/2 right`) : L(`${right}/${n} 空正确`, `${right}/${n} blanks right`);
  const vClass = it.gaveUp ? 'bad' : right === n ? 'ok' : right ? 'mid' : 'bad';
  const per = it.type === 'se' ? '' : it.blanks.map((b, bi) => {
    const p = it.picks[bi];
    return `<div class="small">${L('空', 'Blank')} (${roman[bi]})${L('：', ': ')}${p === b.answer ? '✓' : '✗'} ${esc(b.options[b.answer])}${p != null && p !== b.answer ? `<span class="muted">${L(`（你选了 ${esc(b.options[p])}）`, ` (you picked ${esc(b.options[p])})`)}</span>` : ''}</div>`;
  }).join('');
  const pickedWrong = it.type === 'se' ? it.picks.filter((p) => !it.answers.includes(p)).map((p) => it.options[p]) : it.blanks.map((b, bi) => (it.picks[bi] != null && it.picks[bi] !== b.answer ? b.options[it.picks[bi]] : null)).filter(Boolean);
  const trapOf = (w) => it.traps[w] || it.traps[w.toLowerCase()] || '';
  const allOpts = it.type === 'se' ? it.options : it.blanks.flatMap((b) => b.options);
  // unlearned words from the word bank up front; anything outside the bank folded away
  const uniq = [...new Set(allOpts)];
  const chips = uniq.map((o) => {
    const id = bankIdOf(o, true);
    return id && !S.L.cards[id]?.st ? `<span class="pr-chip"><button class="link small" data-word="${esc(id)}">${esc(o)}</button> <button class="btn sm" data-today="${esc(id)}">${L('加入今日复习', 'Add to today\'s review')}</button></span>` : '';
  }).join('');
  const outside = uniq.filter((o) => !bankIdOf(o, true));
  const graded = it.results.map((r) => { const id = bankIdOf(r.word); const c = id && S.L.cards[id]; return c?.st ? `${r.word}${L('：', ': ')}${nextText(c)}` : ''; }).filter(Boolean).join(L('；', '; '));
  return `<div class="sec">
    <div class="verdict ${vClass}">${verdict}<small>${L(`用时 ${Math.round(it.ms / 1000)} 秒（参考 ${PR_TIME[it.type]} 秒）`, `${Math.round(it.ms / 1000)} s (guide ${PR_TIME[it.type]} s)`)}${it.hinted ? L(' · 用过提示，最多记为模糊', ' · hint used, graded Hard at most') : ''}${graded ? ' · ' + esc(graded) : ''}</small></div>
    ${per}
    ${it.clues ? `<div class="feedback"><b>${L('线索', 'Clues')}</b>　${esc(it.clues)}</div>` : ''}
    ${it.why ? `<div class="feedback"><b>${L('解析', 'Explanation')}${it.src === 'drill' ? L('（习题集）', ' (question set)') : ''}</b>　${esc(it.why)}</div>` : ''}
    ${pickedWrong.length ? `<div class="feedback"><b>${L('你选的', 'Your picks')}</b>　${pickedWrong.map((w) => `${esc(w)}${L('：', ': ')}${esc(trapOf(w) || L('不合语境', 'doesn\'t fit the context'))}`).join(L('；', '; '))}</div>` : ''}
    ${Object.keys(it.traps).length ? `<details class="chat-sum"><summary class="small muted">${L('每个干扰项的陷阱', 'The trap in each wrong option')}</summary><div class="small">${Object.entries(it.traps).map(([w, t]) => `<div><b>${esc(w)}</b>${L('：', ': ')}${esc(t)}</div>`).join('')}</div></details>` : ''}
    ${chips.trim() ? `<div class="sugg"><span class="muted small">${L('选项里你词库中还没学的词：', 'Options from your words you haven\'t learned yet:')}</span>${chips}</div>` : ''}
    ${outside.length ? `<details class="chat-sum"><summary class="small muted">${L('其他选项（不在词库，可查 MW 后加入）', 'Other options (not in your words — look up in MW to add)')}</summary><div class="sugg" style="margin-top:6px">${outside.map((o) => `<button class="btn sm dashed" data-look="${esc(o)}">${L('查', 'Look up')} ${esc(o)}</button>`).join('')}</div></details>` : ''}
    <div class="next-row"><button class="btn primary" id="prnext">${L('继续', 'Continue')}</button>${S.sample && !S.aiOff ? `<button class="btn" id="prdiscuss">${L('和 AI 助教 讨论这题', 'Discuss with the AI tutor')}</button>` : ''}</div>
  </div>`;
}

function practiceSummary(top) {
  const P = S.practice;
  const done = P.items.filter((x) => x.submitted);
  const used = Math.round(done.reduce((a, x) => a + (x.ms || 0), 0) / 1000);
  const ref = done.reduce((a, x) => a + PR_TIME[x.type], 0);
  const mmss = (t) => `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
  const next = P.drill && S.drills ? drillStats().next : null;
  app().innerHTML = `${top}
  <div class="card ruled today">
    <div class="today-head"><b>${P.drill ? esc(P.label) + L(' 完成', ' done') : L('实战完成', 'Practice done')}</b><span class="muted small">${L(`${P.done} 题`, `${P.done} questions`)}</span></div>
    <div class="counts">
      <div class="count"><div class="n">${P.itemsRight}/${P.done}</div><div class="l">${L('整题全对', 'Fully correct')}</div></div>
      <div class="count"><div class="n">${P.blanksAll ? Math.round(P.blanksRight / P.blanksAll * 100) : 0}%</div><div class="l">${L('空格正确率', 'Blank accuracy')}</div></div>
      <div class="count"><div class="n">${mmss(used)}</div><div class="l">${L(`用时（参考 ${mmss(ref)}）`, `Time (guide ${mmss(ref)})`)}</div></div>
    </div>
    <div class="row">${P.drill && next != null ? `<button class="btn primary" id="prnextsec">${L(`下一套：Section ${next}`, `Next set: Section ${next}`)}</button>` : ''}<button class="btn ${P.drill && next != null ? '' : 'primary'}" id="prback">${P.drill ? L('回到习题集', 'Back to question set') : L('回到今日', 'Back to Today')}</button></div>
  </div>`;
  $('#prexit').addEventListener('click', () => exitPractice());
  $('#prback').addEventListener('click', () => exitPractice(true));
  $('#prnextsec')?.addEventListener('click', () => { saveLocal(true); push(); startDrill(S.drills.items.filter((x) => x.sec === next), `Section ${next}`, true); });
}

// ---------- conversation about an item ----------
function practiceItemForChat(it, stage) {
  const roman = ['i', 'ii', 'iii'];
  const opts = it.type === 'se' ? `选项：${it.options.join(', ')}` : it.blanks.map((b, bi) => `空(${roman[bi]}) 选项：${b.options.join(', ')}`).join('；');
  const key = it.type === 'se' ? it.answers.map((a) => it.options[a]).join(' + ') : it.blanks.map((b, bi) => `(${roman[bi]}) ${b.options[b.answer]}`).join('；');
  const picks = it.submitted ? (it.gaveUp ? '没有作答，直接看了答案' : it.type === 'se' ? `选了 ${it.picks.map((p) => it.options[p]).join(' + ') || '（无）'}` : it.blanks.map((b, bi) => `(${roman[bi]}) ${it.picks[bi] != null ? b.options[it.picks[bi]] : '未选'}${it.picks[bi] === b.answer ? ' ✓' : ' ✗'}`).join('；')) : '';
  return { stage, format: PR_FORMATS[it.type], source: it.src === 'drill' ? `习题集 Section ${it.sec} 第 ${it.n} 题` : '', text: it.text, opts, key, clues: it.clues, why: it.why, traps: Object.entries(it.traps).map(([w, t]) => `${w}：${t}`).join('；'), picks };
}
function openPracticeChat(it, stage) {
  let c = it.cid && S.L.chats[it.cid];
  const answers = it.type === 'se' ? it.answers.map((a) => it.options[a]) : it.blanks.map((b) => b.options[b.answer]);
  if (!c) {
    const links = [...new Set(answers.map((w) => bankIdOf(w, true)).filter(Boolean))].map((id) => ({ id }));
    c = newChat(links);
    c.title = it.src === 'drill' ? L(`习题集 S${it.sec}-${it.n} · ${PR_FORMATS[it.type]}`, `Set S${it.sec}-${it.n} · ${PR_FORMATS[it.type]}`) : L(`实战题 · ${PR_FORMATS[it.type]} · ${(it.target && S.byId.get(it.target)?.w) || answers[0]}`, `Practice · ${PR_FORMATS[it.type]} · ${(it.target && S.byId.get(it.target)?.w) || answers[0]}`);
    it.cid = c.cid;
  }
  c.item = practiceItemForChat(it, it.submitted ? 'review' : stage);
  openChat(c.cid);
}
