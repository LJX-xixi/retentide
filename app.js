'use strict';
/* Retentide — vocabulary learning with an AI tutor and FSRS review; answers are graded automatically.
   Progress lives in localStorage first and, if the learner connects Supabase, syncs in batches.
   Grading is automatic: correctness + response time + question level -> FSRS rating.
   Platform services (storage, AI, dictionary) come from window.vocabRuntime (runtime/index.js). */
const APP_NAME = 'Retentide';
const APP_ID = 'retentide';
const ALGO_VERSION = 'fsrs5-auto-v1';  // recorded on every answer so logs from different rules can be told apart

// ---------- small helpers ----------
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const DAY = 864e5;
const CUT = 4 * 3600e3; // a study day starts at 04:00 local time
const dayStart = (ts = Date.now()) => { const d = new Date(ts - CUT); d.setHours(0, 0, 0, 0); return d.getTime() + CUT; };
const dayKey = (ts = Date.now()) => { const d = new Date(ts - CUT); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const rid = () => Math.random().toString(36).slice(2, 8);

// ---------- FSRS-5 (default parameters) ----------
const W = [0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046, 1.54575, 0.1192, 1.01925, 1.9395, 0.11, 0.29605, 2.2698, 0.2315, 2.9898, 0.51655, 0.6621];
const DECAY = -0.5, FACTOR = 19 / 81, RETAIN = 0.9;
const clampD = (d) => Math.min(10, Math.max(1, d));
const retrievability = (t, s) => Math.pow(1 + FACTOR * t / s, DECAY);
const initD = (g) => clampD(W[4] - Math.exp(W[5] * (g - 1)) + 1);
const nextD = (d, g) => clampD(W[7] * initD(4) + (1 - W[7]) * (d + (-W[6] * (g - 3)) * (10 - d) / 9));
const sRecall = (d, s, r, g) => s * (1 + Math.exp(W[8]) * (11 - d) * Math.pow(s, -W[9]) * (Math.exp(W[10] * (1 - r)) - 1) * (g === 2 ? W[15] : 1) * (g === 4 ? W[16] : 1));
const sForget = (d, s, r) => Math.min(s, W[11] * Math.pow(d, -W[12]) * (Math.pow(s + 1, W[13]) - 1) * Math.exp(W[14] * (1 - r)));
const sShort = (s, g) => s * Math.exp(W[17] * (g - 3 + W[18]));

// p = prior difficulty of the word (0 easy .. 1 hard, from word frequency and exam band);
// it shifts the first difficulty estimate by up to ±1 and the reviews take over from there.
function fsrsReview(card, g, now, p = 0.5) {
  const c = { ...card };
  if (!c.st || c.s == null) {
    c.s = W[g - 1]; c.d = clampD(initD(g) + 2 * (p - 0.5)); c.reps = 0; c.lapses = 0;
  } else {
    const elapsed = Math.max(0, (now - (c.last || now)) / DAY);
    if (elapsed < 0.5) c.s = Math.max(0.1, sShort(c.s, g));
    else { const r = retrievability(elapsed, c.s); c.s = g === 1 ? sForget(c.d, c.s, r) : sRecall(c.d, c.s, r, g); }
    c.d = nextD(c.d, g);
  }
  c.reps = (c.reps || 0) + 1;
  if (g === 1 && card.st === 2) c.lapses = (c.lapses || 0) + 1;
  c.st = g === 1 ? (card.st === 2 || card.st === 3 ? 3 : 1) : 2;
  const ivl = Math.min(1095, c.s / FACTOR * (Math.pow(RETAIN, 1 / DECAY) - 1));
  const fuzz = ivl > 3 ? 0.95 + Math.random() * 0.1 : 1;
  const days = g === 1 ? 1 : Math.max(1, Math.round(ivl * fuzz));
  c.due = dayStart(now) + days * DAY;
  c.last = now; c.u = now; c.day = dayKey(now);
  return c;
}

// Ladder: 1 learn card · 2 recognition · 3 reverse/context · 4 production/generalization
function levelOf(c) {
  if (!c || !c.st) return 1;
  if (c.st !== 2 || c.s < 4) return 2;
  if (c.s < 15) return 3;
  return 4;
}
// mastery buckets for stats: 0 unseen, 1 learning, 2 familiar, 3 known, 4 solid
function masteryOf(c) {
  if (!c || !c.st) return 0;
  if (c.st !== 2 || c.s < 4) return 1;
  if (c.s < 15) return 2;
  if (c.s < 60) return 3;
  return 4;
}
const MASTERY = [L('未学', 'New'), L('学习中', 'Learning'), L('熟悉', 'Familiar'), L('掌握', 'Known'), L('牢固', 'Solid')];
const BAND_NAME = { basic: L('中学词', 'High school'), cet4: L('四级', 'CET-4'), cet6: L('六级', 'CET-6'), kaoyan: L('考研', 'Kaoyan') };

// ---------- app state ----------
// one progress store per account, so signing in as someone else never shows or uploads this learner's data
const LS_KEY = 'ovd-progress-v1:' + (window.vocabRuntime?.scope || 'local');
const DEFAULT_PREFS = { dailyNew: 50, autoNew: true, examDate: '', order: 'book', typing: true, autoNext: false, screenSec: 5, u: 0 };
const PREFS_VERSION = 2; // bump with a step in migratePrefs() when defaults change for existing users
// a screening answer this fast and correct skips the word (seconds, set in Settings)
const screenMs = () => Math.min(15, Math.max(2, +S.L.prefs.screenSec || 5)) * 1000;
const screenSecTxt = () => +(screenMs() / 1000).toFixed(1);
const SCREEN_DAYS = 45;      // ...until one spot check
const SCREEN_PER_SESSION = 40;
const LEARN_FIRST_DF = 0.6;  // new words at or above this prior difficulty get the card before any test
const PRE_SLOW_MS = 6000;    // a correct pre-test slower than this (and than 1.6x your usual) looks like a guess
const S = {
  words: [], byId: new Map(), groups: [], posPool: {}, newOrder: [],
  L: null, db: null, sample: null, aiOff: false, readOnly: false,
  sync: { state: 'local', at: 0, msg: '' },
  tab: 'home', session: null, bank: { q: '', src: 'all', st: 'all', list: 'all', sort: 'book', limit: 120, view: 'list', seed: Math.random() },
};

function freshLocal() {
  return { v: 1, cards: {}, prefs: { ...DEFAULT_PREFS, pv: PREFS_VERSION }, dirty: {}, dirtyS: {}, dirtyP: false, sessions: {}, ai: {}, custom: {}, times: { mc: [], cloze: [], type: [] }, diag: null,
    chats: {}, dirtyC: {}, notes: {}, dirtyN: {}, partsQ: {}, asked: {}, dirtyA: false, lookups: {}, dirtyL: false, dirtyU: {}, drill: {}, dirtyDr: false };
}
function loadLocal() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) { const L = JSON.parse(raw); const f = freshLocal(); return { ...f, ...L, prefs: { ...DEFAULT_PREFS, ...L.prefs }, times: { ...f.times, ...L.times } }; }
  } catch (e) { /* storage blocked or corrupt: start fresh */ }
  return freshLocal();
}
// Several tabs of the page share one localStorage but each keeps its own copy in memory. Before
// writing, fold in whatever another tab wrote (newest item wins), so no tab overwrites another's
// answers, notes or conversations; a `storage` event brings the other tab's changes in live.
function mergeLocal(o) {
  if (!o || typeof o !== 'object') return { cards: false, custom: false };
  const L = S.L;
  const changed = { cards: false, custom: false };
  for (const [id, c] of Object.entries(o.cards || {})) {
    if ((c?.u || 0) > (L.cards[id]?.u || 0)) { L.cards[id] = c; changed.cards = true; if (o.dirty?.[id]) L.dirty[id] = 1; }
  }
  for (const [sid, x] of Object.entries(o.sessions || {})) {
    if ((x?.items?.length || 0) > (L.sessions[sid]?.items?.length || 0)) { L.sessions[sid] = x; if (o.dirtyS?.[sid]) L.dirtyS[sid] = 1; }
  }
  if ((o.prefs?.u || 0) > (L.prefs?.u || 0)) { L.prefs = { ...DEFAULT_PREFS, ...o.prefs }; if (o.dirtyP) L.dirtyP = true; buildNewOrder(); }
  for (const [id, n] of Object.entries(o.notes || {})) if ((n?.u || 0) > (L.notes[id]?.u || 0)) { L.notes[id] = n; if (o.dirtyN?.[id]) L.dirtyN[id] = 1; }
  for (const [cid, c] of Object.entries(o.chats || {})) if ((c?.updated || 0) > (L.chats[cid]?.updated || 0)) { L.chats[cid] = c; if (o.dirtyC?.[cid]) L.dirtyC[cid] = 1; }
  for (const [id, w] of Object.entries(o.custom || {})) if (!L.custom[id] || cstamp(w) > cstamp(L.custom[id])) { L.custom[id] = w; changed.custom = true; if (o.dirtyU?.[id]) (L.dirtyU ||= {})[id] = 1; }
  for (const [id, a] of Object.entries(o.ai || {})) L.ai[id] = { ...a, ...(L.ai[id] || {}) };
  for (const [id, t] of Object.entries(o.asked || {})) if (t > (L.asked[id] || 0)) { L.asked[id] = t; if (o.dirtyA) L.dirtyA = true; }
  if (mergeLookups(o.lookups) && o.dirtyL) L.dirtyL = true;
  Object.assign(L.partsQ ||= {}, o.partsQ || {});
  if (o.mwCount?.day === L.mwCount?.day && (o.mwCount.n || 0) > (L.mwCount.n || 0)) L.mwCount = o.mwCount;
  if ((o.diag?.at || 0) > (L.diag?.at || 0)) L.diag = o.diag;
  if (mergeDrill(o.drill) && o.dirtyDr) L.dirtyDr = true;
  return changed;
}
function mergeDrill(other) {
  let changed = false;
  const mine = (S.L.drill ||= {});
  for (const [id, r] of Object.entries(other || {})) if ((r?.t || 0) > (mine[id]?.t || 0)) { mine[id] = r; changed = true; }
  return changed;
}
// custom words carry u (last change); older ones only have the time they were added
const cstamp = (w) => w?.u || w?.added || 0;
let saveTimer = null;
function saveLocal(now = false) {
  clearTimeout(saveTimer);
  if (window.vocabRuntime?.frozen) return;   // switching account: this page's store is about to be replaced
  const run = () => {
    try {
      try { const raw = localStorage.getItem(LS_KEY); if (raw && raw !== S.lastSaved) mergeLocal(JSON.parse(raw)); } catch (e) { /* unreadable: overwrite */ }
      // keep 35 days of session logs locally
      const cutoff = dayKey(Date.now() - 35 * DAY);
      for (const [sid, s] of Object.entries(S.L.sessions)) if (s.date < cutoff && !S.L.dirtyS[sid]) delete S.L.sessions[sid];
      const chats = Object.values(S.L.chats || {}).sort((a, b) => (b.updated || 0) - (a.updated || 0));
      for (const c of chats.slice(40)) if (!S.L.dirtyC[c.cid]) delete S.L.chats[c.cid];
      for (const c of chats) if (!c.msgs?.length && Date.now() - (c.created || 0) > 600e3) delete S.L.chats[c.cid];
      S.lastSaved = JSON.stringify(S.L);
      localStorage.setItem(LS_KEY, S.lastSaved);
    } catch (e) { /* quota or blocked: the db still has the data */ }
  };
  if (now) run(); else saveTimer = setTimeout(run, 250);
}

// ---------- word bank ----------
const stripAscii = (s) => String(s || '').replace(/\([^)]*[A-Za-z][^)]*\)/g, '').replace(/[A-Za-z][A-Za-z .,'’\-]*[A-Za-z]/g, (m) => (m.length > 2 ? '' : m)).replace(/\s{2,}/g, ' ').replace(/^[\s,，；;]+|[\s,，；;|]+$/g, '').trim();
// the short meaning shown in options and lists: the Chinese gloss, or the English definition for an
// English interface (or a deck without Chinese)
const zhGloss = (sense) => (window.LANG === 'en' || !sense.zh ? sense.en || sense.zh || '' : stripAscii(sense.zh) || sense.zh);
const testSenses = (w) => (w.tags.includes('trap') && w.trapSenses?.length ? w.trapSenses : w.senses);
const mainPos = (w) => (w.senses[0]?.pos || '').replace(/&.*|\/.*/, '');

function indexWords(data) {
  // the deck, then the learner's own words (熟词僻义 is the deck's list only, so added words never carry it)
  const custom = Object.values(S.L.custom || {}).map((w) => (w.tags?.includes('trap') ? { ...w, tags: w.tags.filter((t) => t !== 'trap') } : w));
  const words = data.words.concat(custom);
  S.words = words; S.byId = new Map(words.map((w) => [w.id, w])); S._bankByName = null; S._derived = null; S._bookOrder = null; S.groups = data.confusables || S.groups;
  S.posPool = {};
  for (const w of words) {
    if (!w.senses?.length || !w.senses[0].en || !w.senses[0].zh) continue;
    const p = mainPos(w) || 'x';
    (S.posPool[p] ||= []).push(w.id);
  }
  buildNewOrder();
}
function buildNewOrder() {
  const order = S.L.prefs.order;
  const ws = S.words;
  let ids;
  const custom = ws.filter((w) => w.tags.includes('custom')).map((w) => w.id);
  if (order === 'trap') ids = [...ws.filter((w) => w.tags.includes('trap')), ...ws.filter((w) => !w.tags.includes('trap'))].map((w) => w.id);
  else if (order === 'conf') ids = [...ws.filter((w) => w.tags.includes('confusable')), ...ws.filter((w) => !w.tags.includes('confusable'))].map((w) => w.id);
  else {
    // book order, with trap-only and look-alike-only entries mixed in every 12 words
    const core = ws.filter((w) => w.tags[0] === 'core').map((w) => w.id);
    const extra = ws.filter((w) => w.tags[0] === 'trap' || w.tags[0] === 'confusable').map((w) => w.id);
    // supplement words (tag `supplement`) go one after every 7 core words still to learn, so they spread
    // out from where the learner stands; words marked `late` come after everything else
    const gm = ws.filter((w) => w.tags[0] === 'supplement' && !w.late).map((w) => w.id);
    const late = ws.filter((w) => w.late).map((w) => w.id);
    ids = [];
    let k = 0, g = 0, fresh = 0;
    core.forEach((id, i) => {
      ids.push(id);
      if (i % 12 === 11 && k < extra.length) ids.push(extra[k++]);
      if (unseen(id) && ++fresh % 7 === 0 && g < gm.length) ids.push(gm[g++]);
    });
    ids.push(...extra.slice(k), ...gm.slice(g), ...late);
  }
  const seen = new Set(custom);
  const boost = (S.L.prefs.boost || []).filter((id) => S.byId.has(id) && unseen(id) && !seen.has(id) && (seen.add(id), true));
  S.newOrder = [...boost, ...custom, ...ids.filter((id) => !seen.has(id) && (seen.add(id), true))];
}

// ---------- deliberate lookups ----------
// Opening a word on purpose (word bank, search, a chip or link) is recorded. It never changes the
// memory model directly (a lookup isn't a recall attempt), but a review within 24 h of one can't
// count as Easy, repeated lookups count toward "对我很难", and the word sheet can suggest a review.
const LOOKUP_CAP_MS = 24 * 3600e3;
function lookupsOf(id, withinMs = 30 * DAY) { const since = Date.now() - withinMs; return (S.L.lookups?.[id] || []).filter((t) => t >= since); }
function recordLookup(id) {
  if (!S.byId.has(id)) return;
  const L = (S.L.lookups ||= {});
  const arr = L[id] || [];
  if (arr.length && Date.now() - arr[arr.length - 1] < 60e3) return;   // reopening right away isn't a new lookup
  L[id] = [...arr, Date.now()].slice(-6);
  S.L.dirtyL = true; saveLocal(); schedulePush();
}
function trimLookups() {
  const since = Date.now() - 60 * DAY;
  for (const [id, arr] of Object.entries(S.L.lookups || {})) { const keep = arr.filter((t) => t >= since).slice(-6); if (keep.length) S.L.lookups[id] = keep; else delete S.L.lookups[id]; }
}
function mergeLookups(other) {
  let changed = false;
  for (const [id, arr] of Object.entries(other || {})) {
    const mine = S.L.lookups[id] || [];
    const all = [...new Set([...mine, ...(arr || [])])].sort((a, b) => a - b).slice(-6);
    if (all.length !== mine.length || all.some((t, i) => t !== mine[i])) { S.L.lookups[id] = all; changed = true; }
  }
  return changed;
}
const lookedUpRecently = (id) => lookupsOf(id, LOOKUP_CAP_MS).length > 0;

// ---------- capability bootstrap ----------
// The db delivers snapshot data frozen. The app edits what it reads (chat messages, the MW index,
// cached questions), so every read goes through this wrapper and hands back a writable copy.
const thaw = (v) => (v == null ? v : structuredClone(v));
function thawSnap(snap) { return { id: snap.id, exists: snap.exists, metadata: snap.metadata, data: () => thaw(snap.data()) }; }
function thawDb(db) {
  const query = (q) => ({
    path: q.path,
    where: (...a) => query(q.where(...a)),
    orderBy: (...a) => query(q.orderBy(...a)),
    limit: (n) => query(q.limit(n)),
    doc: (id) => docRef(q.doc(id)),
    get: async () => { const snap = await q.get(); const docs = snap.docs.map(thawSnap); return { docs, size: docs.length, empty: !docs.length, metadata: snap.metadata }; },
  });
  const docRef = (r) => ({
    id: r.id, path: r.path,
    get: async () => thawSnap(await r.get()),
    set: (d) => r.set(d), update: (d) => r.update(d), delete: () => r.delete(),
    collection: (p) => query(r.collection(p)),
  });
  return { doc: (p) => docRef(db.doc(p)), collection: (p) => query(db.collection(p)) };
}
async function useCap(name) {
  try { return window.vocabRuntime?.use ? await window.vocabRuntime.use(name) : null; } catch (e) { return null; }
}

// ---------- sync ----------
const NB = 40;
const bucketOf = (id) => { let h = 0; for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) | 0; return 'b' + String(Math.abs(h) % NB).padStart(2, '0'); };
function markDirty(id) { S.L.dirty[id] = 1; }
function setSync(state, msg = '') { S.sync = { ...S.sync, state, msg, at: state === 'ok' ? Date.now() : S.sync.at }; paintSyncChip(); }

async function pull() {
  if (!S.db) return;
  setSync('syncing');
  try {
    const snap = await S.db.collection('me/cards/b').get();
    const remoteIds = new Set();
    for (const d of snap.docs) {
      const c = d.data()?.c || {};
      for (const [id, rc] of Object.entries(c)) {
        remoteIds.add(id);
        const lc = S.L.cards[id];
        if (!lc || (rc.u || 0) > (lc.u || 0)) { S.L.cards[id] = { ...rc }; delete S.L.dirty[id]; }
        else if ((lc.u || 0) > (rc.u || 0)) markDirty(id);
      }
    }
    for (const id of Object.keys(S.L.cards)) if (!remoteIds.has(id)) markDirty(id);

    const p = await S.db.doc('me/prefs').get();
    if (p.exists) {
      const rp = p.data();
      if ((rp.u || 0) > (S.L.prefs.u || 0)) S.L.prefs = { ...DEFAULT_PREFS, ...rp };
      else if ((S.L.prefs.u || 0) > (rp.u || 0)) S.L.dirtyP = true;
    } else if (S.L.prefs.u) S.L.dirtyP = true;

    const cs = await S.db.collection('me/custom/w').get();
    let customChanged = false;
    const remoteCustom = new Set();
    for (const d of cs.docs) {
      remoteCustom.add(d.id);
      const r = d.data(), l = S.L.custom[d.id];
      if (!l || cstamp(r) > cstamp(l)) { S.L.custom[d.id] = r; delete (S.L.dirtyU ||= {})[d.id]; customChanged = true; }
      else if (cstamp(l) > cstamp(r)) (S.L.dirtyU ||= {})[d.id] = 1;
    }
    for (const id of Object.keys(S.L.custom)) if (!remoteCustom.has(id)) (S.L.dirtyU ||= {})[id] = 1;
    if (customChanged && S.data) indexWords(S.data);

    try {
      const ns = await S.db.collection('me/notes/w').get();
      for (const d of ns.docs) {
        const r = d.data();
        if (!S.L.dirtyN[d.id] || (r.u || 0) > (S.L.notes[d.id]?.u || 0)) S.L.notes[d.id] = r;
      }
      const lk = await S.db.doc('me/lookups').get();
      if (lk.exists && mergeLookups(lk.data().ids)) saveLocal();
      const dr = await S.db.doc('me/drill').get();
      if (dr.exists) {
        const remote = dr.data().r || {};
        mergeDrill(remote);
        if (Object.entries(S.L.drill || {}).some(([id, r]) => (r.t || 0) > (remote[id]?.t || 0))) S.L.dirtyDr = true;
      }
      const ask = await S.db.doc('me/chatwords').get();
      if (ask.exists) for (const [id, t] of Object.entries(ask.data().ids || {})) if (t > (S.L.asked[id] || 0)) S.L.asked[id] = t;
      const chs = await S.db.collection('me/chat/c').orderBy('updated', 'desc').limit(60).get();
      for (const d of chs.docs) {
        const r = d.data();
        if ((r.updated || 0) > (S.L.chats[d.id]?.updated || 0)) S.L.chats[d.id] = r;
      }
      // conversations from before the index existed still count
      for (const c of Object.values(S.L.chats)) if (!c.deleted && c.msgs?.length) for (const id of c.wids || []) if ((c.updated || 0) > (S.L.asked[id] || 0)) { S.L.asked[id] = c.updated; S.L.dirtyA = true; }
    } catch (e) { if (['revoked', 'not_granted'].includes(e?.code)) throw e; /* chats and notes catch up next pull */ }

    const cutoff = dayKey(Date.now() - 30 * DAY);
    const ls = await S.db.collection('me/logs/s').where('date', '>=', cutoff).get();
    const remoteS = new Map();
    for (const d of ls.docs) {
      const r = d.data();
      remoteS.set(d.id, r.items?.length || 0);
      const l = S.L.sessions[d.id];
      if (!l || (r.items?.length || 0) > (l.items?.length || 0)) S.L.sessions[d.id] = r;
    }
    // logs this device has that the cloud is missing (or has fewer answers of) go up again
    for (const [sid, l] of Object.entries(S.L.sessions)) if (l.date >= cutoff && (l.items?.length || 0) > (remoteS.get(sid) ?? -1)) S.L.dirtyS[sid] = 1;
    saveLocal();
    setSync('ok');
    await push();
  } catch (e) {
    handleSyncError(e);
  }
}

let pushing = false, pushAgain = false, retryDelay = 1000;
async function push() {
  if (!S.db || S.readOnly) return;
  if (pushing) { pushAgain = true; return; }
  clearTimeout(pushTimer);
  pushing = true;
  try {
    const byBucket = {};
    for (const id of Object.keys(S.L.dirty)) if (S.L.cards[id]) (byBucket[bucketOf(id)] ||= []).push(id);
    const total = Object.keys(S.L.dirty).length + Object.keys(S.L.dirtyS).length + (S.L.dirtyP ? 1 : 0) + Object.keys(S.L.dirtyC).length + Object.keys(S.L.dirtyN).length + Object.keys(S.L.partsQ || {}).length + (S.L.dirtyA ? 1 : 0) + (S.L.dirtyL ? 1 : 0) + Object.keys(S.L.dirtyU || {}).length + (S.L.dirtyDr ? 1 : 0);
    if (!total) { retryDelay = 1000; setSync('ok'); return; }
    setSync('syncing');
    for (const [b, ids] of Object.entries(byBucket)) {
      const c = {};
      for (const id of ids) c[id] = S.L.cards[id];
      const ref = S.db.doc('me/cards/b/' + b);
      try { await ref.update({ c }); } catch (e) {
        if (e?.code === 'invalid_argument') await ref.set({ c }); else throw e;
      }
      for (const id of ids) if (S.L.cards[id] && S.L.cards[id].u === c[id].u) delete S.L.dirty[id];
    }
    for (const sid of Object.keys(S.L.dirtyS)) {
      const s = S.L.sessions[sid];
      if (!s) { delete S.L.dirtyS[sid]; continue; }
      const n = s.items.length;
      await S.db.doc('me/logs/s/' + sid).set(JSON.parse(JSON.stringify(s)));
      if (S.L.sessions[sid].items.length === n) delete S.L.dirtyS[sid];
    }
    if (S.L.dirtyP) { await S.db.doc('me/prefs').set({ ...S.L.prefs }); S.L.dirtyP = false; }
    for (const id of Object.keys(S.L.dirtyU || {})) {
      const w = S.L.custom[id];
      if (w) await S.db.doc('me/custom/w/' + id).set(JSON.parse(JSON.stringify(w)));
      if (!w || cstamp(S.L.custom[id]) === cstamp(w)) delete S.L.dirtyU[id];
    }
    // continuation docs first, so a conversation never points at a part that isn't stored yet
    for (const [key, part] of Object.entries(S.L.partsQ || {})) {
      await S.db.doc(`me/chat/c/${part.cid}/p/${part.n}`).set(JSON.parse(JSON.stringify(part)));
      delete S.L.partsQ[key];
    }
    for (const cid of Object.keys(S.L.dirtyC)) {
      const c = S.L.chats[cid];
      if (!c) { delete S.L.dirtyC[cid]; continue; }
      const stamp = c.updated;
      if (c.deleted) {
        for (let n = 0; n < (c.parts || 0); n++) await S.db.doc(`me/chat/c/${cid}/p/${n}`).delete();
        await S.db.doc('me/chat/c/' + cid).delete(); delete S.L.chats[cid];
      }
      else await S.db.doc('me/chat/c/' + cid).set(JSON.parse(JSON.stringify(c)));
      if (!S.L.chats[cid] || S.L.chats[cid].updated === stamp) delete S.L.dirtyC[cid];
    }
    if (S.L.dirtyA) { await S.db.doc('me/chatwords').set({ ids: { ...S.L.asked } }); S.L.dirtyA = false; }
    if (S.L.dirtyDr) { S.L.dirtyDr = false; await S.db.doc('me/drill').set({ r: JSON.parse(JSON.stringify(S.L.drill || {})) }); }
    if (S.L.dirtyL) { trimLookups(); await S.db.doc('me/lookups').set({ ids: JSON.parse(JSON.stringify(S.L.lookups)) }); S.L.dirtyL = false; }
    for (const id of Object.keys(S.L.dirtyN)) {
      const n = S.L.notes[id];
      const stamp = n?.u;
      if (!n || !n.items?.length) await S.db.doc('me/notes/w/' + id).delete();
      else await S.db.doc('me/notes/w/' + id).set(JSON.parse(JSON.stringify(n)));
      if (S.L.notes[id]?.u === stamp) delete S.L.dirtyN[id];
    }
    saveLocal();
    retryDelay = 1000;
    setSync('ok');
  } catch (e) {
    handleSyncError(e);
    // Keep dirty session logs until both the document and its analysis rows have been acknowledged.
    if (S.db && !S.readOnly && navigator.onLine !== false) {
      clearTimeout(pushTimer);
      pushTimer = setTimeout(push, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 60000);
    }
  } finally {
    pushing = false;
    if (pushAgain) { pushAgain = false; setTimeout(push, 500); }
  }
}
function handleSyncError(e) {
  const code = e?.code;
  if (code === 'revoked' || code === 'not_granted' || code === 'capability_disabled' || code === 'capability_removed') {
    S.db = null; setSync('local', L('同步不可用，进度只保存在这台设备上', 'Sync unavailable; progress is saved on this device only'));
  } else if (code === 'quota_exceeded') {
    setSync('error', L('云端存储已满，进度暂存在本机', 'Cloud storage is full; progress is kept on this device for now'));
  } else if (code === 'invalid_argument') {
    S.readOnly = true; setSync('error', L('你没有这个页面的写入权限，进度只保存在本机', 'You don’t have write access to this page; progress is saved on this device only'));
  } else {
    setSync('offline', navigator.onLine === false ? L('离线：进度已存在本机，联网后自动上传', 'Offline: progress is saved here and will upload when you reconnect') : L('同步失败，稍后自动重试', 'Sync failed; retrying shortly'));
  }
}
let pushTimer = null;
function schedulePush(fast = false) {
  clearTimeout(pushTimer);
  const pending = Object.keys(S.L.dirty).length;
  pushTimer = setTimeout(push, fast || pending >= 12 ? 300 : 4000);
}
window.addEventListener('online', () => push());
window.addEventListener('storage', (e) => {
  if (e.key !== LS_KEY || !e.newValue || !S.L || !S.words.length) return;
  let changed;
  try { changed = mergeLocal(JSON.parse(e.newValue)); } catch (err) { return; }
  if (changed.custom && S.data) indexWords(S.data);
  // refresh what's on screen unless the viewer is mid-session or typing
  const typing = document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
  if (!S.session && !S.practice && !typing && !$('#overlay').firstChild && (S.tab === 'home' || S.tab === 'ask' || S.tab === 'bank')) render();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { saveLocal(true); push(); }
  else if (S.db && Date.now() - (S.sync.at || 0) > 60e3 && !S.session) pull().then(render);
});

// ---------- answer timing & grading ----------
const KIND = { mc_def2word: 'mc', mc_en2zh: 'mc', mc_zh2en: 'mc', mc_syn: 'mc', cloze_book: 'cloze', ai_cloze: 'cloze', type_meaning: 'type' };
const BASE_MS = { mc: 3800, cloze: 7000, type: 11000 };
function med(kind) { return median(S.L.times[kind] || []) || BASE_MS[kind]; }
function recordTime(kind, ms, type) {
  if (ms >= 60000) return;
  for (const k of kind === 'mc' && type ? [kind, type] : [kind]) { const a = (S.L.times[k] ||= []); a.push(ms); if (a.length > 60) a.shift(); }
}
// Choice items differ a lot in reading load (your medians: 中选英 1.6 s, 英选中 2.0 s, 英义选词 2.8 s),
// so each type is timed against its own median. Until a type has a few answers, the pooled choice
// median scaled by a typical ratio stands in. Below the floor a correct answer is never 模糊.
const TYPE_RATIO = { mc_en2zh: 1.1, mc_zh2en: 0.9, mc_def2word: 1.5, mc_syn: 1.4 };
const SLOW_FLOOR = { mc_en2zh: 4000, mc_zh2en: 4000, mc_def2word: 6000, mc_syn: 6000 };
function medType(kind, type) {
  const a = S.L.times[type];
  return a?.length >= 8 ? median(a) : med(kind) * (TYPE_RATIO[type] || 1);
}
// an English definition longer than usual takes longer to read: ~0.25 s per word past 8
const readExtra = (type, def) => (type === 'mc_def2word' && def ? Math.max(0, def.split(/\s+/).length - 8) * 250 : 0);
function slowMs(kind, type, def) { return Math.max(1.6 * medType(kind, type) + readExtra(type, def), SLOW_FLOOR[type] || 0); }
// Correctness decides first. Time only separates Hard / Good / Easy, never for typed answers
// (typing and IME switching on a phone are noise), and Easy needs a context question at a
// higher level: a quick lucky pick on a four-choice recognition item must not stretch the interval.
const EASY_TYPES = new Set(['cloze_book', 'ai_cloze']);
function rate({ ok, ms, kind, type, lv, known, def }) {
  if (!ok) return 1;
  if (type === 'type_meaning') return 3;
  const m = medType(kind, type);
  if (ms > slowMs(kind, type, def)) return 2;
  if (ms < 0.6 * m && ((EASY_TYPES.has(type) && lv >= 3) || known)) return 4;
  return 3;
}

// ---------- question building ----------
function senseFor(w) {
  const ts = testSenses(w);
  if (ts === w.senses && w.rare?.length && w.senses[w.rare[0]]) return w.senses[w.rare[0]];
  return ts.find((s) => s.zh) || w.senses[0];
}
function charOverlap(a, b) {
  const A = new Set(a.replace(/[^一-鿿]/g, '')), B = new Set(b.replace(/[^一-鿿]/g, ''));
  if (!A.size || !B.size) return 0;
  let n = 0; for (const c of A) if (B.has(c)) n++;
  return n / Math.min(A.size, B.size);
}
function distractorIds(w, n, { avoidSyn = true, prefer = null, must = [] } = {}) {
  const out = [];
  const used = new Set([w.id]);
  // book synonyms plus MW thesaurus synonyms / related / near words of the target
  const syn = new Set([...(w.syn || []).map((x) => x.toLowerCase()), ...mwThesWords(w.id)]);
  const ok = (id) => {
    if (used.has(id)) return false;
    const x = S.byId.get(id);
    if (!x || !x.senses?.length) return false;
    if (avoidSyn && (syn.has(x.w.toLowerCase()) || mwThesWords(id).has(w.w.toLowerCase()))) return false;
    if (charOverlap(zhGloss(senseFor(x)), zhGloss(senseFor(w))) > 0.5) return false;
    return true;
  };
  for (const id of must) if (out.length < n && ok(id)) { out.push(id); used.add(id); }
  for (const id of shuffle([...(prefer || [])])) if (out.length < n && ok(id)) { out.push(id); used.add(id); }
  for (const id of shuffle([...(w.conf || [])])) if (out.length < n && ok(id)) { out.push(id); used.add(id); }
  const pool = S.posPool[mainPos(w) || 'x'] || S.posPool['adj.'];
  for (let tries = 0; out.length < n && tries < 80; tries++) {
    const id = pick(pool);
    if (ok(id)) { out.push(id); used.add(id); }
  }
  // tiny parts of speech (conj. 2, prep. 3 words) can't fill four options: borrow adverbs and
  // phrases, then anything, so a question never shows a lone answer
  const wide = [[...(S.posPool['adv.'] || []), ...(S.posPool['phr.'] || [])], S.words.map((x) => x.id)];
  for (const more of wide) {
    for (let tries = 0; out.length < n && more.length && tries < 80; tries++) {
      const id = pick(more);
      if (ok(id)) { out.push(id); used.add(id); }
    }
  }
  return out;
}
function formRegex(word) {
  const base = word.toLowerCase();
  if (/\s/.test(base)) return new RegExp('\\b' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+') + '\\b', 'i');
  let stem = base;
  if (stem.length > 4 && /[ey]$/.test(stem)) stem = stem.slice(0, -1);
  return new RegExp('\\b(' + stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[a-z]*)\\b', 'i');
}
// Book cloze blanks are often inflected (envisaged, precursors, intercepting); exam-style options always come
// in the form that fits, so distractors get the same ending. Rules only: when any distractor would need
// a guess (irregular verb, a final consonant that may double, an irregular plural) every option stays
// in its base form, so no option stands out.
const IRREG_VERBS = new Set('arise awake be bear beat become begin behold bend beset bet bid bind bite bleed blow break breed bring build burst buy cast catch choose cling come cost creep cut deal dig do draw drink drive dwell eat fall feed feel fight find flee fling fly forbid forbear forecast foresee foretell forget forgive forgo forsake freeze get give go grind grow hang have hear hew hide hit hold hurt keep kneel know lay lead leave lend let lie light lose make mean meet mislay mislead mistake mow outdo overcome overdo overhear override overrun oversee overtake overthrow partake pay put quit read rend rid ride ring rise run saw say see seek sell send set sew shake shear shed shine shoot show shrink shut sing sink sit slay sleep slide sling slink slit smite sow speak speed spend spin spit split spread spring stand steal stick sting stink stride strike string strive swear sweep swell swim swing take teach tear tell think throw thrust tread undergo understand undertake undo uphold upset wake wear weave wed weep win wind withdraw withhold withstand wring write'.split(' '));
const sylls = (x) => (x.replace(/e$/, '').match(/[aeiouy]+/g) || []).length;
const endsCVC = (x) => /[^aeiou][aeiou][^aeiouwxy]$/.test(x);
// longer verbs whose stressed last syllable doubles the consonant (omitted, compelled, deterred)
const DOUBLE_LONG = new Set('abet abhor acquit admit annul aver begin befit commit compel concur confer control decontrol defer demur deter dispel emit enrol equip excel expel extol incur infer inter outwit patrol permit prefer propel rebel recur refer regret remit repel submit transfer transmit occur omit'.split(' '));
const NO_PLURAL = /(is|us|um|f|fe|o|ex|ix|ia|ae|ies|eus|ics|ness|ship|ment|[^s]s)$/;   // odds, news
const IRREG_PLURAL = new Set('phenomenon criterion automaton person child man woman foot tooth mouse goose ox die penny'.split(' '));
// true: double the final consonant; false: don't; null: can't tell
function doubles(b) {
  if (!endsCVC(b)) return false;
  if (sylls(b) === 1) return true;
  if (DOUBLE_LONG.has(b)) return true;
  if (/(er|or|en|on|it|et|el|al|op|om|ip|ish|age)$/.test(b)) return false;   // unstressed: offered, edited, labeled (US)
  return null;
}
function inflectForm(base, kind) {
  const b = base.toLowerCase();
  if (!/^[a-z]+$/.test(b)) return null;
  if (kind === 's') {
    if (NO_PLURAL.test(b) || IRREG_PLURAL.has(b)) return null;
    if (/[^aeiou]y$/.test(b)) return b.slice(0, -1) + 'ies';
    if (/(s|x|z|ch|sh)$/.test(b)) return b + 'es';
    return b + 's';
  }
  if (kind === 'ed' && (IRREG_VERBS.has(b) || IRREG_VERBS.has(b.replace(/^(over|under|out|mis|fore|with|up|re|be|for)/, '')))) return null;   // oversell
  if (/ic$/.test(b)) return b + 'k' + (kind === 'ed' ? 'ed' : 'ing');   // panicked, mimicking
  const dbl = doubles(b);
  if (dbl === null) return null;
  const stem = dbl ? b + b.slice(-1) : b;
  if (kind === 'ed') {
    if (/e$/.test(b)) return b + 'd';
    if (/[^aeiou]y$/.test(b)) return b.slice(0, -1) + 'ied';
    return stem + 'ed';
  }
  if (kind === 'ing') {
    if (/ie$/.test(b)) return b.slice(0, -2) + 'ying';
    if (/[^eioy]e$/.test(b)) return b.slice(0, -1) + 'ing';
    return stem + 'ing';
  }
  return null;
}
function inflectKind(base, hit) {
  const b = base.toLowerCase(), h = hit.toLowerCase();
  if (h === b) return '';
  for (const k of ['ed', 'ing', 's']) if (inflectForm(b, k) === h) return k;
  // the target's own form is taken from the sentence, so an irregular target is fine
  if (/ed$/.test(h) && !/ed$/.test(b)) return 'ed';
  if (/ing$/.test(h) && !/ing$/.test(b)) return 'ing';
  if (/s$/.test(h) && h.length <= b.length + 2) return 's';
  return null;
}
// abstract nouns that are rarely plural (humility, clarity, individualism)
const MASSY = /(ity|ism|cy|ance|ence|tion|sion|ment|ness|ship|dom|hood|ery|try|ure|ia|th|age|ics|ude|ice|ing|prose)$/;
const MASS_WORDS = new Set('thrift upkeep acumen autonomy candor rigor ardor fervor valor pallor rancor torpor languor vigor squalor stupor splendor clamor largesse wherewithal equipment information advice knowledge evidence hubris'.split(' '));
const hasPos = (x, re) => (x.senses || []).some((sn) => re.test(sn.pos || ''));
function clozeOptionTexts(w, hit, ds, pos = '') {
  const kind = inflectKind(w.w, hit);
  if (!kind) return null;
  const verb = /^v/.test(pos), noun = /^n/.test(pos);
  if ((kind === 'ed' || kind === 'ing') && !verb) return null;   // an adjective in -ed/-ing is its own word
  if (kind === 's' && !verb && !noun) return null;
  const re = verb ? /^v/ : /^n/;
  if (!ds.every((x) => hasPos(x, re) && (verb || !(MASSY.test(x.w.toLowerCase()) || MASS_WORDS.has(x.w.toLowerCase()))))) return null;
  const forms = ds.map((x) => inflectForm(x.w, kind));
  return forms.every(Boolean) ? { target: hit.toLowerCase(), forms } : null;
}
// Pick-the-synonym (sentence-equivalence style items train word -> synonym in English): the entry's own
// synonyms, single words only, never the word itself or a form of it
function synOptions(w) {
  const re = formRegex(w.w);
  return [...new Set((w.syn || []).map((x) => String(x).trim().toLowerCase()))].filter((x) => /^[a-z][a-z-]{2,}$/.test(x) && !re.test(x));
}
// The synonyms a question may use as its answer. A word added because the book lists it as a
// synonym (近义词补充) is paired with the bank words that list it, the link 六选二 and two-blank items need.
function synAnswers(w) {
  if (w.synOf?.length) {
    const names = new Set(S.words.map((y) => y.w.toLowerCase()));
    const out = w.synOf.map((x) => x.toLowerCase()).filter((x) => names.has(x));
    if (out.length) return out;
  }
  return synOptions(w);
}
// New-word checks: 近义词补充 words are checked by picking their synonym, the rest by meaning.
// Like other new words, familiar ones are tested first and rare ones get the card first.
const firstCheck = (id) => { const w = S.byId.get(id); return w?.synOf?.length && synAnswers(w).length ? 'mc_syn' : 'mc_en2zh'; };
function bookCloze(w) {
  const re = formRegex(w.w);
  const cands = [];
  for (const s of testSenses(w)) for (const ex of s.ex || []) {
    const t = (ex.en || '').trim();
    if (t && re.test(t) && t.split(/\s+/).length >= 8 && /[.!?]["”’']?$/.test(t)) cands.push({ ex, s });
  }
  if (!cands.length) return null;
  return pick(cands);
}

// English definitions for the tested sense, from the book and (when aligned) from MW; the source
// rotates so a memorised wording is not what gets tested. Definitions that give the word away are skipped.
function englishDefs(w) {
  const t = senseFor(w);
  const re = formRegex(w.w);
  const out = [];
  if (t.en) out.push({ text: t.en, src: '书' });
  const m = mwFor(w);
  if (m && m.conf !== 'low' && m.def) out.push({ text: m.def, src: 'MW ' + m.sid.split('#')[0] });
  return out.filter((d) => d.text.split(' ').length >= 3 && !re.test(d.text));
}
function buildQuestion(item) {
  const w = S.byId.get(item.id);
  const lv = item.lv;
  const hasEn = !!w.senses[0]?.en;
  const ai = S.L.ai[w.id]?.qs?.filter((q) => !q.used) || [];
  let type = item.type;
  if (!type) {
    if (lv <= 2 || !hasEn) type = lv <= 2 ? 'mc_en2zh' : 'mc_zh2en';
    else if (lv === 3) type = pick(['mc_zh2en', englishDefs(w).length ? 'mc_def2word' : 'mc_zh2en', bookCloze(w) ? 'cloze_book' : 'mc_zh2en', ai.length ? 'ai_cloze' : 'mc_zh2en', synAnswers(w).length ? 'mc_syn' : 'mc_zh2en']);
    else {
      const opts = [];
      if (ai.length) opts.push('ai_cloze', 'ai_cloze');
      if (S.L.prefs.typing && !S.session?.quick) opts.push('type_meaning', 'type_meaning');
      if (bookCloze(w)) opts.push('cloze_book');
      if (englishDefs(w).length) opts.push('mc_def2word');
      if (synAnswers(w).length) opts.push('mc_syn');
      opts.push('mc_zh2en');
      type = pick(opts);
    }
  }
  if (type === 'ai_cloze' && !ai.length) type = bookCloze(w) ? 'cloze_book' : 'mc_zh2en';
  if (type === 'cloze_book' && !bookCloze(w)) type = 'mc_zh2en';
  if (type === 'mc_def2word' && !englishDefs(w).length) type = 'mc_zh2en';
  if (type === 'mc_syn' && !synAnswers(w).length) type = 'mc_zh2en';
  if (type === 'type_meaning' && (!S.L.prefs.typing || S.session?.quick)) type = 'mc_zh2en';
  // a word added with Merriam-Webster's senses only (中文待补) is asked through its English definition
  if (!zhGloss(senseFor(w)) && (type === 'mc_en2zh' || type === 'mc_zh2en' || type === 'type_meaning')) type = englishDefs(w).length ? 'mc_def2word' : bookCloze(w) ? 'cloze_book' : 'mc_def2word';

  const q = { type, w, lv, item, start: 0 };
  const sense = senseFor(w);
  const conf = confusionsOf(w.id);
  const must = item.with || (conf.length && Math.random() < 0.6 ? [pick(conf)] : []);
  if (type === 'mc_en2zh') {
    const ds = distractorIds(w, 3, { must, prefer: item.check ? S.session?.metNew?.() : null }).map((id) => S.byId.get(id));
    const opts = shuffle([{ id: w.id, text: zhGloss(sense) }, ...ds.map((x) => ({ id: x.id, text: zhGloss(senseFor(x)) }))]);
    q.opts = opts; q.answer = opts.findIndex((o) => o.id === w.id); q.sense = sense;
  } else if (type === 'mc_zh2en') {
    const ds = distractorIds(w, 3, { must }).map((id) => S.byId.get(id));
    const opts = shuffle([{ id: w.id, text: w.w }, ...ds.map((x) => ({ id: x.id, text: x.w }))]);
    q.opts = opts; q.answer = opts.findIndex((o) => o.id === w.id); q.sense = sense; q.en = true;
  } else if (type === 'mc_syn') {
    // the right option is one of the word's synonyms; the others are bank words that aren't
    const answers = synAnswers(w);
    const syn = pick(answers);
    const lw = w.w.toLowerCase();
    const ds = distractorIds(w, 6, { must }).map((id) => S.byId.get(id)).filter((x) => { const xl = x.w.toLowerCase(); return !answers.includes(xl) && !synOptions(x).includes(syn) && !synOptions(x).includes(lw) && !(x.synOf || []).some((t) => t.toLowerCase() === lw); });
    const opts = shuffle([{ id: 'syn:' + syn, text: syn }, ...ds.slice(0, 3).map((x) => ({ id: x.id, text: x.w }))]);
    q.opts = opts; q.answer = opts.findIndex((o) => o.id === 'syn:' + syn); q.sense = sense; q.en = true;
  } else if (type === 'mc_def2word') {
    const defs = englishDefs(w);
    const last = S.L.defSrc?.[w.id];
    const d = defs.find((x) => x.src !== last) || defs[0];
    (S.L.defSrc ||= {})[w.id] = d.src;
    q.def = d; q.sense = sense; q.en = true;
    const ds = distractorIds(w, 3, { must }).map((id) => S.byId.get(id));
    const opts = shuffle([{ id: w.id, text: w.w }, ...ds.map((x) => ({ id: x.id, text: x.w }))]);
    q.opts = opts; q.answer = opts.findIndex((o) => o.id === w.id);
  } else if (type === 'cloze_book') {
    const { ex, s } = bookCloze(w);
    const m = ex.en.match(formRegex(w.w));
    q.sentence = ex.en; q.hit = m[0]; q.zh = ex.zh; q.sense = s;
    const ds = distractorIds(w, 3, { must }).map((id) => S.byId.get(id));
    const inf = clozeOptionTexts(w, m[0], ds, s.pos);
    const opts = shuffle([{ id: w.id, text: inf ? inf.target : w.w }, ...ds.map((x, i) => ({ id: x.id, text: inf ? inf.forms[i] : x.w }))]);
    q.opts = opts; q.answer = opts.findIndex((o) => o.id === w.id); q.en = true;
  } else if (type === 'ai_cloze') {
    const a = ai[0];
    a.used = true;
    q.sentence = a.q; q.zh = a.zh; q.why = a.why; q.sense = sense; q.en = true;
    q.opts = a.opts.map((t, i) => ({ id: i === a.a ? w.id : 'x' + i, text: t }));
    q.answer = a.a; q.ai = true;
    saveLocal();
  } else if (type === 'type_meaning') {
    q.sense = sense;
  }
  return q;
}

// ---------- sessions ----------
function introducedToday() {
  const today = dayKey();
  return Object.values(S.L.cards).filter((c) => c.intro && dayKey(c.intro) === today).length;
}
function dueIds(now = Date.now(), filter = null) {
  const out = [];
  for (const [id, c] of Object.entries(S.L.cards)) {
    if (!c.st || !S.byId.has(id)) continue;
    if (filter && !filter(S.byId.get(id))) continue;
    if (c.due <= now) out.push(id);
  }
  out.sort((a, b) => {
    const A = S.L.cards[a], B = S.L.cards[b];
    return retrievability((now - A.last) / DAY, A.s) - retrievability((now - B.last) / DAY, B.s);
  });
  return out;
}
const unseen = (id) => { const c = S.L.cards[id]; return !c || (!c.st && !c.intro); };
function newIds(n, filter = null) {
  const out = [];
  for (const id of S.newOrder) {
    if (out.length >= n) break;
    if (!unseen(id)) continue;
    if (filter && !filter(S.byId.get(id))) continue;
    out.push(id);
  }
  return out;
}
function screenIds(n) {
  const out = [];
  for (const id of S.newOrder) { if (out.length >= n) break; if (unseen(id) && S.byId.get(id)?.scr) out.push(id); }
  return out;
}
function dailyNewToday(dueCount) {
  const set = S.L.prefs.dailyNew | 0;
  if (!S.L.prefs.autoNew) return set;
  const over = dueCount - 4 * set;
  return over > 0 ? Math.max(Math.min(15, set), set - Math.ceil(over / 4)) : set;
}
// New words come in book order. Screenable ones (familiar exam-band or high-frequency words) are
// tested before any learning and don't count toward the daily quota unless they fail.
// Seen but never checked (the session ended before the follow-up): no longer new, not yet scheduled.
// They'd fall through the cracks, so every session starts by checking them.
function pendingIds() {
  return Object.entries(S.L.cards).filter(([id, c]) => c.intro && !c.st && S.byId.has(id)).sort((a, b) => a[1].intro - b[1].intro).map(([id]) => id);
}
// Words you add yourself (加入今日复习, 查词 additions, practice misses) don't push out the book's new
// words: each one raises today's quota by one. Kept in prefs so both devices agree.
function extraToday() {
  const b = S.L.prefs.boostDay, x = S.L.prefs.extraDay;
  return (b?.d === dayKey() ? (b.ids || []).length : 0) + (x?.d === dayKey() ? (x.n | 0) + (x.pad | 0) : 0);
}
function addedToday() {   // what the home count shows as "你加的": the top-up below isn't the user's
  const x = S.L.prefs.extraDay;
  return extraToday() - (x?.d === dayKey() ? x.pad | 0 : 0);
}
// "再来 15 词" once the day is done: raises today's quota only, tomorrow stays at the daily setting.
const MORE_N = 15;
function moreToday() {
  const p = S.L.prefs;
  const x = p.extraDay?.d === dayKey() ? p.extraDay : { n: 0, pad: 0 };
  // failed screens count as introduced, so the day can already be over quota: top that up first
  const over = Math.max(0, introducedToday() - todayPlan().daily - extraToday());
  S.L.prefs = { ...p, extraDay: { d: dayKey(), n: (x.n | 0) + MORE_N, pad: (x.pad | 0) + over }, u: Date.now() };
  S.L.dirtyP = true; saveLocal(); schedulePush(true);
  startSession('normal');
}
function pullForward(id) {
  const p = S.L.prefs;
  const today = p.boostDay?.d === dayKey() ? p.boostDay.ids || [] : [];
  const fresh = !S.L.cards[id]?.st && !S.L.cards[id]?.intro;
  S.L.prefs = { ...p, boost: [id, ...(p.boost || []).filter((x) => x !== id)].slice(0, 100), ...(fresh && !today.includes(id) ? { boostDay: { d: dayKey(), ids: [...today, id] } } : {}), u: Date.now() };
  S.L.dirtyP = true; buildNewOrder(); saveLocal(); schedulePush(true);
}
function todayPlan() {
  const pending = pendingIds();
  const due = [...pending, ...dueIds()];
  const daily = dailyNewToday(due.length);
  const left = Math.max(0, daily + extraToday() - introducedToday());
  const fresh = [], screens = [];
  for (const id of S.newOrder) {
    if (fresh.length >= left) break;
    if (!unseen(id)) continue;
    if (S.byId.get(id)?.scr && !(S.L.prefs.boost || []).includes(id)) { if (screens.length < SCREEN_PER_SESSION) screens.push(id); }
    else fresh.push(id);
  }
  return { due, fresh, screens, daily, pending };
}

function startSession(kind = 'normal') {
  S._conf = null;
  let reviews = [], fresh = [], screens = [];
  const quick = kind === 'quick';
  let pendingSet = new Set();
  if (kind === 'normal' || kind === 'quick') { const p = todayPlan(); reviews = p.due.slice(0, 400); fresh = p.fresh; screens = p.screens; pendingSet = new Set(p.pending); }
  else if (kind === 'screen') screens = screenIds(60);
  else if (kind === 'conf') {
    const groups = shuffle(S.groups.filter((g) => g.every((id) => S.byId.has(id)))).slice(0, 10);
    reviews = groups.flat();
  } else if (kind === 'trap') {
    const isTrap = (w) => w.tags.includes('trap');
    reviews = dueIds(Date.now(), isTrap).slice(0, 60);
    if (reviews.length < 30) reviews.push(...shuffle(Object.keys(S.L.cards).filter((id) => S.L.cards[id].st && isTrap(S.byId.get(id) || { tags: [] }) && !reviews.includes(id))).slice(0, 30 - reviews.length));
    if (reviews.length < 20) fresh = newIds(20 - reviews.length, isTrap);
  } else if (kind === 'focus') {
    reviews = (S.focusIds || []).filter((id) => S.byId.has(id));
  }
  const items = [];
  const checks = [];
  const R = reviews.map((id) => (pendingSet.has(id) ? (S.L.cards[id]?.uq ? { id, lv: 3, forceType: usageType(S.byId.get(id)), check: true } : { id, lv: 2, forceType: firstCheck(id), check: true }) : { id, lv: kind === 'conf' ? 2 : Math.max(2, levelOf(S.L.cards[id])), forceType: kind === 'conf' ? pick(['mc_en2zh', 'mc_zh2en']) : null }));
  // New words split by prior difficulty. Likely-known words (df < 0.6) are tested first: guessing
  // first and seeing the answer helps memory, and known words skip the card. Likely-unknown words
  // (rare, exam-level) get the card first, since a pre-test there would be blind guessing; their check
  // comes a few items later with distractors from the same batch. Screenable words keep the timed skip.
  const N = [...fresh.map((id) => ((S.byId.get(id)?.df ?? 0.5) >= LEARN_FIRST_DF ? { id, lv: 1, learn: true } : { id, lv: 2, pre: true, type: firstCheck(id) })),
    ...screens.map((id) => ({ id, lv: 2, screen: true, type: firstCheck(id) }))]
    .sort((a, b) => S.newOrder.indexOf(a.id) - S.newOrder.indexOf(b.id));
  while (R.length || N.length || checks.length) {
    if (checks.length && items.length >= checks[0].at) { checks.sort((a, b) => a.at - b.at); items.push(checks.shift().item); continue; }
    if (N.length && (items.length % 4 === 3 || !R.length)) {
      const n = N.shift(); items.push(n);
      if (n.learn) {
        checks.push({ at: items.length + 3 + Math.floor(Math.random() * 3), item: { id: n.id, lv: 2, check: true, type: firstCheck(n.id) } });
        // words that are hard a priori get a second, practice-only check later in the session
        if ((S.byId.get(n.id)?.df ?? 0.5) >= 0.75) checks.push({ at: items.length + 9 + Math.floor(Math.random() * 4), item: { id: n.id, lv: 2, type: 'mc_zh2en', extra: true } });
        checks.sort((a, b) => a.at - b.at);
      }
      continue;
    }
    if (R.length) { const r = R.shift(); items.push({ id: r.id, lv: r.lv, type: r.forceType, ...(r.check ? { check: true } : {}) }); continue; }
    items.push(checks.shift().item);
  }
  if (!items.length) { toast(kind === 'normal' || kind === 'quick' ? L('今天的任务已经完成了', 'You’re done for today') : kind === 'screen' ? L('可筛的词都筛完了', 'No words left to screen') : L('这一组暂时没有可练的词', 'Nothing to practise in this set right now')); return; }
  const sid = dayKey() + '-' + rid();
  S.L.sessions[sid] = { sid, date: dayKey(), start: Date.now(), kind, items: [] };
  S.session = { sid, kind, quick, items, idx: 0, retries: {}, done: 0, right: 0, q: null, answered: null };
  // new words met so far in this session: the pool for post-learn check distractors
  S.session.metNew = () => S.session.items.slice(0, S.session.idx).filter((it) => it.pre || it.screen || it.learn).map((it) => it.id);
  if (S.sample && !S.aiOff && (kind === 'normal' || kind === 'focus' || kind === 'trap')) prefetchAiQuestions(items);
  showQuestion();
}

function logAnswer(entry) {
  const s = S.L.sessions[S.session.sid];
  // e: a stable id so a synced log never counts an answer twice; av: which rules produced the grade
  s.items.push({ t: Date.now(), e: Date.now().toString(36) + rid(), av: ALGO_VERSION, ...entry });
  S.L.dirtyS[S.session.sid] = 1;
  if (entry.ci && S._conf) addConf(entry.i, entry.ci);
}
// Words you've mixed up: picking B's option for A links A and B both ways. Built from the logs, so it
// syncs with them; rebuilt at each session start to pick up other devices.
function addConf(a, b) {
  for (const [x, y] of [[a, b], [b, a]]) { if (!S._conf.has(x)) S._conf.set(x, new Set()); S._conf.get(x).add(y); }
}
function confusionsOf(id) {
  if (!S._conf) {
    S._conf = new Map();
    for (const s of Object.values(S.L.sessions)) for (const it of s.items || []) if (it.ci && !it.fl) addConf(it.i, it.ci);
  }
  return [...(S._conf.get(id) || [])].filter((x) => S.byId.has(x));
}
// After answering, every option says what it is (passive, not a lookup); tapping one opens its card,
// which is a deliberate lookup. Options outside the word bank open a Merriam-Webster lookup.
function optionWordId(q, j) {
  const o = q.opts[j];
  if (S.byId.has(o.id)) return o.id;
  return q.en ? findInBank(o.text.toLowerCase())?.id || null : null;
}
function glossOption(b, q, j) {
  const id = optionWordId(q, j), x = id && S.byId.get(id);
  let t = '';
  const base = x && q.en && x.w.toLowerCase() !== q.opts[j].text.toLowerCase() ? `← ${x.w}：` : '';
  if (x) t = q.en ? base + zhGloss(senseFor(x)) : j === q.answer ? '' : x.w;
  else if (q.en) t = L('不在词库 · 点开查 MW', 'Not in your words · tap to look up in MW');
  if (!t) return;
  const g = document.createElement('span');
  g.className = 'gloss'; g.textContent = t;
  b.querySelector('.v').append(g);
}
function openOption(j) {
  const q = S.session?.q;
  if (!q?.opts?.[j]) return;
  cancelAuto();
  const id = optionWordId(q, j);
  if (id) openWord(id);
  else if (q.en) openLookup(q.opts[j].text);
}
// the bank word behind a picked option (AI cloze options are plain text)
function pickedWordId(q, i) {
  if (i < 0 || i === q.answer) return null;
  const o = q.opts[i];
  if (S.byId.has(o.id) && o.id !== q.w.id) return o.id;
  const id = q.en ? bankByName().get(o.text.toLowerCase()) : null;
  return id && id !== q.w.id ? id : null;
}
// Outcomes that let a word skip its card: 斩 (screening, hard-word 斩, 斩 after reading) and "known"
// (pre-test right, screening right but slow). Any of them can be taken back while it still stands.
const SKIP_LOG = (x) => (x.k === 'screen' && (x.o === 'skip' || x.o === 'slow')) || (x.k === 'pre' && x.o === 'known') || x.k === 'zhan';
function skipStands(id) {
  const c = S.L.cards[id];
  if (!c?.st || c.us) return false;
  if (c.zh && c.last === c.zh) return true;   // 斩 by hand, not reviewed since
  if ((c.reps || 0) > 1) return false;
  for (const s of Object.values(S.L.sessions)) for (const it of s.items || []) if (it.i === id && !it.fl && !it.us && SKIP_LOG(it) && it.t >= (c.last || 0) - 60e3) return true;
  return false;
}
// 斩 by hand, any time: a word you know (answered right, or straight from its card) goes to a 45-day
// spot check. A reviewed word keeps its history and only gets the longer wait.
function zhanCard(id, now = Date.now()) {
  const { us, uq, ...c } = S.L.cards[id] || {};
  const due = dayStart(now) + SCREEN_DAYS * DAY;
  const base = c.st ? { ...c, s: Math.max(c.s || 0, SCREEN_DAYS), due: Math.max(c.due || 0, due) }
    : { ...(c.intro ? { intro: c.intro } : {}), s: SCREEN_DAYS, d: clampD(initD(4) + 2 * ((S.byId.get(id)?.df ?? 0.5) - 0.5)), reps: 1, lapses: 0, due };
  return { ...base, st: 2, last: now, u: now, day: dayKey(now), scr: 6, zh: now };
}
function dropLater(id) {
  const sess = S.session, out = [];
  if (!sess) return out;
  for (let j = sess.items.length - 1; j > sess.idx; j--) if (sess.items[j].id === id) out.unshift({ j, it: sess.items.splice(j, 1)[0] });
  return out;
}
function zhanFromAnswer(q) {
  const id = q.w.id, now = Date.now();
  q.zhanUndo = { card: S.L.cards[id], removed: dropLater(id), screen: q.screen };
  S.L.cards[id] = zhanCard(id, now);
  markDirty(id);
  logAnswer({ i: id, k: 'zhan', ok: 1, ms: 0, g: 0, o: 'skip', from: q.type });
  q.zhanUndo.entry = S.L.sessions[S.session.sid].items.at(-1);
  q.screen = 'zhanned';
  saveLocal(); schedulePush();
}
function undoZhanFromAnswer(q) {
  const u = q.zhanUndo, id = q.w.id, s = S.session;
  if (!u) return;
  if (u.card) S.L.cards[id] = { ...u.card, u: Date.now() }; else delete S.L.cards[id];
  markDirty(id);
  for (const r of u.removed) s.items.splice(Math.min(r.j, s.items.length), 0, r.it);
  u.entry.fl = 1; S.L.dirtyS[s.sid] = 1;
  q.screen = u.screen; q.zhanUndo = null;
  saveLocal(); schedulePush();
}
// recognizing the meaning is what got it skipped, so the check asks for usage instead
function usageType(w) {
  if (S.L.ai[w.id]?.qs?.some((q) => !q.used)) return 'ai_cloze';
  if (bookCloze(w)) return 'cloze_book';
  return englishDefs(w).length ? 'mc_def2word' : 'mc_zh2en';
}
function relearn(id) {
  const now = Date.now();
  S.L.cards[id] = { intro: now, u: now, st: 0, uq: 1, us: now };
  markDirty(id);
  for (const s of Object.values(S.L.sessions)) for (const it of s.items || []) if (it.i === id && SKIP_LOG(it) && !it.us) { it.us = 1; S.L.dirtyS[s.sid] = 1; }
  const sess = S.session;
  if (sess) {
    logAnswer({ i: id, k: 'unskip', ok: 1, ms: 0, g: 0 });
    for (let j = sess.items.length - 1; j > sess.idx; j--) if (sess.items[j].id === id) sess.items.splice(j, 1);
    const at = Math.min(sess.items.length, sess.idx + 3 + Math.floor(Math.random() * 3));
    sess.items.splice(at, 0, { id, lv: 3, check: true, type: usageType(S.byId.get(id)) });
  }
  saveLocal(); schedulePush();
}
// a follow-up item for a missed word puts the word you picked back among its options
const withPick = (item, q) => (q.pickedId ? { ...item, with: [q.pickedId] } : item);

function finishItem(q, { ok, partial = false, noGrade = false, chosen = null, known = false }) {
  const sess = S.session;
  const now = Date.now();
  const ms = now - q.start; q.answeredAt = now;
  const kind = KIND[q.type];
  if (q.type !== 'type_meaning') recordTime(kind, ms, q.type);
  const id = q.w.id;
  const card = S.L.cards[id] || {};
  q.prev = { ...card }; q.prevHad = id in S.L.cards;
  // memory state right before the answer, logged for later evaluation of the scheduler
  const pre = card.st && card.s ? { s0: +card.s.toFixed(3), d0: +card.d.toFixed(3), r0: +retrievability(Math.max(0, (now - (card.last || now)) / DAY), card.s).toFixed(4) } : {};
  let g = 0, sch = false;
  const firstToday = card.day !== dayKey(now) || !card.st;
  const notDue = card.st && card.due > now;
  // A correct answer on the easiest item type is weak evidence for a word already past the
  // recognition stage, and practice drills shouldn't reschedule words that aren't due: neither
  // stretches the interval. Wrong answers always count.
  const weak = ok && card.st === 2 && (card.s >= 4 && q.type === 'mc_en2zh' || notDue);
  q.weak = weak;
  if (!q.item.retry && !q.item.extra && !noGrade && !weak && firstToday) {
    g = rate({ ok, ms, kind, type: q.type, lv: q.lv, known, def: q.def?.text });
    if (g === 4 && lookedUpRecently(id)) { g = 3; q.lookupCapped = true; }   // just saw the answer
    if (g === 4 && !card.st) g = 3;   // a word's first check (new, or taken back from a skip) starts at ~3 days
    S.L.cards[id] = fsrsReview(card, g, now, q.w.df ?? 0.5);
    markDirty(id); sch = true;
  } else if (!ok && card.st) {
    // repeat failures on the same day pull the due date back to tomorrow
    S.L.cards[id] = { ...card, due: Math.min(card.due, dayStart(now) + DAY), u: now };
    markDirty(id);
  }
  q.inserted = null;
  if (!ok) {
    sess.retries[id] = (sess.retries[id] || 0) + 1;
    if (sess.retries[id] <= 3) {
      const at = Math.min(sess.items.length, sess.idx + 4 + Math.floor(Math.random() * 3));
      q.inserted = withPick({ id, lv: 2, type: pick(['mc_en2zh', 'mc_zh2en']), retry: true }, q);
      sess.items.splice(at, 0, q.inserted);
    }
  } else if (noGrade) {
    // an uncertain verdict is settled by a different question a few items later, which counts
    const w = q.w;
    const at = Math.min(sess.items.length, sess.idx + 3 + Math.floor(Math.random() * 3));
    q.inserted = { id, lv: 3, type: w.senses[0]?.en && bookCloze(w) ? 'cloze_book' : 'mc_zh2en', retest: true };
    sess.items.splice(at, 0, q.inserted);
  }
  sess.done++; if (ok) sess.right++;
  logAnswer({ i: id, k: q.type, ok: ok ? 1 : 0, ms, g, ...(sch ? { sch: 1 } : {}), ...(q.lookupCapped ? { cap: 1 } : {}), ...pre, ...(partial ? { p: 1 } : {}), ...(chosen != null ? { c: chosen } : {}), ...(q.pickedId ? { ci: q.pickedId } : {}) });
  saveLocal();
  schedulePush();
  return g;
}

// Screening: one quick recognition item on the sense the book lists (the uncommon one when the
// familiar meaning is already covered). Fast and correct skips the word until a spot check.
function finishScreen(q, ok, chosen) {
  const sess = S.session;
  const now = Date.now();
  const ms = now - q.start;
  const id = q.w.id;
  q.prev = { ...(S.L.cards[id] || {}) }; q.prevHad = id in S.L.cards;
  let outcome;
  if (q.item.pre) {
    const guessy = ok && ms > Math.max(PRE_SLOW_MS, 1.6 * medType('mc', q.type));
    if (ok && !guessy) {
      // known before seeing the card: scheduled like a normal "know" (~3 days)
      S.L.cards[id] = { ...fsrsReview({}, 3, now, q.w.df ?? 0.5), intro: now };
      outcome = 'known';
    } else {
      // wrong, "don't know", or right but slow enough to look like a guess
      S.L.cards[id] = { intro: now, u: now, st: 0 };
      const at = Math.min(sess.items.length, sess.idx + 3 + Math.floor(Math.random() * 3));
      q.inserted = withPick({ id, lv: 2, check: true, type: firstCheck(id) }, q);
      sess.items.splice(at, 0, q.inserted);
      // words that are hard a priori get a second, practice-only check later in the session
      if ((q.w.df ?? 0.5) >= 0.75) sess.items.splice(Math.min(sess.items.length, at + 6 + Math.floor(Math.random() * 3)), 0, withPick({ id, lv: 2, type: 'mc_zh2en', extra: true }, q));
      outcome = guessy ? 'slow' : 'learn';
    }
    markDirty(id);
    sess.done++; if (ok) sess.right++;
    logAnswer({ i: id, k: 'pre', ok: ok ? 1 : 0, ms, g: outcome === 'known' ? 3 : 0, ...(outcome === 'known' ? { sch: 1 } : {}), o: outcome, ...(chosen != null ? { c: chosen } : {}), ...(q.pickedId ? { ci: q.pickedId } : {}) });
    saveLocal(); schedulePush();
    return outcome;
  }
  const hard = !!q.item.hard;
  q.lookBlocked = ok && ms <= screenMs() && lookedUpRecently(id);
  if (ok && ms <= screenMs() && !lookedUpRecently(id)) {
    S.L.cards[id] = { st: 2, s: SCREEN_DAYS, d: clampD(initD(4) + 2 * ((q.w.df ?? 0.3) - 0.5)), reps: 1, lapses: 0, due: dayStart(now) + SCREEN_DAYS * DAY, last: now, u: now, day: dayKey(now), scr: 1, ...(hard ? { intro: now } : {}) };
    outcome = 'skip';
    if (hard) dropQueued(id);
  } else if (hard && ok && ms > screenMs()) {
    // right but slow on a word that is hard a priori: likely a guess, so look at the card
    S.L.cards[id] = { intro: now, u: now, st: 0, scr: 3 };
    ensureCheck(q, id);
    outcome = 'learn'; q.hslow = true;
  } else if (ok) {
    S.L.cards[id] = { ...fsrsReview({}, 3, now, q.w.df ?? 0.3), scr: 2, ...(hard ? { intro: now } : {}) };
    outcome = 'slow';
    if (hard) dropQueued(id);
  } else {
    S.L.cards[id] = { intro: now, u: now, st: 0, scr: 3 };
    ensureCheck(q, id);
    outcome = 'learn';
  }
  markDirty(id);
  sess.done++; if (ok) sess.right++;
  logAnswer({ i: id, k: 'screen', ok: ok ? 1 : 0, ms, g: outcome === 'slow' ? 3 : 0, ...(outcome === 'slow' ? { sch: 1 } : {}), o: outcome, ...(hard ? { hd: 1 } : {}), ...(chosen != null ? { c: chosen } : {}), ...(q.pickedId ? { ci: q.pickedId } : {}) });
  saveLocal(); schedulePush();
  return outcome;
}
// A hard word's card queues a check (and maybe extra practice) at session start; once the word is
// skipped or known those go, and a word sent back to the card keeps the one already queued.
function dropQueued(id) {
  const sess = S.session;
  const out = [];
  for (let j = sess.items.length - 1; j > sess.idx; j--) if (sess.items[j].id === id && (sess.items[j].check || sess.items[j].extra)) out.unshift({ j, it: sess.items.splice(j, 1)[0] });
  return out;
}
function ensureCheck(q, id) {
  const sess = S.session;
  const j = sess.items.findIndex((it, k) => k > sess.idx && it.id === id && it.check);
  if (j > -1) { sess.items[j] = withPick(sess.items[j], q); return; }
  const at = Math.min(sess.items.length, sess.idx + 3 + Math.floor(Math.random() * 3));
  q.inserted = withPick({ id, lv: 2, check: true, type: firstCheck(id) }, q);
  sess.items.splice(at, 0, q.inserted);
}

// ---------- Merriam-Webster (through the "MW Dictionary" connector) ----------
// The book decides what to learn; MW is the authority on what a sense means; AI 助教 explains and
// tests on top of MW. Book data is never overwritten: MW results and their alignment to the book's
// senses live in me/mw/w/<id>, with me/mwidx listing which words have been looked up.
const MW_SERVER = 'MW Dictionary';
// Merriam-Webster policy for the open-source build (see docs/merriam-webster.md): look a word up only
// when the learner asks, keep results in memory for this visit, and never pass MW text to a model.
const MW_AUTO_PER_DAY = 0;     // no automatic lookups
const MW_PERSIST = false;      // no stored MW responses
const MW_TO_AI = false;        // MW text is shown to the learner only
// Merriam-Webster's brand guidelines require their logo (unmodified, ® visible, 50/100/125 px) wherever the
// API's content appears. It is loaded from dictionaryapi.com rather than redistributed in this repository.
const MW_LOGO = (url) => `<a class="mw-logo" href="${url}" target="_blank" rel="noopener" title="Merriam-Webster"><img class="mw-logo-light" src="https://dictionaryapi.com/images/info/branding-guidelines/MWLogo_LightBG_120x120_2x.png" width="50" height="50" alt="Merriam-Webster"><img class="mw-logo-dark" src="https://dictionaryapi.com/images/info/branding-guidelines/MWLogo_DarkBG_120x120_2x.png" width="50" height="50" alt="Merriam-Webster"><span class="mw-registration" aria-label="registered trademark">®</span></a>`;
const mwCredit = (word) => { const url = `https://www.merriam-webster.com/dictionary/${encodeURIComponent(word)}`; return `<div class="small muted mw-credit">${MW_LOGO(url)}<span>${L('释义来自', 'From')} <a href="${url}" target="_blank" rel="noopener">Merriam-Webster's Collegiate® Dictionary</a></span></div>`; };
const MW_DENIED = new Set(['server_not_connected', 'selection_required', 'needs_reauth', 'not_in_manifest', 'approval_required', 'blocked_by_policy', 'not_granted', 'capability_disabled', 'capability_removed', 'server_not_found', 'consent_required']);
S.mw = new Map();            // id -> MW doc, loaded on demand
S.mwIdx = {};                // id -> day looked up
S.mwPending = new Map();     // id -> promise

const MW_COPY = {
  server_not_connected: L('在设置里填入你的 Merriam-Webster key 后可以查词。', 'Add your Merriam-Webster key in Settings to look up words.'),
  selection_required: L('Merriam-Webster key 不对，请在设置里检查。', 'The Merriam-Webster key isn’t valid. Check it in Settings.'),
  needs_reauth: L('Merriam-Webster key 不对，请在设置里检查。', 'The Merriam-Webster key isn’t valid. Check it in Settings.'),
  not_in_manifest: L('这个页面没有获准使用 MW Dictionary。可以在页面的权限菜单里打开。', 'This page isn’t allowed to use MW Dictionary. You can turn it on in the page’s permissions menu.'),
  approval_required: L('这个页面使用 MW Dictionary 需要你的许可，下次查词时会再问。', 'This page needs your permission to use MW Dictionary; you’ll be asked again at your next lookup.'),
  blocked_by_policy: L('你的组织策略禁止使用这个连接器。', 'Your organization’s policy blocks this connector.'),
};
function mwState() {
  if (!window.vocabRuntime?.config?.mw?.dict) return { ok: false, msg: L('在设置里填入你的 Merriam-Webster key 后可以查词（免费申请）。', 'Add your Merriam-Webster key in Settings to look up words (it’s free).') };
  if (!S.mcp) return { ok: false, msg: L('词典服务暂时不可用。', 'The dictionary is unavailable right now.') };
  if (S.mwOff) return { ok: false, msg: MW_COPY[S.mwOff] || L('MW 暂时不可用。', 'MW is unavailable right now.') };
  return { ok: true };
}
function mwCountToday() {
  const k = dayKey();
  if (S.L.mwCount?.day !== k) S.L.mwCount = { day: k, n: 0 };
  return S.L.mwCount;
}

const STOP = new Set('a an the of to or and in on for with by as at from that which who whom be is are was were been being something someone one oneself especially usually often its it this into than such not no very more most any act state quality condition way manner'.split(' '));
const stemTok = (t) => t.replace(/(ings?|ed|es|s|ly|ness|ment|ity)$/, '').slice(0, 7);
const toks = (s) => (String(s || '').toLowerCase().replace(/\([^)]*\)/g, ' ').match(/[a-z]+/g) || []).filter((t) => t.length > 2 && !STOP.has(t)).map(stemTok);
function textSim(a, b) {
  const A = new Set(toks(a)), B = new Set(toks(b));
  if (!A.size || !B.size) return 0;
  let n = 0; for (const x of A) if (B.has(x)) n++;
  return 0.7 * n / Math.min(A.size, B.size) + 0.3 * n / Math.max(A.size, B.size);
}
const POS_FL = { 'n.': 'noun', 'adj.': 'adjective', 'a.': 'adjective', 'adv.': 'adverb', 'v.': 'verb', 'v.t.': 'verb', 'v.i.': 'verb', 'vt.': 'verb', 'vi.': 'verb', 'prep.': 'preposition', 'conj.': 'conjunction' };
function mwSenses(doc) {
  const out = [];
  for (const e of doc?.entries || []) {
    for (const sn of e.senses || []) out.push({ ...sn, fl: e.fl, entry: e.id });
    for (const d of e.dros || []) for (const sn of d.senses || []) out.push({ ...sn, fl: 'phrase', entry: e.id, phrase: d.phrase });
  }
  return out;
}
const normEx = (s) => String(s || '').toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
// Text alignment: English definition overlap + part of speech + shared example sentences.
function alignByText(bookSense, doc) {
  const want = POS_FL[(bookSense.pos || '').split(/[&/]/)[0]] || '';
  const bookEx = (bookSense.ex || []).map((x) => normEx(x.en)).filter((x) => x.length > 8);
  const scored = mwSenses(doc).map((m) => {
    let sc = textSim(bookSense.en, m.def + ' ' + (m.sub?.def || ''));
    if (want && m.fl === want) sc += 0.1;
    else if (want && m.fl !== 'phrase') sc -= 0.25;
    if (m.archaic) sc -= 0.15;
    // dictionaries share example sentences, often lightly edited ("has a list" / "had a heavy list")
    const mex = [...(m.ex || []), ...(m.sub?.ex || [])].map(normEx);
    if (bookEx.some((b) => mex.some((x) => x && (x.includes(b) || b.includes(x) || textSim(b, x) >= 0.6)))) sc += 0.4;
    return { sid: m.sid, sc };
  }).sort((a, b) => b.sc - a.sc);
  if (!scored.length) return null;
  const [best, second] = scored;
  const margin = best.sc - (second?.sc || 0);
  const conf = best.sc >= 0.55 && margin >= 0.15 ? 'high' : best.sc >= 0.35 && margin >= 0.08 ? 'mid' : 'low';
  return { sid: best.sid, conf, by: 'text', sc: +best.sc.toFixed(2) };
}
async function alignByAI(w, bookSense, doc) {
  const lines = mwSenses(doc).filter((m) => m.def).slice(0, 45).map((m) => `${m.sid} | ${m.phrase || m.fl} | ${m.sn || '-'} | ${m.def}${m.sub ? ` (${m.sub.sd}: ${m.sub.def})` : ''}${m.archaic ? ' [archaic]' : ''}`).join('\n');
  const prompt = `Match a vocabulary list's sense of "${w.w}" to the Merriam-Webster sense it describes, and check the book's Chinese gloss against that MW sense.
Book sense: ${bookSense.pos} | 中文: ${bookSense.zh} | English: ${bookSense.en}${bookSense.ex?.[0]?.en ? ` | example: ${bookSense.ex[0].en}` : ''}
Merriam-Webster senses (id | part of speech | number | definition):
${lines}
Reply with only JSON: {"sid":"best matching id or null","confidence":"high|medium|low","zhAccurate":true or false,"zhSuggest":"if the Chinese gloss is inaccurate or misleading for this MW sense, a better Chinese gloss; otherwise empty","note":"${L('一句中文说明，没有可留空', 'one short sentence in English, or empty')}"}`;
  const r = await S.sample.json(prompt, { modelTier: 'quick' });
  const ok = mwSenses(doc).some((m) => m.sid === r?.sid);
  return {
    sid: ok ? r.sid : null,
    conf: ok ? ({ high: 'high', medium: 'mid' }[r.confidence] || 'low') : 'low',
    by: 'ai',
    ...(r?.zhAccurate === false && r?.zhSuggest ? { zhFix: String(r.zhSuggest).slice(0, 60) } : {}),
    ...(r?.note ? { note: String(r.note).slice(0, 80) } : {}),
  };
}
const senseKey = (s) => `${s.pos || ''}|${s.zh}`;
// Which book senses get aligned: the tested one first, then the rest (text only for those).
function bookSensesToAlign(w) {
  const all = [...w.senses, ...(w.trapSenses || []).filter((t) => !w.senses.some((s) => senseKey(s) === senseKey(t)))];
  return all.filter((s) => s.en).slice(0, 6);
}
async function alignDoc(w, doc) {
  if (!MW_TO_AI) return [];
  const target = senseFor(w);
  const out = [];
  for (const bs of bookSensesToAlign(w)) {
    let a = alignByText(bs, doc);
    const isTarget = bs === target || senseKey(bs) === senseKey(target);
    if (isTarget && (!a || a.conf === 'low') && S.sample && !S.aiOff) {
      try { a = await alignByAI(w, bs, doc); } catch (e) { if (e?.code === 'not_granted') S.aiOff = true; }
    }
    if (a) out.push({ key: senseKey(bs), zh: bs.zh, ...a, ...(isTarget ? { target: true } : {}) });
  }
  return out;
}
// MW sense chosen for a book sense, or null
function mwFor(w, bookSense) {
  const doc = S.mw.get(w.id);
  const k = senseKey(bookSense || senseFor(w));
  const a = doc?.align?.find((x) => (x.key || x.zh) === k);
  if (!a?.sid) return null;
  const m = mwSenses(doc).find((x) => x.sid === a.sid);
  return m ? { ...m, conf: a.conf, by: a.by, zhFix: a.zhFix, note: a.note } : null;
}
function mwThesWords(id) {
  const doc = S.mw.get(id);
  const out = new Set();
  for (const t of doc?.thes || []) for (const sn of t.senses || []) for (const k of ['syn', 'rel', 'near']) for (const x of sn[k] || []) out.add(x.toLowerCase());
  return out;
}

async function loadMwIdx() {
  if (!MW_PERSIST) return;
  if (!S.db) return;
  try { const d = await S.db.doc('me/mwidx').get(); S.mwIdx = d.exists ? (d.data().ids || {}) : {}; } catch (e) { /* not fatal */ }
}
// What gets cached per word is trimmed to stay small (artifact storage is about 20 MB in all):
// one example per sense, capped synonym lists, short etymology, at most 6 phrases.
function slimMw(payload) {
  const sense = (x) => {
    const o = { sid: x.sid, sn: x.sn, def: x.def };
    if (x.ex?.[0]) o.ex = [x.ex[0].slice(0, 160)];
    if (x.sub) o.sub = { sd: x.sub.sd, def: x.sub.def };
    if (x.archaic) o.archaic = true;
    if (x.lbs?.length) o.lbs = x.lbs.slice(0, 3);
    return o;
  };
  return {
    v: 1, status: payload.status, source: 'Merriam-Webster', fetchedAt: payload.fetchedAt || new Date().toISOString(),
    suggestions: (payload.suggestions || payload.related || []).slice(0, 8),
    entries: (payload.entries || []).slice(0, 10).map((e) => {
      const o = { id: e.id, hw: e.hw, fl: e.fl, senses: (e.senses || []).slice(0, 30).map(sense) };
      if (e.hom) o.hom = e.hom;
      if (e.prs) o.prs = e.prs;
      const au = auOf(e);
      if (au) o.au = au;
      if (e.prsAll?.length > 1) o.pv = e.prsAll.map((v) => ({ mw: v.mw, ...(v.au ? { au: v.au } : {}), ...(v.l ? { l: v.l } : {}) }));
      if (e.see) o.see = e.see.slice(0, 80);
      if (e.et) o.et = e.et.slice(0, 160);
      if (e.uros?.length) o.uros = e.uros.slice(0, 6);
      if (e.dros?.length) o.dros = e.dros.slice(0, 6).map((d) => ({ phrase: d.phrase, senses: d.senses.slice(0, 3).map(sense) }));
      return o;
    }),
    thes: (payload.thes || []).slice(0, 4).map((t) => ({ id: t.id, fl: t.fl, senses: t.senses.slice(0, 4).map((x) => ({ def: x.def, syn: x.syn.slice(0, 12), rel: x.rel.slice(0, 6), near: [], ant: x.ant.slice(0, 6) })) })),
  };
}
// ---------- pronunciation ----------
// MW recordings can't load straight into the page (media from other sites is blocked), so the
// connector's pronounce tool returns the MP3 as base64 and it plays from a data: URI. iOS only
// allows playback inside the tap, so audio for the card on screen is fetched ahead of time.
const auOf = (e) => e?.au || (e?.audio ? String(e.audio).split('/').pop().replace(/\.mp3$/, '') : '');
const SAY_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor"/><path d="M16 8.5a4.5 4.5 0 0 1 0 7M18.5 6a8 8 0 0 1 0 12" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"/></svg>';
S.audio = new Map();       // word|file -> data: URI
S.audioPending = new Map();
function mwPron(w) {
  const doc = S.mw.get(w.id);
  if (!doc?.entries?.length) return null;
  const m = mwFor(w);
  const e = (m && doc.entries.find((x) => x.id === m.entry)) || doc.entries.find((x) => x.prs) || doc.entries[0];
  return e ? { prs: e.prs || '', au: auOf(e) } : null;
}
function sayBtn(word, au = '') {
  return `<button class="say" type="button" data-say="${esc(word)}" data-au="${esc(au)}" aria-label="${L(`播放 ${esc(word)} 的发音`, `Play pronunciation of ${esc(word)}`)}" title="${L('播放发音', 'Play pronunciation')}">${SAY_ICON}</button>`;
}
const FL_SHORT = { noun: 'n.', verb: 'v.', adjective: 'adj.', adverb: 'adv.', preposition: 'prep.', conjunction: 'conj.' };
const SUP = '⁰¹²³⁴⁵⁶⁷⁸⁹';
const supNum = (n) => String(n || '').split('').map((d) => SUP[+d] || d).join('');
// all pronunciations of one homograph: [{mw, au, l}]
function entryProns(e) {
  if (e.pv?.length) return e.pv;
  if (e.prsAll?.length) return e.prsAll;
  return e.prs ? [{ mw: e.prs, au: auOf(e) }] : [];
}
// the homograph whose pronunciation fits the tested sense: the MW-aligned one, else the one with
// the book sense's part of speech (content adj. /kən-ˈtent/, not the noun /ˈkän-ˌtent/)
function mainEntry(w, doc) {
  const m = mwFor(w);
  if (m) { const e = doc.entries.find((x) => x.id === m.entry); if (e) return e; }
  const want = POS_FL[(senseFor(w).pos || '').split(/[&/]/)[0]];
  return (want && doc.entries.find((x) => x.fl === want && entryProns(x).length)) || doc.entries.find((x) => entryProns(x).length) || doc.entries[0];
}
function pronOne(word, v) { return `<span class="pron"${v.au ? '' : ` title="${L('MW 没有这个读音的录音', 'MW has no recording of this pronunciation')}"`}>${v.l ? `<span class="muted small">${esc(v.l)} </span>` : ''}<span class="prs">/${esc(v.mw)}/</span>${v.au ? sayBtn(word, v.au) : ''}</span>`; }
// next to a headword: the tested homograph's pronunciations, then other homographs that sound different
function pronHtml(w) {
  const doc = S.mw.get(w.id);
  if (!doc?.entries?.length) return sayBtn(w.w, '');
  const isWord = (e) => !/\s/.test(e.hw || '') && FL_SHORT[e.fl];
  const spell = (e) => (e.hw || '').toLowerCase().replace(/[^a-z' -]/g, '');
  const main = mainEntry(w, doc);
  // other readings are other homographs of the same spelling, not related words (faulty, faultless)
  const words = doc.entries.filter((e) => isWord(e) && spell(e) === spell(main));
  let mainP = entryProns(main);
  // MW prints a pronunciation only on the first homograph of a spelling (fault:1 noun has it,
  // fault:2 verb doesn't): borrow it as the word's own instead of listing it as another reading
  if (!mainP.length) {
    const donor = words.find((e) => e !== main && entryProns(e).length);
    if (donor) mainP = entryProns(donor);
  }
  const seen = new Set(mainP.map((v) => v.mw));
  const others = [];
  for (const e of words) {
    if (e === main) continue;
    for (const v of entryProns(e)) {
      if (seen.has(v.mw)) continue;
      seen.add(v.mw);
      others.push({ ...v, tag: `${FL_SHORT[e.fl]}${supNum(e.hom)}` });   // pronOne-style: speaker only with a recording
    }
  }
  const head = mainP.length ? mainP.map((v) => pronOne(w.w, v)).join('') + (mainP.some((v) => v.au) ? '' : sayBtn(w.w, '')) : sayBtn(w.w, '');
  return `${head}${others.length ? `<span class="pron-alt muted small">${L('另有读音', 'Also')} ${others.slice(0, 3).map((v) => `<span class="pron"><span class="prs">/${esc(v.mw)}/</span> ${esc(v.tag)}${v.au ? sayBtn(w.w, v.au) : ''}</span>`).join('')}</span>` : ''}`;
}
function fetchAudio(word, au) {
  const key = au || word.toLowerCase();
  if (S.audio.has(key)) return Promise.resolve(S.audio.get(key));
  if (S.audioPending.has(key)) return S.audioPending.get(key);
  if (!mwState().ok) return Promise.resolve(null);
  const p = S.mcp.callTool(MW_SERVER, 'pronounce', { word, ...(au ? { audio: au } : {}) }, { cache: false })
    .then((res) => {
      const x = res?.payload;
      const src = x?.url || (x?.base64 ? `data:${x.mime || 'audio/mpeg'};base64,${x.base64}` : null);
      if (!src) return null;
      S.audio.set(key, src);
      if (S.audio.size > 60) S.audio.delete(S.audio.keys().next().value);
      return src;
    })
    // a failed recording (e.g. the connector's tool list not refreshed yet) must not switch off dictionary lookups
    .catch((e) => { S.audioErr = e?.code || 'error'; return null; })
    .finally(() => S.audioPending.delete(key));
  S.audioPending.set(key, p);
  return p;
}
// warm the audio for a word whose MW recording id is already cached (no dictionary query needed)
function preloadAudio(w) {
  const doc = S.mw.get(w.id);
  const e = doc?.entries?.length && mainEntry(w, doc);
  const v = e && entryProns(e).find((x) => x.au);
  if (v) fetchAudio(w.w, v.au);
}
function speakTTS(word) {
  if (!('speechSynthesis' in window)) return false;
  try { const u = new SpeechSynthesisUtterance(word); u.lang = 'en-US'; u.rate = 0.9; speechSynthesis.cancel(); speechSynthesis.speak(u); return true; } catch (e) { return false; }
}
async function playPron(word, au, btn) {
  const key = au || word.toLowerCase();
  const ready = S.audio.get(key);
  const play = (src) => { S.player?.pause(); S.player = new Audio(src); return S.player.play(); };
  if (ready) { play(ready).catch(() => speakTTS(word)); return; }
  btn?.classList.add('busy');
  const src = await fetchAudio(word, au);
  btn?.classList.remove('busy');
  if (!src) { if (!speakTTS(word)) toast(L('这个环境没法播放发音', 'Audio can’t play in this environment')); return; }
  play(src).catch(() => { if (!speakTTS(word)) toast(L('再点一次播放', 'Tap again to play')); });
}
document.addEventListener('click', (e) => {
  const b = e.target.closest?.('[data-say]');
  if (!b) return;
  e.preventDefault(); e.stopPropagation();
  playPron(b.dataset.say, b.dataset.au || '', b);
}, true);

async function saveMwDoc(id, doc) {
  S.mw.set(id, doc);
  S.mwIdx[id] = dayKey();
  if (!MW_PERSIST || !S.db || S.readOnly) return;
  try {
    await S.db.doc('me/mw/w/' + id).set(JSON.parse(JSON.stringify(doc)));
    const ref = S.db.doc('me/mwidx');
    try { await ref.update({ ids: { [id]: dayKey() } }); } catch (e) { if (e?.code === 'invalid_argument') await ref.set({ ids: { ...S.mwIdx } }); else throw e; }
  } catch (e) { handleSyncError(e); }
}
// Load a word's MW data from the cache, or look it up once. manual = the viewer asked for it.
function ensureMw(id, { manual = false } = {}) {
  if (S.mw.has(id)) return Promise.resolve(S.mw.get(id));
  if (S.mwPending.has(id)) return S.mwPending.get(id);
  const w = S.byId.get(id);
  if (!w) return Promise.resolve(null);
  const p = (async () => {
    if (S.mwIdx[id] && S.db) {
      try {
        const d = await S.db.doc('me/mw/w/' + id).get();
        if (d.exists) {
          const doc = d.data();
          S.mw.set(id, doc);
          if (needsAudioUpgrade(doc)) upgradeMw(id, doc);
          return doc;
        }
      } catch (e) { /* fall through to lookup */ }
    }
    if (!mwState().ok) return null;
    const cnt = mwCountToday();
    if (!manual && cnt.n >= MW_AUTO_PER_DAY) return null;
    try {
      cnt.n++; saveLocal();
      const res = await S.mcp.callTool(MW_SERVER, 'lookup_word', { word: w.w.replace(/\s*\([^)]*\)/g, ''), thesaurus: true }, { cache: false });
      const payload = res?.payload;
      if (!payload || typeof payload !== 'object') return null;
      const doc = { ...slimMw(payload), word: w.w };
      doc.align = doc.status === 'entry' ? await alignDoc(w, doc) : [];
      await saveMwDoc(id, doc);
      return doc;
    } catch (e) {
      if (MW_DENIED.has(e?.code)) { S.mwOff = e.code; }
      else if (manual) toast(L('MW 查询失败：', 'MW lookup failed: ') + (e?.message || e?.code || L('未知错误', 'unknown error')));
      return null;
    }
  })().finally(() => S.mwPending.delete(id));
  S.mwPending.set(id, p);
  return p;
}
// Entries cached before recording ids were kept (v13) have pronunciations but no `au`: look the word
// up once more to fill them in, keeping the existing sense alignment (no new AI 助教 calls).
const needsAudioUpgrade = (doc) => doc?.status === 'entry' && doc.entries.some((e) => e.prs) && !doc.entries.some((e) => e.au);
async function upgradeMw(id, old) {
  if (S.mwUpgrading?.has(id) || !mwState().ok) return;
  (S.mwUpgrading ||= new Set()).add(id);
  try {
    const w = S.byId.get(id);
    const res = await S.mcp.callTool(MW_SERVER, 'lookup_word', { word: w.w.replace(/\s*\([^)]*\)/g, ''), thesaurus: false }, { cache: false });
    mwCountToday().n++;
    const p = res?.payload;
    if (p?.status !== 'entry') return;
    const fresh = slimMw(p);
    // keep the thesaurus and alignment we already have; only the entries (with recording ids) change
    const doc = { ...old, entries: fresh.entries, fetchedAt: fresh.fetchedAt };
    await saveMwDoc(id, doc);
    hydrateMw(id);
  } catch (e) { /* try again another time */ } finally { S.mwUpgrading.delete(id); }
}

// Prepare the next few words of a session so cards and questions can use MW right away.
function prefetchMw(ids) { for (const id of ids) ensureMw(id); }
// MW text for the tested sense, for grounding AI 助教
function mwGround(w) {
  if (!MW_TO_AI) return '';
  const doc = S.mw.get(w.id);
  if (!doc || doc.status !== 'entry') return '';
  const m = mwFor(w);
  const others = mwSenses(doc).filter((x) => !x.archaic && x.def && x.sid !== m?.sid).slice(0, 10).map((x) => `${x.sid} (${x.phrase || x.fl}) ${x.def}`).join('; ');
  return `Merriam-Webster (authoritative): ${m ? `the sense being tested is ${m.sid} (${m.phrase || m.fl}${m.sn ? ' ' + m.sn : ''}): ${m.def}${m.sub ? `; ${m.sub.sd}: ${m.sub.def}` : ''}${m.ex?.[0] ? ` — e.g. "${m.ex[0]}"` : ''}${m.conf === 'low' ? ' (alignment uncertain)' : ''}. ` : ''}Other MW senses: ${others || 'none'}.`;
}

// ---------- AI 助教 ----------
function aiErr(e) {
  const c = e?.code;
  if (c === 'not_granted') { S.aiOff = true; return L('没有获得 AI 助教 的使用许可，本次打开不再调用', 'No permission to use the AI tutor; it won’t be called again this session'); }
  if (c === 'rate_limited') return L('AI 助教 现在太忙或额度已用完，稍后再试', 'The AI tutor is busy or out of quota; try again later');
  if (c === 'invalid_json') return L('AI 助教 的回复格式不对，再试一次', 'The AI tutor’s reply was malformed; try again');
  if (c === 'cancelled') return L('已取消', 'Cancelled');
  return L('AI 助教 暂时不可用：', 'AI tutor unavailable: ') + (e?.message || c || L('未知错误', 'unknown error'));
}
function wordBrief(w, withSenses = true) {
  const ss = (withSenses ? testSenses(w) : w.senses).slice(0, 3).map((s) => `${s.pos} ${zhGloss(s)} — ${s.en}`).join('; ');
  return `${w.w} [${ss}]`;
}
async function aiDocGet(id) {
  if (!S.db) return null;
  try { const d = await S.db.doc('me/ai/w/' + id).get(); return d.exists ? d.data() : null; } catch (e) { return null; }
}
async function aiDocMerge(id, patch) {
  S.L.ai[id] = { ...(S.L.ai[id] || {}), ...patch };
  saveLocal();
  if (!S.db || S.readOnly) return;
  try { await S.db.doc('me/ai/w/' + id).set(JSON.parse(JSON.stringify(S.L.ai[id]))); } catch (e) { /* cached locally anyway */ }
}

let prefetching = false;
async function prefetchAiQuestions(items) {
  if (prefetching) return;
  const targets = [];
  for (const it of items) {
    if (it.learn || targets.includes(it.id)) continue;
    const w = S.byId.get(it.id);
    if (!w?.senses[0]?.en) continue;
    if (levelOf(S.L.cards[it.id]) < 3) continue;
    if (S.L.ai[it.id]?.qs?.some((q) => !q.used)) continue;
    targets.push(it.id);
    if (targets.length >= 12) break;
  }
  if (!targets.length) return;
  prefetching = true;
  try {
    // another device may already have generated these
    const missing = [];
    for (const id of targets) {
      const d = await aiDocGet(id);
      if (d?.qs?.some((q) => !q.used)) S.L.ai[id] = { ...(S.L.ai[id] || {}), ...d };
      else missing.push(id);
    }
    if (!missing.length) return;
    await Promise.all(missing.map((id) => ensureMw(id)));
    const list = missing.map((id) => {
      const w = S.byId.get(id);
      const conf = (w.conf || []).map((c) => S.byId.get(c)?.w).filter(Boolean);
      const t = senseFor(w);
      const m = mwFor(w);
      const syn = [...mwThesWords(id)].slice(0, 15);
      return `- id=${id}; word=${w.w}; test this sense: ${t.pos} ${zhGloss(t)} (${MW_TO_AI && m && m.conf !== 'low' ? 'Merriam-Webster ' + m.sid + ': ' + m.def : t.en})${conf.length ? '; look-alikes=' + conf.join(', ') : ''}${MW_TO_AI && syn.length ? '; MW thesaurus synonyms (never use as distractors): ' + syn.join(', ') : ''}`;
    }).join('\n');
    const prompt = `You write sentence-completion practice items for a Chinese-speaking learner of advanced English vocabulary.
For EACH target word below, write ONE new sentence (22-40 words, an academic, literary, or scientific register) with a single blank "____" that the target word fills. Context clues in the sentence must make the target uniquely correct, testing the meaning given (for 熟词僻义 words test that less common meaning). Do not reuse dictionary example sentences.
Give 4 options: the target word in its base form plus 3 distractors of the same part of speech that are at a similar level and look plausible but are clearly wrong in context (use the listed look-alikes when they fit). If the blank needs an inflected form, keep options in base form anyway.
Check every item before replying: exactly one option fits the blank (no distractor is a synonym that also works), the sentence reads naturally, and it tests the stated sense. Leave out any item that fails rather than including a weak one.
Reply with only a JSON array, one object per target, in this shape:
[{"id":"<id>","q":"sentence with ____","opts":["w1","w2","w3","w4"],"a":<index of target in opts>,"zh":"${L('整句的中文翻译', 'a plain-English paraphrase of the whole sentence')}","why":"${L('一句中文：哪个上下文线索指向答案', 'one sentence in English: which context clue points to the answer')}"}]

Targets:
${list}`;
    const res = await S.sample.json(prompt, { modelTier: 'default' });
    if (!Array.isArray(res)) return;
    for (const r of res) {
      if (!r || !S.byId.has(r.id) || !Array.isArray(r.opts) || r.opts.length < 2 || typeof r.a !== 'number' || !String(r.q).includes('____')) continue;
      const prev = S.L.ai[r.id]?.qs || [];
      await aiDocMerge(r.id, { qs: [...prev.filter((x) => !x.used).slice(-2), { q: r.q, opts: r.opts.slice(0, 4), a: r.a, zh: r.zh || '', why: r.why || '' }] });
    }
  } catch (e) {
    if (e?.code === 'not_granted') S.aiOff = true;
  } finally { prefetching = false; }
}

function localJudge(w, answer) {
  const a = answer.trim();
  if (!a) return 'wrong';
  if (!/[一-鿿]/.test(a)) return 'unsure';
  let best = 0;
  for (const s of w.senses.concat(w.trapSenses || [])) {
    for (const g of zhGloss(s).split(/[，,；;、]/)) {
      const gc = g.replace(/[^一-鿿]/g, '');
      if (!gc) continue;
      if (gc.includes(a.replace(/[^一-鿿]/g, '')) && a.replace(/[^一-鿿]/g, '').length >= 2) return 'correct';
      best = Math.max(best, charOverlap(a, gc));
    }
  }
  if (best >= 0.75) return 'correct';
  return best > 0 ? 'unsure' : 'unsure';
}
async function aiJudge(w, answer) {
  await ensureMw(w.id);
  const ground = mwGround(w);
  const prompt = `Judge whether a Chinese-speaking learner knows the meaning of an English word.${ground ? '\nTreat the Merriam-Webster text as the authority on what the word means; the book glosses can be loose.' : ''}
Word: ${w.w}${ground ? '\n' + ground : ''}
Sense being tested: ${senseFor(w).pos} ${zhGloss(senseFor(w))} (${senseFor(w).en})
All dictionary senses: ${testSenses(w).concat(w.tags.includes('trap') ? w.senses : []).slice(0, 5).map((s) => `${s.pos} ${zhGloss(s)} (${s.en})`).join(' | ')}
Student's answer: "${answer}"
"correct" = the answer captures a listed sense (synonymous Chinese or English wording is fine). "partial" = in the right area but vague, too narrow, or wrong part of speech. "wrong" = a different meaning or a look-alike word's meaning.
Reply with only JSON: {"verdict":"correct|partial|wrong","feedback":"${L('不超过40字的中文点评，指出差别', 'a comment in English of at most 25 words, pointing out the difference')}"}`;
  return S.sample.json(prompt, { modelTier: 'quick' });
}
async function aiExplain(w) {
  await ensureMw(w.id);
  const ground = mwGround(w);
  const conf = (w.conf || []).map((c) => S.byId.get(c)).filter(Boolean).map((x) => `${x.w}(${zhGloss(senseFor(x))})`);
  const prompt = `帮一个学习高阶英语词汇的中文学生记住这个词。
词条：${wordBrief(w, false)}${w.tags.includes('trap') ? '\n这是熟词僻义词，重点讲不常见的意思：' + testSenses(w).map((s) => zhGloss(s)).join('；') : ''}
近义词：${(w.syn || []).join(', ') || '无'}
形近词：${conf.join(', ') || '无'}
${ground ? ground + '\n以上 Merriam-Webster 释义是权威依据：讲解、辨析和例句都要符合它；书上的中文释义如果和 MW 有出入，在 tip 里指出。\n' : ''}要求：词根词缀拆解要真实可靠（没有可靠词源就写联想记忆，不要编造词源）；近义/形近辨析只挑最容易混的 1-3 个；例句用学术文章的语气。${L('', '\n所有讲解都用英文写（roots、mnemonic、diff、tip 都用英文）；examples 里的 zh 字段写这句例句的简明英文释义（paraphrase），不要写中文。')}
只回复 JSON：{"roots":"词根词缀拆解或词源，一两句","mnemonic":"一句好记的联想","distinct":[{"w":"相近或形近词","diff":"一句话区别"}],"examples":[{"en":"新例句","zh":"翻译"}],"tip":"常见的用法、搭配或易错点，一句"}`;
  return S.sample.json(prompt, { modelTier: 'default' });
}
const mwBrief = (mw, n = 12) => (MW_TO_AI && mw?.status === 'entry' ? mwSenses(mw).filter((m) => !m.archaic && m.def).slice(0, n).map((m) => `${m.sid} (${m.phrase || m.fl}) ${m.def}`).join('\n') : '');
// items: [{word, mw}] -> { lowercased input word: draft }; up to 8 words per call
async function aiAddWords(items) {
  const blocks = items.map((it) => { const t = mwBrief(it.mw); return `### ${it.word}\n${t ? 'Merriam-Webster 义项（权威依据，英文释义直接采用、可略作精简）：\n' + t : '（MW 没有这个词，参照 Oxford/MW 写）'}`; }).join('\n\n');
  const prompt = `为学习高阶英语词汇的学生给下面 ${items.length} 个词各写一个词条，风格像中文词书：中文释义在前，英文释义，例句英汉对照。每个词只列常用和重要的义项（1-3 个），容易被忽略的冷门义项要包含；每个义项 1 个例句。
${blocks}

只回复一个 JSON 数组，每个词一项，顺序同上：[{"q":"上面的原词","w":"标准词形","senses":[{"pos":"n./adj./v.t./v.i./adv.","zh":"中文释义","en":"English definition","ex":[{"en":"example","zh":"翻译"}]}],"syn":["近义词"],"ant":["反义词"]}]
字符串里不要出现英文双引号（需要引号时用单引号），不要加任何说明文字。`;
  const res = await S.sample.json(prompt, { modelTier: 'default' });
  const arr = Array.isArray(res) ? res : Array.isArray(res?.words) ? res.words : [];
  const out = {};
  arr.forEach((r, i) => { if (r?.w && Array.isArray(r.senses) && r.senses.some((x) => x?.zh)) out[String(r.q || items[i]?.word || r.w).toLowerCase()] = r; });
  return out;
}
async function aiDiagnose() {
  const since = Date.now() - 21 * DAY;
  const wrongs = [];
  for (const s of Object.values(S.L.sessions)) for (const it of s.items || []) if (!it.ok && it.k !== 'learn' && it.k !== 'drill' && it.t >= since) wrongs.push(it);
  const counts = {};
  for (const it of wrongs) counts[it.i] = (counts[it.i] || 0) + 1;
  const lapsed = Object.entries(S.L.cards).filter(([, c]) => c.lapses >= 2).map(([id]) => id);
  const looked = Object.keys(S.L.lookups || {}).filter((id) => lookupsOf(id, 21 * DAY).length >= 2);
  const ids = [...new Set([...Object.keys(counts).sort((a, b) => counts[b] - counts[a]), ...lapsed, ...looked])].slice(0, 80);
  if (ids.length < 3) return null;
  const lines = ids.map((id) => {
    const w = S.byId.get(id); if (!w) return null;
    const picks = wrongs.filter((x) => x.i === id && x.c).map((x) => x.c).slice(0, 3);
    return `- id=${id}; ${w.w} (${zhGloss(senseFor(w))}); 错${counts[id] || 0}次; 遗忘${S.L.cards[id]?.lapses || 0}次${lookupsOf(id, 21 * DAY).length ? `; 主动查过${lookupsOf(id, 21 * DAY).length}次` : ''}${picks.length ? '; 误选: ' + picks.join(' / ') : ''}`;
  }).filter(Boolean).join('\n');
  const prompt = `下面是一个学生最近三周答错或反复遗忘的词（含当时误选的选项）。找出错误背后的规律，比如形近混淆、熟词僻义没掌握、某类词性或语义场（褒贬、程度词）整体薄弱，并给出针对性的练习词单。
${lines}
只回复 JSON：{"summary":"${L('两三句中文总结', 'two or three sentences in English')}","patterns":[{"title":"${L('规律名', 'short pattern name in English')}","detail":"${L('一两句说明和建议', 'one or two sentences of explanation and advice, in English')}","ids":["相关 id"]}],"focus":["最该优先练的 id，最多 30 个"]}`;
  return S.sample.json(prompt, { modelTier: 'default' });
}

// ---------- rendering ----------
const app = () => $('#app');
// Every tap redraws the screen at once, so the second tap of a double tap (or a held key) would land
// on whatever appeared under it: an option of the next question, "继续", a sheet's button.
// Screens mark when they appeared and input in the first moment after is dropped.
const SETTLE_MS = 350;
const markView = () => { S.viewAt = Date.now(); };
const tooSoon = () => Date.now() - (S.viewAt || 0) < SETTLE_MS;
document.addEventListener('click', (e) => {
  if (tooSoon() && e.isTrusted && e.target.closest?.('button, a, label, .opt, [data-b], [data-se]')) { e.preventDefault(); e.stopPropagation(); }
}, true);
function toast(msg, ms = 2600, action = null) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  if (action) {
    const b = document.createElement('button');
    b.className = 'toast-act'; b.textContent = action.label;
    b.addEventListener('click', () => { t.hidden = true; action.fn(); });
    t.append(b);
  }
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, ms);
}
function syncChipHtml() {
  const s = S.sync;
  const pending = Object.keys(S.L.dirty).length + Object.keys(S.L.dirtyS).length + Object.keys(S.L.dirtyC).length + Object.keys(S.L.dirtyN).length;
  if (s.state === 'ok') return `<span class="chip ok" id="sync" title="${L('进度已同步到云端', 'Progress is synced to the cloud')}"><i></i>${L('已同步', 'Synced')}</span>`;
  if (s.state === 'syncing') return `<span class="chip" id="sync"><span class="spin"></span>${L('同步中', 'Syncing')}</span>`;
  if (s.state === 'offline') return `<span class="chip warn" id="sync" title="${esc(s.msg)}"><i></i>${L(`待上传 ${pending}`, `${pending} to upload`)}</span>`;
  if (s.state === 'error') return `<span class="chip bad" id="sync" title="${esc(s.msg)}"><i></i>${esc(s.msg.slice(0, window.LANG === 'en' ? 28 : 12))}</span>`;
  return `<span class="chip" id="sync" title="${L('只保存在这台设备', 'Saved on this device only')}"><i></i>${L('本机模式', 'Local only')}</span>`;
}
function paintSyncChip() { const el = $('#sync'); if (el) el.outerHTML = syncChipHtml(); }
function topBar() { return `<div class="top"><div class="brand">${APP_NAME}</div>${syncChipHtml()}</div>`; }

function render() {
  if (!S.words.length) return;
  $('#tabs').hidden = !!(S.session || S.practice || S.game);
  if (S.session || S.practice) return; // sessions and practice render themselves
  if (S.game) return paintSynMatch();
  for (const b of document.querySelectorAll('#tabs button')) {
    if (b.dataset.tab === S.tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  }
  if (S.tab === 'home' && S.sub === 'drill') { if (S.drills) renderDrill(); else openDrillPage(S.drillSec); }
  else if (S.tab === 'home') renderHome();
  else if (S.tab === 'bank') renderBank();
  else if (S.tab === 'ask') renderAsk();
  else renderSettings();
}

function stats() {
  const m = [0, 0, 0, 0, 0];
  for (const w of S.words) m[masteryOf(S.L.cards[w.id])]++;
  const byDay = {};
  for (const s of Object.values(S.L.sessions)) for (const it of s.items || []) {
    const k = dayKey(it.t);
    const d = (byDay[k] ||= { n: 0, ok: 0, learn: 0, ms: 0 });
    if (it.fl) continue;
    if (it.k === 'drill') continue;
    if (it.k === 'learn') d.learn++; else { d.n++; d.ok += it.ok; d.ms += Math.min(it.ms || 0, 60000); }
  }
  let streak = 0;
  for (let i = 0; i < 400; i++) {
    const k = dayKey(Date.now() - i * DAY);
    if (byDay[k]?.n) streak++; else if (i > 0) break;
  }
  return { m, byDay, streak };
}

// month and day for display: 10月29日 / Oct 29
const mdTxt = (d) => L(`${d.getMonth() + 1}月${d.getDate()}日`, d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
function renderHome() {
  const p = todayPlan();
  const st = stats();
  const total = S.words.length;
  const seen = total - st.m[0];
  const today = st.byDay[dayKey()] || { n: 0, ok: 0, learn: 0, ms: 0 };
  const estMin = Math.round((p.due.length * med('mc') * 1.6 + p.fresh.length * (med('mc') * 2 + 9000) + p.screens.length * 4000) / 60000);
  const screenLeft = S.words.filter((w) => w.scr && unseen(w.id)).length;
  const exam = S.L.prefs.examDate ? Math.ceil((new Date(S.L.prefs.examDate + 'T00:00').getTime() - dayStart()) / DAY) : null;
  const daily = Math.max(1, p.daily | 0);
  // the finish date is for the main list; words marked `late` come after
  const lateLeft = S.words.filter((w) => w.late && unseen(w.id)).length;
  const mainLeft = st.m[0] - lateLeft;
  const daysLeft = Math.ceil(mainLeft / daily);
  const finish = new Date(dayStart() + daysLeft * DAY);
  const finishTxt = mdTxt(finish);
  const colors = ['var(--l1)', 'var(--l2)', 'var(--l3)', 'var(--l4)', 'var(--l5)'];
  const days = [];
  for (let i = 13; i >= 0; i--) { const k = dayKey(Date.now() - i * DAY); days.push({ k, ...(st.byDay[k] || { n: 0, ok: 0 }) }); }
  const maxN = Math.max(20, ...days.map((d) => d.n));
  const ai = S.sample && !S.aiOff;
  const doneToday = !p.due.length && !p.fresh.length && !p.screens.length;
  const moreLeft = doneToday && S.newOrder.some((id) => unseen(id));

  const welcome = (() => { try { return !localStorage.getItem('ovd-welcomed'); } catch (e) { return false; } })();
  app().innerHTML = `
  ${topBar()}
  ${welcome ? `<div class="card ruled welcome" id="welcome">
    <div class="today-head"><b>${L('欢迎', 'Welcome')}</b></div>
    <ul class="small" style="margin:0;padding-left:18px;display:flex;flex-direction:column;gap:6px">
      <li>${L('用 AI 讲解理解词义，在语境中练习，再按 FSRS 的安排持续学习和复习。', 'Learn words with AI explanations and contextual practice, then build a steady review rhythm with FSRS.')}</li>
      <li>${L(`不需要账号，进度存在这台设备的浏览器里。当前词表有 ${S.words.length} 个词，也可以在设置里导入其他词表。`, `No account needed: progress lives in this browser. Your current list has ${S.words.length} words; you can import another list in Settings.`)}</li>
      <li>${L('AI 讲解、Merriam-Webster 查词、多设备同步都是可选的，在设置里填自己的 key 就能打开。', 'AI explanations, Merriam-Webster lookups and multi-device sync are optional; add your own keys in Settings to turn them on.')}</li>
    </ul>
    <div class="row"><button class="btn primary" id="welcome-go">${L('开始', 'Start')}</button><button class="btn" id="welcome-set">${L('先去设置', 'Settings first')}</button></div>
  </div>` : ''}
  <div class="card ruled today">
    <div class="today-head"><b>${L('今天', 'Today')}</b><span class="muted small">${exam != null && exam >= 0 ? L(`距考试 <span class="num">${exam}</span> 天 · `, `<span class="num">${exam}</span> days to the test · `) : ''}${st.streak ? L(`连续 <span class="num">${st.streak}</span> 天`, `<span class="num">${st.streak}</span>-day streak`) : L('还没开始打卡', 'No streak yet')}</span></div>
    <div class="counts">
      <div class="count"><div class="n">${p.due.length}</div><div class="l">${L('待复习', 'Reviews')}</div></div>
      <div class="count"><div class="n">${p.fresh.length}</div><div class="l">${L(`新词 · 每天 ${p.daily}`, `New · ${p.daily}/day`)}${addedToday() ? L(` +${addedToday()} 你加的`, ` +${addedToday()} added by you`) : ''}${p.daily < (S.L.prefs.dailyNew | 0) ? L('（复习多，自动减少）', ' (reduced: many reviews)') : ''}</div></div>
      <div class="count"><div class="n">${today.n}</div><div class="l">${L('今天已答', 'Answered today')}${today.n ? ` · ${Math.round(today.ok / today.n * 100)}%` : ''}</div></div>
    </div>
    ${doneToday ? `<p class="muted small" style="margin:0">${L('今天的复习和新词都完成了。', 'Today’s reviews and new words are done. ')}${moreLeft ? L(`还有空可以再来 ${MORE_N} 个新词（只加今天，明天照常），`, `If you have time, take ${MORE_N} more new words (today only; tomorrow stays the same), `) : ''}${L('想多练也可以做下面的专项。', moreLeft ? 'or try a drill below.' : 'For more practice, try a drill below.')}</p>` : ''}
    <div class="row">
      ${doneToday && moreLeft ? `<button class="btn primary" id="more">${L(`再来 ${MORE_N} 词`, `${MORE_N} more words`)}</button>` : `<button class="btn primary" id="go" ${doneToday ? 'disabled' : ''}>${doneToday ? L('今日完成', 'Done for today') : L('开始学习', 'Start')}</button>
      <button class="btn grow" id="go-quick" ${doneToday ? 'disabled' : ''}>${L('快速模式', 'Quick mode')}</button>`}
    </div>
    <div class="muted small">${doneToday ? '' : `${p.screens.length ? L(`另有 <span class="num">${p.screens.length}</span> 个常见词先快速筛一遍，选对就跳过，不占新词名额。`, `Plus <span class="num">${p.screens.length}</span> common words to screen first: get one right and it’s skipped, without using a new-word slot. `) : ''}${L(`预计 <span class="num">${Math.max(1, estMin)}</span> 分钟。快速模式只出选择题，不用打字。随时可以退出，进度按题保存。`, `About <span class="num">${Math.max(1, estMin)}</span> min. Quick mode is multiple choice only, no typing. Leave any time; progress is saved after every question.`)}`}</div>
  </div>

  <section class="sec">
    <div class="sec-head"><h2>${L('进度', 'Progress')}</h2><span class="muted small"><span class="num">${seen}</span> / <span class="num">${total}</span> ${L('已学', 'learned')}</span></div>
    <div class="bar" role="img" aria-label="${L('掌握程度分布', 'Mastery breakdown')}">${[1, 2, 3, 4].map((i) => `<span style="width:${(st.m[i] / total * 100).toFixed(2)}%;background:${colors[i]}"></span>`).join('')}</div>
    <div class="legend">${MASTERY.map((n, i) => `<div><span><i style="background:${colors[i]}"></i>${n}</span><b>${st.m[i]}</b></div>`).join('')}</div>
    <div class="muted small">${L(`按每天 ${daily} 个新词，词书还剩 <span class="num">${mainLeft}</span> 个约 <span class="num">${daysLeft}</span> 天学完（${finishTxt}）`, `At ${daily} new words a day, the remaining <span class="num">${mainLeft}</span> words take about <span class="num">${daysLeft}</span> days (done by ${finishTxt})`)}${exam != null && exam > 0 ? (daysLeft + 10 > exam ? L(`，离考试只剩 ${exam} 天，建议调高每日新词。`, `, but the test is only ${exam} days away; consider raising the daily new words.`) : L('，考前还有复习余量。', ', leaving time to review before the test.')) : L('。', '.')}${lateLeft ? L(`之后接着学 <span class="num">${lateLeft}</span> 个近义词补充。`, ` Then <span class="num">${lateLeft}</span> supplementary synonyms.`) : ''}</div>
  </section>

  <section class="sec">
    <div class="sec-head"><h2>${L('最近两周', 'Last two weeks')}</h2><span class="muted small">${L('每天答题数', 'Answers per day')}</span></div>
    <div class="acts">${days.map((d, i) => `<div class="act${i === 13 ? ' now' : ''}" title="${d.k}: ${L(`${d.n} 题`, `${d.n} answered`)}${d.n ? L('，正确率 ', ', ') + Math.round(d.ok / d.n * 100) + L('%', '% correct') : ''}"><div class="b${d.n ? '' : ' zero'}" style="height:${Math.max(2, d.n / maxN * 64)}px"></div><div class="d">${+d.k.slice(8)}</div></div>`).join('')}</div>
  </section>

  <section class="sec">
    <h2>${L('专项', 'Drills')}</h2>
    <div class="list">
      ${screenLeft ? `<button class="item" id="drill-screen"><div><div class="t">${L('斩词筛查', 'Screen known words')}</div><div class="s">${L(`还有 <span class="num">${screenLeft}</span> 个常见词，每次 60 个，${screenSecTxt()} 秒内选对词表上的释义就跳过`, `<span class="num">${screenLeft}</span> common words left, 60 per round; pick the right meaning within ${screenSecTxt()} s and the word is skipped`)}</div></div><span class="go">›</span></button>` : ''}
      <button class="item" id="drill-conf"><div><div class="t">${L('形近词专练', 'Look-alike words')}</div><div class="s">${L(`随机 10 组，${S.groups.length} 组易混词轮流练`, `10 random sets, rotating through ${S.groups.length} groups of easily confused words`)}</div></div><span class="go">›</span></button>
      <button class="item" id="drill-trap"><div><div class="t">${L('熟词僻义专练', 'Uncommon meanings')}</div><div class="s">${L(`${S.words.filter((w) => w.tags.includes('trap')).length} 个熟词的冷门义，优先练到期的`, `Less common meanings of ${S.words.filter((w) => w.tags.includes('trap')).length} familiar words, due ones first`)}</div></div><span class="go">›</span></button>
      ${hasDrills() ? `<button class="item" id="drill-set"><div><div class="t">${L('习题集', 'Question sets')}</div><div class="s">${drillLine()}</div></div><span class="go">›</span></button>` : ''}
      <button class="item" id="drill-syn"><div><div class="t">${L('同义词配对', 'Synonym match')}</div><div class="s">${L('8 对词和同义词的格子，点一个词再点它的同义词，练六选二需要的词→同义词反应；不计分', 'A grid of 8 word–synonym pairs: tap a word, then its synonym, to build the quick recall Sentence Equivalence needs. Not graded.')}</div></div><span class="go">›</span></button>
      ${ai ? `<button class="item" id="drill-practice"><div><div class="t">${L('填空实战', 'Text Completion practice')}</div><div class="s">${L('AI 助教 按句子填空的风格用你的词出新题，单空、多空、六选二', 'The AI tutor writes new exam-style items with your words: one blank, multiple blanks, Sentence Equivalence')}</div></div><span class="go">›</span></button>` : ''}
      ${ai ? `<button class="item" id="drill-diag"><div><div class="t">${L('错词诊断', 'Mistake diagnosis')}</div><div class="s">${S.L.diag ? L('上次诊断：', 'Last run: ') + mdTxt(new Date(S.L.diag.at)) + ' · ' : ''}${L('AI 助教 分析最近三周的错题规律，生成专练词单', 'The AI tutor looks for patterns in your last three weeks of mistakes and builds a focused word list')}</div></div><span class="go">›</span></button>` : ''}
    </div>
  </section>
  <section class="sec">
    <h2>${L('查词', 'Look up')}</h2>
    <form id="findf" class="row" autocomplete="off"><input id="findq" type="search" enterkeyhint="search" autocapitalize="off" placeholder="${L('一个或几个英文词，空格、逗号或换行分开', 'One or more English words, separated by spaces, commas or new lines')}" style="flex:1 1 200px;min-width:0"><button class="btn" type="submit" style="flex:0 0 auto">${L('查', 'Look up')}</button></form>
    <div class="muted small">${L('先查词库（含变形和派生词），没有再查 Merriam-Webster，不调用模型；要加入词库时 AI 助教 才会写中文释义。', 'Searches your words first (including inflected and derived forms), then Merriam-Webster; no AI is used. The AI tutor only writes an entry when you add a word.')}</div>
  </section>`;
  const markWelcomed = () => { try { localStorage.setItem('ovd-welcomed', '1'); } catch (e) { /* ignore */ } };
  $('#welcome-go')?.addEventListener('click', () => { markWelcomed(); startSession('normal'); });
  $('#welcome-set')?.addEventListener('click', () => { markWelcomed(); S.tab = 'settings'; render(); });
  $('#go')?.addEventListener('click', () => startSession('normal'));
  $('#more')?.addEventListener('click', moreToday);
  $('#go-quick')?.addEventListener('click', () => startSession('quick'));
  $('#drill-conf').addEventListener('click', () => startSession('conf'));
  $('#drill-screen')?.addEventListener('click', () => startSession('screen'));
  $('#drill-trap').addEventListener('click', () => startSession('trap'));
  $('#drill-diag')?.addEventListener('click', openDiagnose);
  $('#drill-practice')?.addEventListener('click', openPracticeSetup);
  $('#drill-set')?.addEventListener('click', () => openDrillPage());
  $('#drill-syn')?.addEventListener('click', () => startSynMatch(8));
  $('#findf')?.addEventListener('submit', (e) => { e.preventDefault(); openFind($('#findq').value); });
}

// ---------- entry rendering ----------
function mwLineHtml(w, s) {
  const m = mwFor(w, s);
  if (!m) return '';
  const where = `${m.entry}${m.sn ? ' · ' + m.sn : ''}${m.phrase ? ' · ' + m.phrase : ''}`;
  return `<div class="mw-line"><span class="mw-id">MW ${esc(where)}</span>${esc(m.def)}${m.sub ? `<span class="muted">；${esc(m.sub.sd)}: ${esc(m.sub.def)}</span>` : ''}${m.conf === 'low' ? ` <span class="tag trap">${L('对应存疑', 'Match uncertain')}</span>` : ''}</div>${m.zhFix ? `<div class="mw-fix">${L('释义存疑 · AI 助教 依据 MW 建议：', 'Gloss questionable · AI tutor suggests, based on MW: ')}${esc(m.zhFix)}${m.note ? `<span class="muted">${L('（', ' (')}${esc(m.note)}${L('）', ')')}</span>` : ''}</div>` : ''}`;
}
function mwFullHtml(w) {
  const doc = S.mw.get(w.id);
  return doc ? mwDocHtml(doc, w.w) : '';
}
function mwDocHtml(doc, word, { open = false } = {}) {
  if (doc.status !== 'entry') return `<div class="mw-full muted small">${L(`Merriam-Webster 没有收录 “${esc(word)}”`, `Merriam-Webster has no entry for “${esc(word)}”`)}${doc.suggestions?.length ? L('，相近的有：', '. Similar: ') + esc(doc.suggestions.slice(0, 6).join(', ')) : ''}${L('。', '.')}</div>`;
  const senseRow = (sn) => `<div class="mw-sense"><span class="mw-sn">${esc(sn.sn || '·')}</span><span>${esc(sn.def)}${sn.sub ? `<span class="muted">；${esc(sn.sub.sd)}: ${esc(sn.sub.def)}</span>` : ''}${sn.lbs?.length ? ` <span class="muted small">[${esc(sn.lbs.join(', '))}]</span>` : ''}${sn.ex?.[0] ? `<br><i class="muted">${esc(sn.ex[0])}</i>` : ''}</span></div>`;
  const groups = doc.entries.map((e) => {
    const live = e.senses.filter((x) => !x.archaic), old = e.senses.filter((x) => x.archaic);
    return `<div class="mw-entry"><div class="mw-hw"><b>${esc(e.hw)}</b>${e.hom ? `<sup>${e.hom}</sup>` : ''} <i class="muted">${esc(e.fl)}</i>${entryProns(e).map((v) => ' ' + pronOne(e.hw, v)).join('')}${e.see ? ` <span class="muted small">${esc(e.see)}</span>` : ''}</div>
      ${live.map(senseRow).join('')}
      ${old.length ? `<details class="mw-old"><summary class="small muted">${L(`古旧或少见义项 ${old.length} 个`, `${old.length} archaic or rare sense${old.length > 1 ? 's' : ''}`)}</summary>${old.map(senseRow).join('')}</details>` : ''}
      ${e.dros?.length ? e.dros.map((d) => `<div class="mw-dro"><b>${esc(d.phrase)}</b> ${d.senses.map((x) => esc(x.def)).join('；')}</div>`).join('') : ''}
      ${e.uros?.length ? `<div class="small muted">${L('派生：', 'Derived: ')}${esc(e.uros.map((u) => `${u.w} (${u.fl})`).join(', '))}</div>` : ''}</div>`;
  }).join('');
  const thes = (doc.thes || []).flatMap((t) => t.senses.filter((x) => x.syn.length || x.ant.length).map((x) => `<div class="small"><i class="muted">${esc(t.fl)}</i> ${esc(x.def)}${x.syn.length ? ` · <span class="muted">${L('同义', 'syn.')}</span> ${esc(x.syn.slice(0, 8).join(', '))}` : ''}${x.ant.length ? ` · <span class="muted">${L('反义', 'ant.')}</span> ${esc(x.ant.slice(0, 5).join(', '))}` : ''}</div>`)).join('');
  // attribution on every rendering of Merriam-Webster content (docs/merriam-webster.md)
  const credit = mwCredit(word);
  return `<details class="mw-full"${open ? ' open' : ''}><summary>${L(`MW 全部义项 · ${doc.entries.length} 个词条`, `All MW senses · ${doc.entries.length} entr${doc.entries.length > 1 ? 'ies' : 'y'}`)}</summary>${groups}${thes ? `<div class="mw-entry"><div class="mw-hw"><b>Thesaurus</b></div>${thes}</div>` : ''}<div class="small muted">Merriam-Webster Collegiate Dictionary &amp; Thesaurus · ${L('查询于', 'retrieved')} ${esc((doc.fetchedAt || '').slice(0, 10))}</div></details>${credit}`;
}
// re-render entries for a word once its MW data arrives
function hydrateMw(id) {
  const w = S.byId.get(id);
  document.querySelectorAll(`[data-entry="${CSS.escape(id)}"]`).forEach((el) => {
    el.outerHTML = entryHtml(w, { compact: el.dataset.compact === '1', bare: el.dataset.bare === '1' });
  });
  document.querySelectorAll(`[data-entry="${CSS.escape(id)}"]`).forEach((el) => bindEntryLinks(el));
}
function withMw(id) {
  ensureMw(id).then((d) => {
    if (!d) return;
    hydrateMw(id);
    const w = S.byId.get(id);
    document.querySelectorAll('.hw-pron').forEach((el) => { if (el.closest('.q')?.dataset.word === id) el.innerHTML = pronHtml(w); });
    preloadAudio(w);
  });
}

function entryHtml(w, { compact = false, bare = false } = {}) {
  const trapSet = new Set((w.trapSenses || []).map((s) => s.zh));
  const isTrapOnly = w.tags[0] === 'trap';
  const senses = w.senses.length ? w.senses : [];
  const extraTrap = (w.trapSenses || []).filter((s) => !w.senses.some((x) => x.zh === s.zh));
  const senseHtml = (s, trap) => `<div class="sense${trap ? ' trap' : ''}"><span class="p">${esc(s.pos || '')}</span><span class="zh">${esc(s.zh)}</span>${s.en ? `<span class="en">${esc(s.en)}</span>` : ''}${mwLineHtml(w, s)}${(s.ex || []).slice(0, compact ? 1 : 3).map((e) => `<div class="ex"><div class="e">${esc(e.en)}</div>${e.zh ? `<div class="z">${esc(e.zh)}</div>` : ''}</div>`).join('')}</div>`;
  const rel = [];
  if (w.examZh) rel.push(`<div><span class="lab">${L('你熟悉的意思（', 'The meaning you know (')}${BAND_NAME[w.band] || L('考纲', 'syllabus')}${L('）', ')')}</span>${esc(w.examZh)}</div>`);
  if (w.syn?.length) rel.push(`<div><span class="lab">${L('近义', 'Synonyms')}</span>${esc(w.syn.join(', '))}</div>`);
  if (w.ant?.length) rel.push(`<div><span class="lab">${L('反义', 'Antonyms')}</span>${esc(w.ant.join(', '))}</div>`);
  if (w.conf?.length) rel.push(`<div><span class="lab">${L('形近', 'Look-alikes')}</span>${w.conf.map((id) => { const x = S.byId.get(id); return x ? `<button class="wl" data-word="${esc(id)}">${esc(x.w)}</button> <span class="muted">${esc(zhGloss(senseFor(x)))}</span>` : ''; }).join('；')}</div>`);
  if (w.synOf?.length) rel.push(`<div><span class="lab">${L('词表上列为近义词', 'Listed as a synonym of')}</span>${w.synOf.map((t) => { const x = S.words.find((y) => y.w.toLowerCase() === t.toLowerCase()); return x ? `<button class="wl" data-word="${esc(x.id)}">${esc(x.w)}</button>` : esc(t); }).join(L('、', ', '))}</div>`);
  if (w.derived?.length) rel.push(`<div><span class="lab">${L('派生', 'Derived')}</span>${w.derived.map((d) => `<b>${esc(d.w)}</b> <i class="muted">${esc(d.pos)}</i> ${esc(d.zh)}`).join('；')}</div>`);
  const tags = [];
  if (w.tags.includes('trap')) tags.push(`<span class="tag trap">${L('熟词僻义', 'Uncommon meaning')}</span>`);
  if (w.tags.includes('confusable')) tags.push(`<span class="tag conf">${L('形近词', 'Look-alike')}</span>`);
  if (w.tags.includes('custom')) tags.push(`<span class="tag">${L('自己添加', 'Added by you')}</span>`);
  if (w.shift || w.rare) tags.push(`<span class="tag trap">${L('冷门义', 'Rare sense')}</span>`);
  if (w.band) tags.push(`<span class="tag">${BAND_NAME[w.band]}</span>`);
  if (w.list) tags.push(`<span class="tag">Word List ${w.list}</span>`);
  if (w.tags.includes('supplement')) tags.push(`<span class="tag">${L('补充', 'Supplement')}</span>`);
  return `<div class="entry" data-entry="${esc(w.id)}" data-compact="${compact ? 1 : 0}" data-bare="${bare ? 1 : 0}">
    ${bare ? '' : `<div class="entry-hw"><span class="w">${esc(w.w)}</span>${pronHtml(w)}${tags.join('')}</div>`}
    ${senses.map((s, k) => senseHtml(s, (!isTrapOnly && trapSet.has(s.zh)) || (w.rare || []).includes(k) || !!w.shift)).join('')}
    ${extraTrap.map((s) => senseHtml(s, true)).join('')}
    ${rel.length ? `<div class="rels">${rel.join('')}</div>` : ''}
    ${typeof notesHtml === 'function' ? notesHtml(w) : ''}
    ${mwFullHtml(w)}
  </div>`;
}
function aiExplainHtml(x) {
  if (!x) return '';
  return `<div class="ai-box">
    ${x.roots ? `<div><h4>${L('词根 / 词源', 'Roots / etymology')}</h4><p>${esc(x.roots)}</p></div>` : ''}
    ${x.mnemonic ? `<div><h4>${L('联想', 'Mnemonic')}</h4><p>${esc(x.mnemonic)}</p></div>` : ''}
    ${x.distinct?.length ? `<div><h4>${L('辨析', 'Distinctions')}</h4>${x.distinct.map((d) => `<p><b>${esc(d.w)}</b>${L('：', ': ')}${esc(d.diff)}</p>`).join('')}</div>` : ''}
    ${x.examples?.length ? `<div><h4>${L('新例句', 'New examples')}</h4>${x.examples.map((e) => `<p><span style="font-family:var(--f-head)">${esc(e.en)}</span><br><span class="muted">${esc(e.zh)}</span></p>`).join('')}</div>` : ''}
    ${x.tip ? `<div><h4>${L('考法', 'On the test')}</h4><p>${esc(x.tip)}</p></div>` : ''}
  </div>`;
}
function bindEntryLinks(root) {
  root.querySelectorAll('[data-word]').forEach((b) => b.addEventListener('click', () => openWord(b.dataset.word)));
}
async function explainInto(w, box, btn) {
  if (S.L.ai[w.id]?.ex) { box.innerHTML = aiExplainHtml(S.L.ai[w.id].ex); btn?.remove(); return; }
  btn && (btn.disabled = true, btn.innerHTML = '<span class="spin"></span> ' + L('AI 助教 在想', 'AI tutor is thinking'));
  try {
    const remote = await aiDocGet(w.id);
    let ex = remote?.ex;
    if (remote) S.L.ai[w.id] = { ...(S.L.ai[w.id] || {}), ...remote };
    if (!ex) { ex = await aiExplain(w); await aiDocMerge(w.id, { ex }); }
    box.innerHTML = aiExplainHtml(ex);
    btn?.remove();
  } catch (e) {
    toast(aiErr(e));
    if (btn) { btn.disabled = false; btn.textContent = L('讲讲这个词', 'Explain this word'); }
  }
}

// ---------- session UI ----------
function exitSession() {
  if (S.session) { saveLocal(true); push(); }
  clearTimeout(S.autoT);
  S.session = null;
  render();
  markView();
}
function sessionTop() {
  const s = S.session;
  const total = s.items.length;
  const label = { normal: L('今日学习', 'Today’s study'), quick: L('快速模式', 'Quick mode'), conf: L('形近词专练', 'Look-alike words'), trap: L('熟词僻义专练', 'Uncommon meanings'), focus: L('诊断专练', 'Diagnosis drill'), screen: L('斩词筛查', 'Screen known words') }[s.kind];
  return `<div class="sess-top"><button class="x" id="exit" aria-label="${L('退出', 'Exit')}">×</button><div class="prog"><span style="width:${(s.idx / total * 100).toFixed(1)}%"></span></div><span class="muted small num">${Math.min(s.idx + 1, total)}/${total}</span></div>
  <div class="muted small" style="margin-top:-12px">${label}${s.done ? L(` · 正确率 ${Math.round(s.right / s.done * 100)}%`, ` · ${Math.round(s.right / s.done * 100)}% correct`) : ''}</div>`;
}
function showQuestion() {
  const s = S.session;
  clearTimeout(S.autoT);
  $('#tabs').hidden = true;
  if (s.idx >= s.items.length) return showSummary();
  const item = s.items[s.idx];
  if (!S.byId.has(item.id)) { s.idx++; return showQuestion(); }
  prefetchMw(s.items.slice(s.idx, s.idx + 4).map((it) => it.id));
  markView();
  if (item.learn) return showLearn(item);
  const q = buildQuestion(item);
  s.q = q; s.answered = null;
  const w = q.w;
  const tags = [];
  if (w.tags.includes('trap') && (q.type === 'mc_en2zh' || q.type === 'type_meaning')) tags.push(`<span class="tag trap">${L('熟词僻义', 'Uncommon meaning')}</span>`);
  if (q.ai) tags.push(`<span class="tag ai">${L('AI 助教 出题', 'Written by AI tutor')}</span>`);
  if (item.retry) tags.push(`<span class="tag">${L('再练一次', 'Once more')}</span>`);
  if (item.retest) tags.push(`<span class="tag">${L('换个题型再考', 'Retest, new format')}</span>`);
  if (item.screen) tags.push(`<span class="tag">${esc(BAND_NAME[w.band] || L('高频词', 'High-frequency'))}</span>`);
  if (item.pre) tags.push(`<span class="tag">${L('新词', 'New')}</span>`);
  const typeLabel = item.pre ? (q.type === 'mc_syn' ? L('新词：先选它的近义词，不认识就点“不认识”', 'New word: pick its synonym, or tap “Don’t know”') : L('新词：先选中文意思，不认识就点“不认识”', 'New word: pick its meaning, or tap “Don’t know”')) : item.screen ? L(`斩词：${screenSecTxt()} 秒内选对就跳过`, `Screening: right within ${screenSecTxt()} s and it’s skipped`) : { mc_def2word: L('选出符合英文释义的词', 'Pick the word that fits the definition'), mc_en2zh: L('选出中文意思', 'Pick the meaning'), mc_zh2en: L('选出对应的词', 'Pick the matching word'), mc_syn: L('选出意思最接近的词（同义词）', 'Pick the closest word (synonym)'), cloze_book: L('选词填空', 'Fill in the blank'), ai_cloze: L('选词填空', 'Fill in the blank'), type_meaning: L('写出中文意思', 'Write the meaning') }[q.type];
  let prompt = '';
  if (q.type === 'mc_syn') prompt = `<div class="hw-row"><div class="hw">${esc(w.w)}</div><div class="hw-pron">${pronHtml(w)}</div></div><div class="pos">${esc(q.sense.pos)}</div>`;
  else if (q.type === 'mc_en2zh' || q.type === 'type_meaning') prompt = `<div class="hw-row"><div class="hw">${esc(w.w)}</div><div class="hw-pron">${pronHtml(w)}</div></div>${q.type === 'mc_en2zh' ? `<div class="pos">${esc(q.sense.pos)}</div>` : ''}`;
  else if (q.type === 'mc_zh2en') prompt = `<div class="prompt-zh">${esc(zhGloss(q.sense))}</div><div class="pos">${esc(q.sense.pos)}</div>`;
  else if (q.type === 'mc_def2word') prompt = `<div class="prompt-def">${esc(q.def.text)}</div><div class="pos">${esc(q.sense.pos)} · ${L('释义来自', 'definition from ')}${esc(q.def.src === '书' ? L('书', 'the book') : q.def.src)}</div>`;
  else {
    const sentence = q.type === 'cloze_book' ? esc(q.sentence).replace(esc(q.hit), '<span class="blank"></span>') : esc(q.sentence).replace('____', '<span class="blank"></span>');
    prompt = `<div class="sent">${sentence}</div>`;
  }
  let body = '';
  if (q.opts) body = `<div class="opts">${q.opts.map((o, i) => `<button class="opt${q.en ? ' en' : ''}" data-i="${i}" id="opt-${i}"><span class="k">${i + 1}</span><span class="v">${esc(o.text)}</span></button>`).join('')}</div>
    <button class="btn ghost sm unk" id="unk">${L('不认识', 'Don’t know')} <span class="kbd">0</span></button>`;
  else body = `<form class="typebox" id="typeform" autocomplete="off"><input id="ans" placeholder="${L('中文意思或关键词，也可以写英文释义', 'The meaning or key words, in English or Chinese')}" enterkeyhint="done" autocapitalize="off"><div class="row"><button class="btn primary" type="submit">${L('提交', 'Submit')}</button><button class="btn" type="button" id="unk">${L('不认识', 'Don’t know')}</button></div></form>`;

  app().innerHTML = `${sessionTop()}
  <div class="card ruled q" id="qcard" data-word="${esc(w.id)}">
    <div class="q-meta"><span>${typeLabel}</span><span class="row" style="gap:6px">${tags.join('')}</span></div>
    ${prompt}
  </div>
  ${body}
  <div id="after"></div>`;
  $('#exit').addEventListener('click', exitSession);
  app().querySelectorAll('.opt').forEach((b) => b.addEventListener('click', () => (S.session?.answered ? openOption(+b.dataset.i) : answerMc(+b.dataset.i))));
  $('#unk')?.addEventListener('click', () => (q.opts ? answerMc(-1) : answerTyped('', true)));
  $('#typeform')?.addEventListener('submit', (e) => { e.preventDefault(); answerTyped($('#ans').value); });
  if (q.type === 'type_meaning') setTimeout(() => $('#ans')?.focus(), 30);
  window.scrollTo(0, 0);
  q.start = Date.now();
}

function answerMc(i) {
  const s = S.session, q = s.q;
  if (!q || s.answered) return;
  const ok = i === q.answer;
  const chosen = i >= 0 ? q.opts[i].text : null;
  q.chosenUnknown = i < 0;
  q.pickedId = pickedWordId(q, i);
  let g = 0;
  if (q.item.screen || q.item.pre) q.screen = finishScreen(q, ok, ok ? null : chosen);
  else g = finishItem(q, { ok, chosen: ok ? null : chosen, known: q.item.known });
  s.answered = { ok, g };
  app().querySelectorAll('.opt').forEach((b, j) => { b.classList.add('done'); if (j === q.answer) b.classList.add('right'); else if (j === i) b.classList.add('wrong'); glossOption(b, q, j); });
  $('#unk')?.remove();
  if (q.sentence) { const bl = $('#qcard .blank'); if (bl) { bl.className = 'fill'; bl.textContent = q.type === 'cloze_book' ? q.hit : q.opts[q.answer].text; } }
  showAfter(q, ok, g);
}
async function answerTyped(text, giveUp = false) {
  const s = S.session, q = s.q;
  if (!q || s.answered) return;
  const ms = Date.now() - q.start;
  let verdict = giveUp ? 'wrong' : localJudge(q.w, text);
  let feedback = '';
  if (verdict === 'unsure') {
    if (S.sample && !S.aiOff) {
      s.answered = { pending: true };
      $('#after').innerHTML = `<div class="muted small"><span class="spin"></span> ${L('AI 助教 正在判断你的答案', 'The AI tutor is checking your answer')}</div>`;
      try {
        const r = await aiJudge(q.w, text);
        verdict = ['correct', 'partial', 'wrong'].includes(r?.verdict) ? r.verdict : 'partial';
        feedback = r?.feedback || '';
      } catch (e) { toast(aiErr(e)); verdict = 'partial'; feedback = L('没能联系 AI 助教。对照下面的释义看看，稍后会换个题型再考你。', 'Couldn’t reach the AI tutor. Compare with the definition below; you’ll be retested in another format shortly.'); }
      s.answered = null;
    } else { verdict = 'partial'; feedback = L('没有 AI 助教 可以判断这个答案。对照下面的释义看看，稍后会换个题型再考你。', 'No AI tutor is available to check this answer. Compare with the definition below; you’ll be retested in another format shortly.'); }
  }
  const ok = verdict !== 'wrong';
  q.start = Date.now() - ms; // AI latency doesn't count toward answer time
  const g = finishItem(q, { ok, partial: verdict === 'partial', noGrade: verdict === 'partial', chosen: ok ? null : text || '（不认识）' });
  s.answered = { ok, g, verdict };
  $('#typeform')?.querySelectorAll('button,input').forEach((el) => (el.disabled = true));
  showAfter(q, ok, g, { verdict, feedback, text });
}
const GRADE_TXT = { 1: L('记为不会', 'Graded: didn’t know'), 2: L('记为模糊', 'Graded: shaky'), 3: L('记为认识', 'Graded: knew it'), 4: L('记为很熟', 'Graded: knew it cold') };
function nextText(card) {
  if (!card?.due) return '';
  const d = Math.round((card.due - dayStart()) / DAY);
  return d <= 0 ? L('今天再见', 'back later today') : d === 1 ? L('明天再见', 'back tomorrow') : L(`${d} 天后再见`, `back in ${d} days`);
}
function afterNote(q, g, card) {
  if (q.screen === 'skip') return L(`斩！${SCREEN_DAYS} 天后抽查一次`, `Marked known! Spot-check in ${SCREEN_DAYS} days`);
  if (q.screen === 'zhanned') return L(`斩！${SCREEN_DAYS} 天后抽查一次`, `Marked known! Spot-check in ${SCREEN_DAYS} days`);
  if (q.screen === 'unskipped') return L('改为重新学：几题后考它的用法，答题情况决定之后的复习', 'Back to learning: it comes up again in a few questions, and your answers set the reviews');
  if (q.screen === 'learn' && q.hslow) return L('答对了，但不够快，难词就不斩了：看一下释义，几题后再考', 'Right, but not fast enough to skip a hard word: check the definition; it comes back in a few questions');
  if (q.screen === 'slow' && q.lookBlocked) return L('24 小时内查过这个词，不斩：算认识 · ', 'Looked up in the last 24 h, so not skipped; counted as known · ') + nextText(card);
  if (q.screen === 'slow' && !q.item.pre) return L('认识，但不够快：按普通复习安排 · ', 'Known, but not fast: scheduled as a normal review · ') + nextText(card);
  if (q.screen === 'learn') return L('先看看下面的释义，几题后再考你', 'Read the definition below; it comes back in a few questions');
  if (q.screen === 'slow' && q.item.pre) return L('答对了，但想了挺久，像是蒙的：看一下释义，几题后再考', 'Right, but slow, so maybe a guess: check the definition; it comes back in a few questions');
  if (q.screen === 'known') return L('认识，不用再看卡片 · ', 'Known, no need for the card · ') + nextText(card);
  if (g) return GRADE_TXT[g] + (q.lookupCapped ? L('（24 小时内查过这个词，最多记为认识）', ' (looked up in the last 24 h, so “knew it” at most)') : '') + ' · ' + nextText(card);
  if (q.inserted?.retest) return L('先不计分，几题后换个题型再考一次', 'Not graded yet; retested in another format in a few questions');
  if (q.item.retry || q.item.extra) return L('巩固练习，不改变复习计划', 'Extra practice; the schedule doesn’t change');
  if (q.weak) return L('答对了，但这题太简单或这个词还没到期，不延长间隔', 'Right, but the question was easy or the word wasn’t due, so the interval stays');
  return L('今天已评过分', 'Already graded today');
}
// The reasoning behind a grade and a date, in one line the learner can check (shown under "为什么").
function whyGrade(q, g, card) {
  if (!g || !card?.s) return '';
  const kind = KIND[q.type];
  const parts = [];
  if (g === 1) parts.push(L('答错记为“不会”', 'a wrong answer counts as “didn’t know”'));
  else if (q.type === 'type_meaning') parts.push(L('写释义题不计时，判对就记为“认识”', 'written answers aren’t timed; a correct one counts as “knew it”'));
  else {
    const secs = ((q.answeredAt || Date.now()) - q.start) / 1000;
    const slow = slowMs(kind, q.type, q.def?.text) / 1000;
    parts.push(L(`用时 ${secs.toFixed(1)} 秒；这类题超过 ${slow.toFixed(1)} 秒算“模糊”（你平时的 1.6 倍，有保底）`, `took ${secs.toFixed(1)} s; over ${slow.toFixed(1)} s counts as “shaky” for this question type (1.6× your usual time, with a floor)`));
    if (g === 4) parts.push(L('较难题型上很快答对，记为“很熟”', 'a fast correct answer on a harder format counts as “knew it cold”'));
    if (q.lookupCapped) parts.push(L('24 小时内查过这个词，最多记为“认识”', 'looked up in the last 24 h, so “knew it” at most'));
  }
  const days = Math.max(1, Math.round((card.due - dayStart()) / DAY));
  parts.push(L(`FSRS 估计记忆稳定度 ${card.s < 10 ? card.s.toFixed(1) : Math.round(card.s)} 天，按 90% 记住率安排在 ${days} 天后`, `FSRS estimates memory stability at ${card.s < 10 ? card.s.toFixed(1) : Math.round(card.s)} days and, aiming for 90% recall, schedules it in ${days} days`));
  const out = parts.join(L('；', '; ')) + L('。', '.');
  return window.LANG === 'en' ? out[0].toUpperCase() + out.slice(1) : out;
}
function showAfter(q, ok, g, typed = null) {
  markView();
  const card = S.L.cards[q.w.id];
  const vClass = typed?.verdict === 'partial' ? 'mid' : ok ? 'ok' : 'bad';
  const vText = typed?.verdict === 'partial' ? L('部分正确', 'Partly right') : q.screen === 'unskipped' ? L('重新学', 'Relearn') : q.screen === 'zhanned' ? L('已斩', 'Marked known') : q.screen === 'skip' || q.screen === 'known' ? L('认识', 'Known') : q.hslow ? L('答对了', 'Right') : q.screen === 'learn' ? (q.chosenUnknown ? L('新词', 'New word') : L('答错了', 'Wrong')) : q.screen === 'slow' && q.item.pre ? L('答对了', 'Right') : ok ? L('正确', 'Correct') : L('答错了', 'Wrong');
  const canFlag = (q.type === 'ai_cloze' || q.type === 'cloze_book') && !q.item.screen;
  const canRelearn = q.screen === 'skip' || q.screen === 'known' || (q.screen === 'slow' && !q.item.pre);
  const canZhan = ok && !['skip', 'unskipped', 'zhanned'].includes(q.screen) && typed?.verdict !== 'partial';
  const ai = S.sample && !S.aiOff;
  const cached = S.L.ai[q.w.id]?.ex;
  $('#after').innerHTML = `
    <div class="sec">
      <div class="verdict ${vClass}">${vText}<small>${afterNote(q, g, card)}</small></div>
      ${g && card?.s ? `<details class="why muted small"><summary>${L('为什么', 'Why')}</summary>${esc(whyGrade(q, g, card))}</details>` : ''}
      ${pickedHtml(q)}
      ${typed?.feedback ? `<div class="feedback">${esc(typed.feedback)}</div>` : ''}
      ${q.why ? `<div class="feedback">${esc(q.why)}</div>` : ''}
      ${q.sentence && q.zh ? `<div class="muted small">${esc(q.zh)}</div>` : ''}
      <div class="next-row"><button class="btn primary" id="next">${L('继续', 'Continue')} <span class="kbd">Enter</span></button>${ai ? `<button class="btn" id="askc">${L('问 AI 助教', 'Ask the AI tutor')}</button>` : ''}</div>
      ${canZhan || canRelearn || q.screen === 'zhanned' ? `<div class="row" style="gap:8px">${canZhan ? `<button class="btn sm" id="zhanq">${L(`斩（${SCREEN_DAYS} 天后抽查）`, `Mark known (spot-check in ${SCREEN_DAYS} days)`)}</button>` : ''}${q.screen === 'zhanned' ? `<button class="btn sm" id="unzhanq">${L('撤销斩', 'Undo')}</button>` : ''}${canRelearn ? `<button class="btn sm" id="relearn">${L('其实不熟，学一下', 'Not sure after all; learn it')}</button>` : ''}</div>` : ''}
      <div id="autonote" class="autonote"></div>
      ${canFlag ? `<button class="link small" id="flag" style="align-self:flex-start">${L('这题有问题，不计分', 'Problem with this question? Don’t grade it')}</button>` : ''}
      <div class="card reveal">${entryHtml(q.w, { compact: ok })}<div id="aibox">${cached ? aiExplainHtml(cached) : ''}</div></div>
    </div>`;
  bindEntryLinks($('#after'));
  $('#picked')?.addEventListener('click', () => { cancelAuto(); openWord(q.pickedId); });
  $('#relearn')?.addEventListener('click', () => { cancelAuto(); relearn(q.w.id); q.screen = 'unskipped'; showAfter(q, ok, g, typed); });
  $('#zhanq')?.addEventListener('click', () => { cancelAuto(); zhanFromAnswer(q); showAfter(q, ok, g, typed); });
  $('#unzhanq')?.addEventListener('click', () => { undoZhanFromAnswer(q); showAfter(q, ok, g, typed); });
  withMw(q.w.id);
  $('#next').addEventListener('click', advance);
  $('#askc')?.addEventListener('click', () => { cancelAuto(); openChatForWord(q.w.id, q.sense ? senseKey(q.sense) : ''); });
  $('#flag')?.addEventListener('click', () => flagQuestion(q));
  $('#after').addEventListener('pointerdown', (e) => { if (e.target.id !== 'next') cancelAuto(); }, { once: true });
  if (ok && S.L.prefs.autoNext && q.opts && !typed && q.screen !== 'unskipped' && q.screen !== 'zhanned') {
    $('#autonote').textContent = L('1.5 秒后自动下一题，点卡片可停下来细看', 'Next question in 1.5 s; tap the card to stop and look');
    S.autoT = setTimeout(advance, 1500);
  } else {
    $('#next').focus({ preventScroll: true });
  }
}
function pickedHtml(q) {
  const x = q.pickedId && S.byId.get(q.pickedId);
  if (!x) return '';
  const g = zhGloss(senseFor(x));
  const again = [q.inserted, ...S.session.items.slice(S.session.idx + 1)].some((it) => it?.id === q.w.id && it.with?.includes(x.id));
  const what = q.type === 'mc_en2zh' ? L(`你选的是 <button class="link" id="picked">${esc(x.w)}</button> 的意思`, `You picked the meaning of <button class="link" id="picked">${esc(x.w)}</button>`) : L(`你选的 <button class="link" id="picked">${esc(x.w)}</button> 是：${esc(g)}`, `You picked <button class="link" id="picked">${esc(x.w)}</button>: ${esc(g)}`);
  return `<div class="small pickednote">${what}${again ? L(`。几题后 ${esc(q.w.w)} 和 ${esc(x.w)} 会一起出现在选项里，再分一次`, `. ${esc(q.w.w)} and ${esc(x.w)} will appear together as options in a few questions, so you can tell them apart`) : ''}</div>`;
}
// A broken or ambiguous question shouldn't leave a mark: restore the card and drop the retry.
function flagQuestion(q) {
  cancelAuto();
  const s = S.session;
  const id = q.w.id;
  if (q.prevHad) S.L.cards[id] = { ...q.prev, u: Date.now() }; else delete S.L.cards[id];
  markDirty(id);
  if (q.inserted) { const k = s.items.indexOf(q.inserted, s.idx + 1); if (k > -1) s.items.splice(k, 1); }
  const log = S.L.sessions[s.sid].items;
  if (log.length) log[log.length - 1].fl = 1;
  s.done--; if (s.answered?.ok) s.right--;
  saveLocal(); schedulePush();
  const v = $('#after .verdict');
  if (v) v.innerHTML = L('已标记为问题题目<small>这题不计分，复习计划不变</small>', 'Flagged as a bad question<small>Not graded; your schedule is unchanged</small>');
  $('#flag')?.remove();
}
function cancelAuto() { clearTimeout(S.autoT); const n = $('#autonote'); if (n) n.textContent = ''; }
function advance() { const s = S.session; if (!s) return; clearTimeout(S.autoT); s.idx++; showQuestion(); }

function showLearn(item) {
  const s = S.session;
  const w = S.byId.get(item.id);
  s.q = { learn: true, w, item, start: Date.now() };
  const ai = S.sample && !S.aiOff;
  const cached = S.L.ai[w.id]?.ex;
  s.q.hidden = true;
  app().innerHTML = `${sessionTop()}
  <div class="card ruled q" data-word="${esc(w.id)}">
    <div class="q-meta"><span>${L('新词', 'New word')}</span><span class="row" style="gap:6px">${w.tags.includes('trap') ? `<span class="tag trap">${L('熟词僻义', 'Uncommon meaning')}</span>` : ''}</span></div>
    <div class="hw-row"><div class="hw">${esc(w.w)}</div><div class="hw-pron">${pronHtml(w)}</div></div>
    <div id="learnbody" hidden>${entryHtml(w, { bare: true })}<div id="aibox">${cached ? aiExplainHtml(cached) : ''}</div></div>
  </div>
  <div id="learnact">
    <div class="next-row"><button class="btn primary" id="reveal">${L('看释义', 'Show definition')} <span class="kbd">Enter</span></button><button class="btn" id="zhan">${L('斩', 'I know it')}</button></div>
    <div class="muted small">${L(`较难的词。认识就点斩，${screenSecTxt()} 秒内选对中文意思就跳过（${SCREEN_DAYS} 天后抽查）；不确定就看释义，几题后会考。`, `A harder word. If you know it, tap “I know it”: pick the right meaning within ${screenSecTxt()} s and it’s skipped (spot-check in ${SCREEN_DAYS} days). If unsure, read the definition; it’ll be tested in a few questions.`)}</div>
  </div>`;
  $('#exit').addEventListener('click', exitSession);
  bindEntryLinks(app());
  withMw(w.id);
  $('#reveal').addEventListener('click', () => revealLearn());
  $('#zhan').addEventListener('click', () => startZhan());
  window.scrollTo(0, 0);
}
function revealLearn() {
  const s = S.session, q = s?.q;
  if (!q?.learn || !q.hidden) return;
  q.hidden = false;
  markView();
  $('#learnbody').hidden = false;
  const ai = S.sample && !S.aiOff;
  $('#learnact').innerHTML = `<div class="next-row"><button class="btn primary" id="learned">${L('记住了', 'Got it')} <span class="kbd">Enter</span></button><button class="btn" id="zhan">${L('斩', 'I know it')}</button>${ai ? `<button class="btn" id="askc">${L('问 AI 助教', 'Ask the AI tutor')}</button>` : ''}</div>
    <div class="muted small">${L(`几题之后会考，选项会混进这一批的其他新词；答题情况决定什么时候复习。看完发现本来就认识，可以直接斩（${SCREEN_DAYS} 天后抽查）。`, `It’ll be tested in a few questions, with other new words from this batch as options; your answers decide when it comes back. If it turns out you already knew it, tap “I know it” (spot-check in ${SCREEN_DAYS} days).`)}</div>`;
  $('#learned').addEventListener('click', () => doneLearn());
  $('#zhan').addEventListener('click', () => zhanAfterReveal());
  $('#askc')?.addEventListener('click', () => openChatForWord(q.w.id));
}
// 斩 before seeing the meaning: one timed pick-the-meaning item, like screening
function startZhan() {
  const s = S.session, q = s?.q;
  if (!q?.learn || !q.hidden) return;
  s.items[s.idx] = { id: q.w.id, lv: 2, screen: true, hard: true, type: firstCheck(q.w.id) };
  showQuestion();
}
// 斩 after reading the card: a pick-the-meaning question now would give itself away, so it's taken
// on trust (a lookup in the last 24 h makes it "known" instead), with an undo.
function zhanAfterReveal() {
  const s = S.session, q = s?.q;
  if (!q?.learn || q.hidden) return;
  const id = q.w.id, now = Date.now(), at = s.idx;
  const prevHad = id in S.L.cards, prev = { ...(S.L.cards[id] || {}) };
  const looked = lookedUpRecently(id);
  S.L.cards[id] = looked
    ? { ...fsrsReview({}, 3, now, q.w.df ?? 0.6), intro: now }
    : { st: 2, s: SCREEN_DAYS, d: clampD(initD(4) + 2 * ((q.w.df ?? 0.6) - 0.5)), reps: 1, lapses: 0, due: dayStart(now) + SCREEN_DAYS * DAY, last: now, u: now, day: dayKey(now), scr: 5, intro: now };
  const removed = dropQueued(id);
  markDirty(id);
  logAnswer({ i: id, k: 'zhan', ok: 1, ms: now - q.start, g: 0, o: looked ? 'known' : 'skip' });
  const entry = S.L.sessions[s.sid]?.items.at(-1);
  saveLocal(); schedulePush();
  s.done++; s.right++;
  s.idx++; showQuestion();
  toast(looked ? L('24 小时内查过这个词，算认识，3 天后复习', 'Looked up in the last 24 h, so counted as known; review in 3 days') : L(`已斩 ${q.w.w}，${SCREEN_DAYS} 天后抽查`, `Marked ${q.w.w} known; spot-check in ${SCREEN_DAYS} days`), 5000, {
    label: L('撤销', 'Undo'),
    fn: () => {
      if (S.session !== s) return;
      if (s.idx !== at + 1 || s.answered || (s.q?.learn && !s.q.hidden)) { toast(L('已经往下做了，撤销不了；这个词 45 天后会抽查', 'Too late to undo, you’ve moved on; this word gets a spot-check in 45 days')); return; }
      if (prevHad) S.L.cards[id] = { ...prev, u: Date.now() }; else delete S.L.cards[id];
      markDirty(id);
      for (const r of removed) s.items.splice(Math.min(r.j, s.items.length), 0, r.it);
      if (entry) entry.fl = 1;
      s.done--; s.right--;
      s.idx = at; saveLocal(); schedulePush();
      showQuestion();
      revealLearn();
    },
  });
}
function doneLearn() {
  const known = false;
  const s = S.session, q = s.q;
  if (!q?.learn) return;
  const id = q.w.id;
  const now = Date.now();
  S.L.cards[id] = { ...(S.L.cards[id] || {}), intro: now, u: now, st: 0 };
  markDirty(id);
  logAnswer({ i: id, k: 'learn', ok: 1, ms: now - q.start, g: 0, ...(known ? { kn: 1 } : {}) });
  if (known) {
    // replace the scheduled check with an immediate harder one
    const at = s.items.findIndex((it, j) => j > s.idx && it.id === id && it.check);
    if (at > -1) s.items.splice(at, 1);
    const hasEn = !!q.w.senses[0]?.en;
    s.items.splice(s.idx + 1, 0, { id, lv: 3, check: true, known: true, type: hasEn && bookCloze(q.w) ? 'cloze_book' : 'mc_zh2en' });
  }
  saveLocal(); schedulePush();
  s.idx++; showQuestion();
}
function showSummary() {
  markView();
  const s = S.session;
  const log = S.L.sessions[s.sid]?.items || [];
  const graded = log.filter((x) => x.k !== 'learn' && !x.fl);
  const learned = log.filter((x) => !x.fl && (x.k === 'learn' || x.o === 'learn' || x.k === 'unskip')).length;
  const skipped = log.filter((x) => !x.fl && !x.us && ((x.k === 'screen' && x.o === 'skip') || (x.k === 'pre' && x.o === 'known') || x.k === 'zhan')).length;
  const wrongIds = [...new Set(graded.filter((x) => !x.ok).map((x) => x.i))];
  const mins = Math.round(log.reduce((a, x) => a + Math.min(x.ms || 0, 60000), 0) / 60000);
  saveLocal(true); push();
  app().innerHTML = `
  <div class="card ruled today">
    <div class="today-head"><b>${L('这一轮完成', 'Round complete')}</b><span class="muted small">${L(`约 <span class="num">${Math.max(1, mins)}</span> 分钟`, `About <span class="num">${Math.max(1, mins)}</span> min`)}</span></div>
    <div class="counts">
      <div class="count"><div class="n">${graded.length}</div><div class="l">${L('答题', 'Answered')}</div></div>
      <div class="count"><div class="n">${graded.length ? Math.round(graded.filter((x) => x.ok).length / graded.length * 100) : 0}%</div><div class="l">${L('正确率', 'Correct')}</div></div>
      <div class="count"><div class="n">${learned}</div><div class="l">${L('新学', 'Learned')}${skipped ? L(` · 已认识 ${skipped}`, ` · ${skipped} already known`) : ''}</div></div>
    </div>
    <div class="row"><button class="btn primary" id="back">${L('回到今日', 'Back to Today')}</button></div>
  </div>
  ${wrongIds.length ? `<section class="sec"><h2>${L('这轮答错的词', 'Missed this round')}</h2><div class="list">${wrongIds.map((id) => { const w = S.byId.get(id); return `<button class="item" data-word="${esc(id)}"><div><div class="t">${esc(w.w)}</div><div class="s">${esc(zhGloss(senseFor(w)))}</div></div><span class="go">›</span></button>`; }).join('')}</div></section>` : ''}`;
  bindEntryLinks(app());
  $('#back').addEventListener('click', exitSession);
}

document.addEventListener('keydown', (e) => {
  if (!S.session || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
  const s = S.session;
  if (document.activeElement?.tagName === 'INPUT') return;
  if ($('#overlay').firstChild) return;
  if (tooSoon()) { if (e.key === 'Enter' || /^[0-4`]$/.test(e.key)) e.preventDefault(); return; }
  if (s.q?.learn) { if (e.key === 'Enter') { e.preventDefault(); if (s.q.hidden) revealLearn(); else doneLearn(); } return; }
  if (!s.answered && s.q?.opts) {
    if (/^[1-4]$/.test(e.key)) { e.preventDefault(); answerMc(+e.key - 1); }
    else if (e.key === '0' || e.key === '`') { e.preventDefault(); answerMc(-1); }
  } else if (s.answered && !s.answered.pending && e.key === 'Enter') { e.preventDefault(); advance(); }
});

// ---------- word bank ----------
function cardChip(c) {
  const m = masteryOf(c);
  if (!m) return `<span class="lv" style="background:var(--soft);color:var(--muted)">${MASTERY[0]}</span>`;
  const fg = m >= 3 ? 'var(--accent-ink)' : 'var(--ink)';
  const bg = ['', 'var(--l2)', 'var(--l3)', 'var(--l4)', 'var(--l5)'][m];
  return `<span class="lv" style="background:${bg};color:${m >= 2 ? 'var(--card)' : fg}">${MASTERY[m]}</span>`;
}
// Word bank: search plus three combinable filters (source × status × Word List) and a sort order.
const BANK_SRC = [['all', L('全部来源', 'All sources')], ['core', L('词表', 'Word list')], ['supplement', L('补充', 'Supplement')], ['trap', L('熟词僻义', 'Uncommon meanings')], ['shift', L('冷门义', 'Rare senses')], ['confusable', L('形近词', 'Look-alikes')], ['custom', L('自己添加', 'Added by you')]];
const BANK_ST = [['all', L('全部状态', 'Any status')], ['new', L('未学', 'New')], ['m1', L('学习中', 'Learning')], ['m2', L('熟悉', 'Familiar')], ['m3', L('掌握', 'Known')], ['m4', L('牢固', 'Solid')], ['due', L('今天到期', 'Due today')], ['hard', L('对我很难', 'Hard for me')], ['wrong', L('常错', 'Often missed')], ['notes', L('有笔记', 'With notes')], ['asked', L('问过 AI 助教', 'Asked the AI tutor')]];
const BANK_SORT = [['book', L('词表顺序', 'List order')], ['az', L('字母顺序', 'A–Z')], ['hard', L('对我最难的在前', 'Hardest for me first')], ['weak', L('最不牢的在前', 'Weakest first')], ['recent', L('最近复习的在前', 'Recently reviewed first')], ['touched', L('最近记笔记/提问的在前', 'Recent notes/questions first')], ['shuffle', L('随机顺序', 'Shuffled')]];
// "hard for me": stumbled more than once. One wrong first answer already puts FSRS difficulty at 7.2,
// a second at 8.1, so D >= 7.5, two lapses, or two wrong answers in the recent logs.
function wrongCounts() {
  const m = {};
  for (const s of Object.values(S.L.sessions)) for (const it of s.items || []) if (!it.ok && !it.fl && it.k !== 'learn' && it.k !== 'drill') m[it.i] = (m[it.i] || 0) + 1;
  return m;
}
const isHardForMe = (c, wrong, looks = 0) => !!(c?.st && ((c.d || 0) >= 7.5 || (c.lapses || 0) >= 2 || wrong >= 2 || looks >= 2));
const hardScore = (c, wrong, looks = 0) => (c?.st ? (c.d || 0) * 100 + (c.lapses || 0) * 10 + Math.min(9, (wrong || 0) + looks) : -1);
function bankMatches(w, { src, st, list }, now, wrong = {}) {
  const c = S.L.cards[w.id];
  if (src === 'shift' ? !(w.shift || w.rare) : src !== 'all' && !w.tags.includes(src)) return false;
  if (src === 'core' && list !== 'all') {
    if (list === 'reading' ? w.section !== 'reading' : (w.section === 'reading' || String(w.list) !== list)) return false;
  }
  switch (st) {
    case 'new': return !c?.st;
    case 'm1': case 'm2': case 'm3': case 'm4': return masteryOf(c) === +st[1];
    case 'due': return !!(c?.st && c.due <= now);
    case 'hard': return isHardForMe(c, wrong[w.id] || 0, lookupsOf(w.id).length);
    case 'wrong': return !!(c?.lapses >= 1 || (c && c.st && c.s < 2));
    case 'notes': return notesOf(w.id).length > 0;
    case 'asked': return !!S.L.asked[w.id];
    default: return true;
  }
}
function shufKey(id, seed) { let h = Math.floor(seed * 2 ** 31); for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 2654435761); return (h >>> 0) / 2 ** 32; }
function renderBank() {
  const B = S.bank;
  B.src ||= 'all'; B.st ||= 'all'; B.list ||= 'all'; B.sort ||= 'book';
  const ql = B.q.trim().toLowerCase();
  const now = Date.now();
  const order = S._bookOrder ||= new Map(S.words.map((w, i) => [w.id, i]));
  const wrong = wrongCounts();
  let list = S.words.filter((w) => {
    if (!bankMatches(w, B, now, wrong)) return false;
    if (!ql) return true;
    if (/[一-鿿]/.test(ql)) return [...w.senses, ...(w.trapSenses || [])].some((x) => x.zh.includes(ql));
    return w.w.toLowerCase().includes(ql) || (w.derived || []).some((d) => d.w.toLowerCase().includes(ql));
  });
  const touched = (id) => Math.max(S.L.asked[id] || 0, ...notesOf(id).map((n) => n.at));
  const sorters = {
    book: (a, b) => (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9),
    az: (a, b) => a.w.localeCompare(b.w),
    hard: (a, b) => hardScore(S.L.cards[b.id], wrong[b.id], lookupsOf(b.id).length) - hardScore(S.L.cards[a.id], wrong[a.id], lookupsOf(a.id).length),
    weak: (a, b) => (S.L.cards[a.id]?.st ? S.L.cards[a.id].s : 1e9) - (S.L.cards[b.id]?.st ? S.L.cards[b.id].s : 1e9),
    recent: (a, b) => (S.L.cards[b.id]?.last || 0) - (S.L.cards[a.id]?.last || 0),
    touched: (a, b) => touched(b.id) - touched(a.id),
    // stable within a visit, so the grid doesn't reshuffle after opening a card
    shuffle: (a, b) => shufKey(a.id, B.seed) - shufKey(b.id, B.seed),
  };
  list.sort(sorters[B.sort] || sorters.book);
  if (ql && !/[一-鿿]/.test(ql)) list.sort((a, b) => (b.w.toLowerCase().startsWith(ql) - a.w.toLowerCase().startsWith(ql)) || ((a.w.toLowerCase() === ql) ? -1 : (b.w.toLowerCase() === ql) ? 1 : 0));
  const total = list.length;
  const grid = B.view === 'grid';
  if (B.zh == null) { try { B.zh = localStorage.getItem('bankZh') === '1'; } catch { B.zh = false; } }
  const lim = grid ? Math.max(B.limit, 400) : B.limit;
  const shown = list.slice(0, lim);
  const ai = S.sample && !S.aiOff;
  const canLook = /^[a-z][a-z '\-.,]{1,200}$/.test(ql) && !S.words.some((w) => w.w.toLowerCase() === ql);
  const hardN = S.words.filter((w) => isHardForMe(S.L.cards[w.id], wrong[w.id] || 0, lookupsOf(w.id).length)).length;
  const counts = { notes: Object.values(S.L.notes).filter((n) => n.items?.length).length, asked: Object.keys(S.L.asked).filter((id) => S.byId.has(id)).length };
  const lists = [...new Set(S.words.filter((w) => w.tags[0] === 'core' && w.section !== 'reading' && w.list != null).map((w) => w.list))].sort((a, b) => a - b);
  const sel = (id, opts, val, label) => `<label class="bsel"><span class="sr">${label}</span><select id="${id}">${opts.map(([k, n]) => `<option value="${k}" ${val === k ? 'selected' : ''}>${n}</option>`).join('')}</select></label>`;
  const listOpts = [['all', L('全部 Word List', 'All Word Lists')], ...lists.map((n) => [String(n), `Word List ${n}`]), ['reading', L('阅读词汇', 'Reading vocabulary')]];
  const badges = (w) => `${notesOf(w.id).length ? `<span class="tag">${L('笔记', 'Notes')}</span>` : ''}${S.L.asked[w.id] ? `<span class="tag ai">${L('问过', 'Asked')}</span>` : ''}`;
  const showHard = B.sort === 'hard' || B.st === 'hard';
  const hardInfo = (w) => { const c = S.L.cards[w.id]; if (!c?.st) return ''; const bits = [L(`难度 ${(c.d || 0).toFixed(1)}`, `difficulty ${(c.d || 0).toFixed(1)}`)]; if (c.lapses) bits.push(L(`遗忘 ${c.lapses} 次`, `forgotten ${c.lapses}×`)); if (wrong[w.id]) bits.push(L(`近期错 ${wrong[w.id]} 次`, `missed ${wrong[w.id]}× recently`)); const lk = lookupsOf(w.id).length; if (lk) bits.push(L(`查过 ${lk} 次`, `looked up ${lk}×`)); return bits.join(' · ') + ' · '; };
  const rowSub = (w) => `${showHard ? hardInfo(w) : ''}${w.tags[0] === 'core' ? (w.section === 'reading' ? L('阅读 · ', 'Reading · ') : w.list ? `L${w.list} · ` : '') : ''}${(zhGloss(senseFor(w)) || L('中文待补 · ', 'No Chinese gloss yet · ') + (w.senses[0]?.en || '')).slice(0, 36)}`;
  // the marker widens the page on wide screens (CSS :has); question pages stay 600px
  app().innerHTML = `${topBar()}<span class="bank-wide" hidden></span>
  <div class="search">
    <input id="q" type="search" placeholder="${L('搜词库（含派生词、中文释义），也能直接查任意英文词', 'Search your words (incl. derived forms and Chinese glosses), or look up any English word')}" value="${esc(B.q)}" autocomplete="off" autocapitalize="off">
    <div class="bfilters">
      ${sel('bsrc', BANK_SRC, B.src, L('来源', 'Source'))}
      ${B.src === 'core' && lists.length > 1 ? sel('blist', listOpts, B.list, 'Word List') : ''}
      ${sel('bst', BANK_ST, B.st, L('状态', 'Status'))}
      ${sel('bsort', BANK_SORT, B.sort, L('排序', 'Sort'))}
    </div>
    <div class="filters">
      <button data-quick="notes" aria-pressed="${B.st === 'notes'}">${L('有笔记', 'With notes')} ${counts.notes}</button>
      <button data-quick="asked" aria-pressed="${B.st === 'asked'}">${L('问过 AI 助教', 'Asked AI tutor')} ${counts.asked}</button>
      <button data-quick="hard" aria-pressed="${B.st === 'hard'}">${L('对我很难', 'Hard for me')} ${hardN}</button>
      <button data-quick="due" aria-pressed="${B.st === 'due'}">${L('今天到期', 'Due today')}</button>
      <button data-quick="wrong" aria-pressed="${B.st === 'wrong'}">${L('常错', 'Often missed')}</button>
      ${B.src !== 'all' || B.st !== 'all' || B.list !== 'all' ? `<button data-quick="reset">${L('清除筛选', 'Clear filters')}</button>` : ''}
    </div>
  </div>
  <div class="sec-head"><span class="muted small"><span class="num">${total}</span> ${L('个词', total === 1 ? 'word' : 'words')}</span><span class="filters seg"><button data-view="list" aria-pressed="${!grid}">${L('列表', 'List')}</button><button data-view="grid" aria-pressed="${grid}">${L('总览', 'Overview')}</button>${grid ? `<button id="zhtog" aria-pressed="${!!B.zh}">${L('显示中文', 'Show meanings')}</button>` : ''}</span></div>
  ${canLook ? `<button class="item" id="lookup"><div><div class="t">${L('查词：', 'Look up: ')}${esc(B.q.trim())}</div><div class="s">${shown.length ? L('词库里没有这个词本身', 'This exact word isn’t in your words') : L('词库里没有这个词', 'Not in your words')}${L('；会先认变形和派生词，再查 Merriam-Webster，不调用模型', '; checks inflected and derived forms first, then Merriam-Webster. No AI used')}</div></div><span class="go">›</span></button>` : ''}
  ${shown.length && grid ? `<p class="muted small" style="margin:0">${B.zh ? L('快速扫一遍“词：中文”；看中文不算查词，点开词卡才算。', 'Skim word and meaning; seeing the meaning here doesn’t count as a lookup, only opening the card does. ') : L('只显示词，自己过一遍；不确定的点开看释义和 MW。', 'Words only: go through them yourself and open any you’re unsure of for the definition and MW. ')}${L('点开不会加入今天的新词，想学就在词卡里点“加入今天”。', 'Opening a card doesn’t add it to today’s new words; to learn it, tap “Add to today” on the card. ')}${B.zh ? L('左边框', 'The left border') : L('下边框', 'The bottom border')}${L('颜色是掌握程度，没有就是还没学。', ' shows mastery; none means not learned yet.')}</p>${B.zh
    ? `<div class="bzl">${shown.map((w) => { const m = S.L.cards[w.id]?.st ? masteryOf(S.L.cards[w.id]) : 0; return `<button class="bz" data-word="${esc(w.id)}"${m ? ` style="--lvc:var(--l${m})"` : ''}><b>${esc(w.w)}</b><span>${esc(zhGloss(senseFor(w)) || w.senses[0]?.en || '')}</span></button>`; }).join('')}</div>`
    : `<div class="bgrid">${shown.map((w) => { const m = S.L.cards[w.id]?.st ? masteryOf(S.L.cards[w.id]) : 0; return `<button class="bw" data-word="${esc(w.id)}"${m ? ` style="--lvc:var(--l${m})"` : ''}>${esc(w.w)}</button>`; }).join('')}</div>`}` : shown.length ? `<div class="list">${shown.map((w) => `<button class="item" data-word="${esc(w.id)}"><div><div class="t">${esc(w.w)} ${badges(w)}</div><div class="s">${esc(rowSub(w))}</div></div>${cardChip(S.L.cards[w.id])}</button>`).join('')}</div>` : `<div class="empty">${L('没有符合条件的词', 'No matching words')}${ai && ql && !canLook && !/[一-鿿]/.test(ql) ? `${L('。', '. ')}<button class="link" id="add-this">${L(`查词 “${esc(B.q)}”`, `Look up “${esc(B.q)}”`)}</button>` : ''}</div>`}
  ${total > lim ? `<button class="btn" id="more">${L(`再显示 ${Math.min(grid ? 400 : 200, total - lim)} 个`, `Show ${Math.min(grid ? 400 : 200, total - lim)} more`)}</button>` : ''}`;
  const input = $('#q');
  input.addEventListener('input', () => { B.q = input.value; B.limit = 120; clearTimeout(renderBank.t); renderBank.t = setTimeout(() => { renderBank(); const i = $('#q'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }, 180); });
  const set = (patch) => { Object.assign(B, patch, { limit: 120 }); renderBank(); };
  $('#bsrc').addEventListener('change', (e) => set({ src: e.target.value, list: 'all' }));
  $('#blist')?.addEventListener('change', (e) => set({ list: e.target.value }));
  $('#bst').addEventListener('change', (e) => set({ st: e.target.value }));
  $('#bsort').addEventListener('change', (e) => set({ sort: e.target.value }));
  app().querySelectorAll('[data-quick]').forEach((b) => b.addEventListener('click', () => {
    const k = b.dataset.quick;
    if (k === 'reset') set({ src: 'all', st: 'all', list: 'all' });
    else set({ st: B.st === k ? 'all' : k, ...(k === 'notes' || k === 'asked' ? { sort: B.sort === 'book' ? 'touched' : B.sort } : {}), ...(k === 'hard' && B.sort === 'book' ? { sort: 'hard' } : {}) });
  }));
  bindEntryLinks(app());
  $('#more')?.addEventListener('click', () => { B.limit = lim + (grid ? 400 : 200); renderBank(); });
  $('#zhtog')?.addEventListener('click', () => { B.zh = !B.zh; try { localStorage.setItem('bankZh', B.zh ? '1' : '0'); } catch {} renderBank(); });
  app().querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => { if (B.view !== b.dataset.view) { B.view = b.dataset.view; B.limit = 120; renderBank(); } }));
  $('#add-this')?.addEventListener('click', () => openFind(B.q));
  $('#lookup')?.addEventListener('click', () => openFind(B.q));
}

// ---------- overlays ----------
// Sheets stack: opening one from inside another (word card → 问 AI 助教 → a linked word) keeps the
// one below, detached with its state (scroll, draft, a reply still streaming); × / background /
// Esc close only the top one and bring it back. Capped so a long word → chat → word chain can't
// grow forever; 全部关闭 leaves them all once two or more are stacked.
const SHEET_MAX = 8;
const sheetStack = [];   // [{ el, scroll }] under the visible sheet, oldest first
function openSheet(html, onMount) {
  const ov = $('#overlay');
  const cur = ov.firstElementChild;
  if (cur) {
    sheetStack.push({ el: cur, scroll: cur.querySelector('.sheet')?.scrollTop || 0 });
    cur.remove();
    if (sheetStack.length > SHEET_MAX - 1) sheetStack.shift();
  }
  const layer = document.createElement('div');
  layer.className = 'sheet-bg';
  layer.innerHTML = `<div class="sheet" role="dialog" aria-modal="true">${html}</div>`;
  ov.append(layer);
  markView();
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    if (!layer.isConnected) { const i = sheetStack.findIndex((x) => x.el === layer); if (i >= 0) sheetStack.splice(i, 1); return; }
    layer.remove();
    const prev = sheetStack.pop();
    if (prev) { ov.append(prev.el); const sh = prev.el.querySelector('.sheet'); if (sh) sh.scrollTop = prev.scroll; markView(); }
  };
  layer._close = close;
  layer.addEventListener('click', (e) => { if (e.target === layer) close(); });
  layer.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
  if (sheetStack.length) {
    const x = layer.querySelector('.sheet-head .x');
    if (x) { x.insertAdjacentHTML('beforebegin', `<button class="link small closeall">${L('全部关闭', 'Close all')}</button>`); layer.querySelector('.closeall').addEventListener('click', closeAllSheets); }
  }
  onMount?.(ov, close);
  return close;
}
function closeAllSheets() { sheetStack.length = 0; $('#overlay').innerHTML = ''; }
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#overlay').firstElementChild?._close?.(); });

function openWord(id) {
  const w = S.byId.get(id); if (!w) return;
  recordLookup(id);
  const c = S.L.cards[id];
  const looks30 = lookupsOf(id), looks7 = lookupsOf(id, 7 * DAY);
  const lastPrev = looks30.length > 1 ? looks30[looks30.length - 2] : 0;
  const ago = (t) => { const h = (Date.now() - t) / 3600e3; return h < 1 ? L('不到 1 小时前', 'less than an hour ago') : h < 24 ? L(`${Math.round(h)} 小时前`, `${Math.round(h)} h ago`) : L(`${Math.round(h / 24)} 天前`, `${Math.round(h / 24)} days ago`); };
  const hist = [];
  for (const s of Object.values(S.L.sessions)) for (const it of s.items || []) if (it.i === id) hist.push(it);
  hist.sort((a, b) => b.t - a.t);
  const ai = S.sample && !S.aiOff;
  const cached = S.L.ai[id]?.ex;
  const kName = { mc_syn: L('选同义词', 'Pick the synonym'), unskip: L('取消跳过，重新学', 'Unskipped, relearn'), zhan: L('看释义后斩', 'Marked known after reading'), pre: L('新词先测', 'New-word check'), mc_def2word: L('英文释义选词', 'Definition → word'), screen: L('斩词筛查', 'Screening'), learn: L('新学', 'Learned'), mc_en2zh: L('英选中', 'Word → meaning'), mc_zh2en: L('中选英', 'Meaning → word'), cloze_book: L('例句填空', 'Example cloze'), ai_cloze: L('AI 助教 填空', 'AI cloze'), type_meaning: L('写释义', 'Write the meaning') };
  openSheet(`
    <div class="sheet-head">${cardChip(c)}<button class="x" data-close aria-label="${L('关闭', 'Close')}">×</button></div>
    <div class="card reveal">${entryHtml(w)}<div id="aibox">${cached ? aiExplainHtml(cached) : ''}</div></div>
    ${c?.st && looks7.length >= 2 ? `<div class="feedback small">${L(`这周查了 ${looks7.length} 次，要不要加入复习计划？今天先考一次，之后照常滚动复习。`, `Looked up ${looks7.length} times this week. Add it to your reviews? You’ll be tested today, then it rolls on as usual.`)} <button class="btn sm" id="nudge">${L('加入复习计划', 'Add to reviews')}</button></div>` : ''}
    ${w.tags.includes('zhpending') ? `<div class="feedback small" id="zhbox">${L('这个词先用 Merriam-Webster 的英文释义加入，中文释义还没写。', 'Added with the Merriam-Webster definition only; no Chinese gloss yet.')}${S.sample && !S.aiOff ? ` <button class="btn sm" id="fillzh">${L('让 AI 助教 补中文', 'Have the AI tutor add the Chinese')}</button>` : ''}</div>` : ''}
    ${skipStands(id) ? `<div class="feedback small">${c.s >= SCREEN_DAYS - 1 ? L('这个词是斩掉的，没认真学过卡片。', 'You marked this word known without studying its card.') : L('这个词是直接算认识的，没认真学过卡片。', 'This word was counted as known without studying its card.')} <button class="btn sm" id="relearnw">${L('其实不熟，学一下', 'Not sure after all; learn it')}</button></div>` : ''}
    <div class="row">${ai ? `<button class="btn grow" id="askc">${L('问 AI 助教', 'Ask the AI tutor')}</button>` : ''}<button class="btn grow" id="today">${L('加入今日复习', 'Add to today')}</button>${skipStands(id) ? '' : `<button class="btn grow" id="zhanw">${L(`斩（${SCREEN_DAYS} 天后抽查）`, `Mark known (spot-check in ${SCREEN_DAYS} days)`)}</button>`}</div>
    <div class="sec">
      <h2>${L('笔记', 'Notes')}</h2>
      <div id="notelist"></div>
      <form id="notef" class="row" autocomplete="off"><input id="notein" placeholder="${L('写下你的理解、记忆方法或辨析', 'Your understanding, a memory trick, or a distinction')}" style="flex:1 1 200px;min-width:0" class="noteinput"><button class="btn sm" type="submit" style="flex:0 0 auto">${L('保存', 'Save')}</button></form>
    </div>
    ${S.mw.has(id) ? '' : mwState().ok ? `<button class="btn" id="mwlook">${L('查 Merriam-Webster', 'Look up in Merriam-Webster')}</button>` : `<div class="muted small">${esc(mwState().msg)}</div>`}
    <div class="sec">
      <h2>${L('记忆状态', 'Memory status')}</h2>
      ${confusionsOf(id).length ? `<div class="muted small">${L('混淆过：', 'Confused with: ')}${confusionsOf(id).map((x) => `<button class="link" data-conf="${esc(x)}">${esc(S.byId.get(x).w)}</button>`).join(L('、', ', '))}${L('（之后出题会常把它们放在一起）', ' (future questions will often pair them)')}</div>` : ''}
      <div class="muted small">${L(`最近 30 天主动查过 <span class="num">${looks30.length}</span> 次`, `Looked up <span class="num">${looks30.length}</span> times in the last 30 days`)}${lastPrev ? L(`，上一次是${ago(lastPrev)}`, `; before this, ${ago(lastPrev)}`) : ''}${c?.st ? L('。查过之后 24 小时内的复习最多记为“认识”。', '. A review within 24 h of a lookup counts as “knew it” at most.') : ''}</div>
      <div class="muted small">${c?.st ? L(`稳定度约 <span class="num">${c.s.toFixed(1)}</span> 天 · 难度 <span class="num">${c.d.toFixed(1)}</span>/10 · 复习 <span class="num">${c.reps}</span> 次 · 遗忘 <span class="num">${c.lapses || 0}</span> 次 · ${nextText(c).replace('再见', '复习')}`, `Stability ~<span class="num">${c.s.toFixed(1)}</span> days · difficulty <span class="num">${c.d.toFixed(1)}</span>/10 · <span class="num">${c.reps}</span> reviews · forgotten <span class="num">${c.lapses || 0}</span>× · ${nextText(c).replace('back', 'review')}`) : c?.intro ? L('已见过，还没通过第一次检测', 'Seen, but hasn’t passed its first check') : L('还没学', 'Not learned yet')}</div>
      ${hist.length ? `<div class="list">${hist.slice(0, 12).map((it) => `<div class="item"><div><div class="t">${kName[it.k] || it.k}</div><div class="s">${new Date(it.t).toLocaleString(window.LANG === 'en' ? 'en-US' : 'zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · ${(it.ms / 1000).toFixed(1)} ${L('秒', 's')}${it.c ? L(' · 误选 ', ' · picked ') + esc(it.c) : ''}</div></div><span class="${it.ok ? 'verdict ok' : 'verdict bad'} small">${it.k === 'learn' ? '' : it.ok ? (it.p ? L('部分', 'Partly') : L('对', 'Right')) : L('错', 'Wrong')}</span></div>`).join('')}</div>` : ''}
    </div>`, (ov) => {
    bindEntryLinks(ov);
    ov.querySelectorAll('[data-conf]').forEach((b) => b.addEventListener('click', () => openWord(b.dataset.conf)));
    $('#askc', ov)?.addEventListener('click', () => openChatForWord(id));
    $('#today', ov).addEventListener('click', () => addToToday(id));
    $('#fillzh', ov)?.addEventListener('click', async (e) => {
      const b = e.currentTarget; if (b.disabled) return;
      b.disabled = true; b.innerHTML = '<span class="spin"></span> ' + L('AI 助教 在写', 'AI tutor is writing');
      try { await fillZh(id); toast(L('中文释义补好了', 'Chinese gloss added')); openWord(id); }
      catch (err) { b.disabled = false; b.textContent = L('再试一次', 'Try again'); $('#zhbox', ov).insertAdjacentHTML('beforeend', `<div class="muted small">${esc(aiErr(err))}${err?.text ? L('：', ': ') + esc(err.text.slice(0, 120)) : ''}</div>`); }
    });
    $('#zhanw', ov)?.addEventListener('click', () => {
      S.L.cards[id] = zhanCard(id); markDirty(id); dropLater(id); saveLocal(); schedulePush();
      toast(L(`已斩 ${w.w}，${SCREEN_DAYS} 天后抽查；反悔可以在词卡上点“其实不熟，学一下”`, `Marked ${w.w} known; spot-check in ${SCREEN_DAYS} days. Changed your mind? Tap “Not sure after all” on the card`), 4000);
      openWord(id);
    });
    $('#relearnw', ov)?.addEventListener('click', (e) => {
      relearn(id);
      e.currentTarget.parentElement.innerHTML = S.session ? L('已改为重新学：几题后考它的用法。', 'Back to learning: it’ll be tested in a few questions.') : L('已改为重新学：下次学习时会先考它的用法，答题情况决定之后的复习。', 'Back to learning: your next session tests it first, and your answers set the reviews.');
    });
    $('#nudge', ov)?.addEventListener('click', (e) => { addToToday(id); e.currentTarget.closest('.feedback').innerHTML = L('已加入，今天会考到它。', 'Added; it’ll come up today.'); });
    const paintNotes = () => {
      const ns = notesOf(id);
      $('#notelist', ov).innerHTML = ns.length ? ns.map((n) => `<div class="note-row"><span>${esc(typeof plainMd === 'function' ? plainMd(n.t) : n.t)}<span class="muted small">${n.sk ? ' · ' + esc(senseLabel(w, n.sk)) : ''}${n.src === 'ai' ? L(' · 来自 AI 助教', ' · from AI tutor') : ''}</span></span><button class="link small" data-rmnote="${n.at}">${L('删除', 'Delete')}</button></div>`).join('') : `<div class="muted small">${L('还没有笔记。也可以在和 AI 助教 的对话里把回答钉过来。', 'No notes yet. You can also pin answers here from a chat with the AI tutor.')}</div>`;
      ov.querySelectorAll('[data-rmnote]').forEach((b) => b.addEventListener('click', () => { removeNote(id, +b.dataset.rmnote); paintNotes(); hydrateMw(id); }));
    };
    paintNotes();
    $('#notef', ov).addEventListener('submit', (e) => { e.preventDefault(); if (addNote(id, $('#notein', ov).value)) { $('#notein', ov).value = ''; paintNotes(); hydrateMw(id); } });
    if (S.mwIdx[id] && !S.mw.has(id)) withMw(id);
    $('#mwlook', ov)?.addEventListener('click', async (e) => {
      const b = e.currentTarget; b.disabled = true; b.innerHTML = '<span class="spin"></span> ' + L('查询中', 'Looking up');
      const d = await ensureMw(id, { manual: true });
      if (d) { hydrateMw(id); b.remove(); } else { b.disabled = false; b.textContent = L('查 Merriam-Webster', 'Look up in Merriam-Webster'); if (!mwState().ok) toast(mwState().msg); }
    });
  });
}

// Look up any word in Merriam-Webster, including words the books don't cover. Read-only unless
// the viewer chooses to add it; adding reuses this lookup instead of querying MW again.
S.lookups = new Map();
async function openLookup(word) {
  word = word.trim();
  const hit = findInBank(word.toLowerCase());
  if (hit) { openWord(hit.id); const n = findNote(word.toLowerCase(), hit); if (n) toast(n); return; }
  openSheet(`
    <div class="sheet-head"><h2 style="font-size:22px">${esc(word)}</h2><button class="x" data-close aria-label="${L('关闭', 'Close')}">×</button></div>
    <div id="lkout" class="muted small"><span class="spin"></span> ${L('正在查 Merriam-Webster', 'Looking up in Merriam-Webster')}</div>`, async (ov, close) => {
    const out = $('#lkout', ov);
    let payload = S.lookups.get(word.toLowerCase());
    if (!payload) {
      try {
        payload = (await S.mcp.callTool(MW_SERVER, 'lookup_word', { word, thesaurus: true }, { cache: false }))?.payload;
        mwCountToday().n++; saveLocal();
        if (payload) S.lookups.set(word.toLowerCase(), payload);
      } catch (e) {
        if (MW_DENIED.has(e?.code)) S.mwOff = e.code;
        out.textContent = MW_COPY[e?.code] || L('MW 查询失败：', 'MW lookup failed: ') + (e?.message || e?.code || L('未知错误', 'unknown error'));
        return;
      }
    }
    if (!payload || payload.status !== 'entry') {
      const sug = payload?.suggestions || payload?.related || [];
      out.innerHTML = `${L(`Merriam-Webster 没有收录 “${esc(word)}”。`, `Merriam-Webster has no entry for “${esc(word)}”.`)}${sug.length ? `<div class="row" style="margin-top:8px;gap:6px">${sug.slice(0, 10).map((x) => `<button class="btn sm" data-look="${esc(x)}">${esc(x)}</button>`).join('')}</div>` : ''}`;
      out.querySelectorAll('[data-look]').forEach((b) => b.addEventListener('click', () => { close(); openLookup(b.dataset.look); }));
      return;
    }
    const ai = S.sample && !S.aiOff;
    const baseId = mwBaseId(word.toLowerCase(), payload);
    if (baseId) { close(); openWord(baseId); toast(L(`据 Merriam-Webster，${word} 是 ${S.byId.get(baseId).w} 的派生词`, `Per Merriam-Webster, ${word} is derived from ${S.byId.get(baseId).w}`), 3500); return; }
    out.classList.remove('muted', 'small');
    out.innerHTML = `<div class="card reveal">${mwDocHtml(payload, word, { open: true })}</div>
      <div class="row" style="margin-top:12px">${ai || MW_PERSIST && MW_TO_AI ? `<button class="btn primary" id="lkadd">${ai ? L('加入词库', 'Add to my words') : L('用 MW 释义加入词库', 'Add with the MW definition')}</button>` : ''}</div>
      <div class="muted small" style="margin-top:6px">${L('只看释义不调用模型。', 'Viewing definitions uses no AI. ')}${ai ? (MW_TO_AI ? L('加入词库时 AI 助教 会依据上面的 MW 释义写中文释义和例句', 'When you add it, the AI tutor writes a Chinese gloss and examples based on the MW definition above') : L('加入词库时 AI 助教 会写释义和例句，不会用到上面的 Merriam-Webster 内容', 'When you add it, the AI tutor writes the definitions and examples; the Merriam-Webster text above is not used')) : MW_PERSIST && MW_TO_AI ? L('AI 助教 现在不可用，先用 MW 英文释义入库，中文之后在词卡上补', 'The AI tutor is unavailable, so it’s added with the MW definition; the Chinese gloss can be filled in later from its card') : L('加词需要 AI 助教写词条（在设置里填 AI key）；Merriam-Webster 的释义只供查看，不会存进词表', 'Adding words needs the AI tutor to write the entry (add an AI key in Settings); Merriam-Webster definitions are for viewing only and are not saved to your list')}${ai || MW_PERSIST && MW_TO_AI ? L('，之后排在新词队列最前，像其他新词一样学习和复习。', '. It then goes to the front of the new-word queue and is learned and reviewed like any other.') : L('。', '.')}</div>`;
    $('#lkadd', ov)?.addEventListener('click', async (e) => {
      const b = e.currentTarget; if (b.disabled) return;
      b.disabled = true; b.innerHTML = '<span class="spin"></span> ' + L('AI 助教 在写词条', 'AI tutor is writing the entry');
      const r = await addWords([{ word, mw: payload }]);
      if (r.added[0]) { close(); render(); openWord(r.added[0].id); toast(r.pending ? L(`已加入 ${r.added[0].w}：先用 MW 英文释义，中文待补`, `Added ${r.added[0].w} with the MW definition; Chinese gloss to come`) : L(`已加入 ${r.added[0].w}，排在新词队列最前`, `Added ${r.added[0].w} to the front of the new-word queue`), 3500); }
      else { b.disabled = false; b.textContent = L('再试一次', 'Try again'); out.insertAdjacentHTML('beforeend', addResultHtml(r)); }
    });
  });
}

// Adding a word the books don't cover: MW lookup (when available) -> AI 助教 writes the entry from it
// -> saved as a custom word at the front of the new-word queue. Shared by the add-word sheet and the chat.
async function mwLookupRaw(word) {
  const cached = S.lookups?.get(word.toLowerCase());
  if (cached) return cached;
  if (!mwState().ok) return null;
  try {
    const p = (await S.mcp.callTool(MW_SERVER, 'lookup_word', { word, thesaurus: true }, { cache: false }))?.payload || null;
    mwCountToday().n++; saveLocal();
    if (p) S.lookups?.set(word.toLowerCase(), p);
    return p;
  } catch (err) { if (MW_DENIED.has(err?.code)) S.mwOff = err.code; return null; }
}
function newCustomId(w) {
  let id = 'u-' + w.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (S.byId.has(id)) id += '-' + rid();
  return id;
}
function entryFromDraft(r) {
  return { id: newCustomId(r.w), w: r.w, tags: ['custom'], senses: r.senses.filter((x) => x?.zh || x?.en).map((x) => ({ pos: x.pos || '', zh: x.zh || '', en: x.en || '', ex: (x.ex || []).filter((e) => e?.en) })), syn: r.syn || [], ant: r.ant || [], added: Date.now() };
}
// AI 助教 unavailable or unparseable: the word still goes in with Merriam-Webster's own senses and
// examples, marked 中文待补 until AI 助教 fills in the Chinese from its card.
function entryFromMw(word, mw) {
  // keeping MW's definitions and examples as a word-list entry would store MW content (and later hand it to
  // the AI in chat context), so under the default policy a word can only be added from an AI-written entry
  if (!MW_PERSIST || !MW_TO_AI) return null;
  if (mw?.status !== 'entry') return null;
  const head = mw.entries.find((e) => (e.hw || '').toLowerCase().replace(/[^a-z' -]/g, '') === word.toLowerCase()) || mw.entries[0];
  const ms = mwSenses(mw).filter((m) => !m.archaic && m.def && m.entry === head.id).slice(0, 3);
  if (!ms.length) return null;
  const pos = (m) => (m.fl === 'verb' ? (/intrans/.test(m.vd || '') ? 'v.i.' : 'v.t.') : FL_SHORT[m.fl] || '');
  return { id: newCustomId(word), w: (head.hw || word).replace(/\*/g, ''), tags: ['custom', 'zhpending'], senses: ms.map((m) => ({ pos: pos(m), zh: '', en: m.def, ex: (m.ex || []).slice(0, 1).map((en) => ({ en })) })), syn: [], ant: [], added: Date.now() };
}
// One word, for the chat's "add and link": AI 助教's entry, else Merriam-Webster's
async function draftCustomEntry(word, mwPayload) {
  let err = null;
  if (S.sample && !S.aiOff) {
    try { const d = (await aiAddWords([{ word, mw: mwPayload }]))[word.toLowerCase()]; if (d) return entryFromDraft(d); } catch (e) { err = e; }
  }
  const e = entryFromMw(word, mwPayload);
  if (e) return e;
  throw err || { code: 'invalid_json' };
}
async function saveCustomEntry(entry, mwPayload) {
  entry.u = Date.now();
  S.L.custom[entry.id] = entry;
  (S.L.dirtyU ||= {})[entry.id] = 1;
  indexWords(S.data);
  saveLocal(); schedulePush(true);
  pullForward(entry.id);
  if (mwPayload) {
    const doc = { ...slimMw(mwPayload), word: entry.w };
    doc.align = doc.status === 'entry' ? await alignDoc(entry, doc) : [];
    await saveMwDoc(entry.id, doc);
  }
  return entry;
}

// ---------- 划词查: select a word anywhere for a small card ----------
// Double-click or drag-select (long-press on a phone) shows a card next to the selection: the bank
// entry with its status, or Merriam-Webster's first sense for words outside the bank. Not while a
// question is waiting for an answer (as in the exam); once it's answered, anything on screen can be
// looked up. Selecting a bank word is a deliberate lookup and is recorded like opening its card.
function lookupBlocked() {
  if (S.game && !S.game.end) return true;
  const s = S.session;
  if (s?.q && (s.q.learn ? s.q.hidden : !s.answered)) return true;
  const P = S.practice, it = P?.items?.[P.idx];
  return !!(P && it && !it.submitted);
}
function closeLookupPop() { $('#lkpop')?.remove(); }
// a word MW lists as a run-on (scrupulously under scrupulous) belongs to that entry's headword
function mwBaseId(word, mw) {
  for (const e of mw?.entries || []) {
    const hw = (e.hw || '').replace(/\*/g, '').toLowerCase();
    if (hw && hw !== word && (e.uros || []).some((u) => u.w.toLowerCase() === word)) { const hit = findInBank(hw); if (hit) return hit.id; }
  }
  return null;
}
let lkTimer = null, lkLast = '';
function onSelectionSettled() {
  const sel = window.getSelection();
  const text = sel && !sel.isCollapsed ? sel.toString().replace(/\s+/g, ' ').trim() : '';
  if (!text) { lkLast = ''; return; }
  const node = sel.anchorNode?.nodeType === 1 ? sel.anchorNode : sel.anchorNode?.parentElement;
  if (!node || node.closest('input, textarea, [contenteditable], #lkpop, #tabs')) return;
  if (!/^[A-Za-z][A-Za-z'’\- ]{0,40}$/.test(text) || text.split(' ').length > 4) return;
  const word = text.replace(/’/g, "'").toLowerCase();
  if (word === lkLast && $('#lkpop')) return;
  lkLast = word;
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  showLookupPop(word, rect);
}
function showLookupPop(word, rect) {
  closeLookupPop();
  const pop = document.createElement('div');
  pop.id = 'lkpop'; pop.className = 'lkpop';
  pop.setAttribute('role', 'dialog');
  document.body.append(pop);
  const place = () => {
    const w = Math.min(320, window.innerWidth - 24);
    pop.style.width = w + 'px';
    const left = Math.max(12, Math.min(window.innerWidth - w - 12, rect.left + rect.width / 2 - w / 2));
    const below = rect.bottom + 8 + pop.offsetHeight < window.innerHeight - 70;
    pop.style.left = left + window.scrollX + 'px';
    pop.style.top = (below ? rect.bottom + 8 : rect.top - 8 - pop.offsetHeight) + window.scrollY + 'px';
  };
  if (lookupBlocked()) {
    pop.innerHTML = `<div class="muted small">${L('交卷后可以查词（和真考一样，答题时不查）', 'You can look words up after answering (no lookups mid-question, just like the real test)')}</div>`;
    place(); setTimeout(closeLookupPop, 1800);
    return;
  }
  const hit = findInBank(word);
  if (hit) return bankPop(pop, word, hit, findNote(word, hit), place);
  pop.innerHTML = `<div class="lkhead"><b>${esc(word)}</b><span class="muted small">${L('不在词库', 'Not in your words')}</span></div><div class="muted small" id="lkbody"><span class="spin"></span> ${L('查 Merriam-Webster', 'Looking up in Merriam-Webster')}</div>`;
  place();
  if (!mwState().ok) { $('#lkbody').textContent = mwState().msg || L('MW 现在不可用', 'MW is unavailable right now'); place(); return; }
  mwLookupRaw(word).then((mw) => {
    if (!pop.isConnected) return;
    const base = mwBaseId(word, mw);
    if (base) return bankPop(pop, word, { id: base, how: 'derived' }, L(`据 Merriam-Webster，${word} 是 ${S.byId.get(base).w} 的派生词`, `Per Merriam-Webster, ${word} is derived from ${S.byId.get(base).w}`), place);
    showMwPop(pop, word, mw, place, rect);
  });
}
function bankPop(pop, word, hit, note, place) {
  const w = S.byId.get(hit.id), c = S.L.cards[hit.id];
  recordLookup(hit.id);
  pop.innerHTML = `<div class="lkhead"><b>${esc(w.w)}</b>${cardChip(c)}</div>
    ${note ? `<div class="muted small">${esc(note)}</div>` : ''}
    <div class="small">${esc(zhGloss(senseFor(w)) || w.senses[0]?.en || '')}</div>
    ${c?.st ? `<div class="muted small">${esc(L(nextText(c).replace('再见', '复习'), nextText(c).replace('back', 'review')))}</div>` : ''}
    <div class="row" style="gap:6px"><button class="btn sm" data-lk="card">${L('词卡', 'Card')}</button>${c?.st ? '' : `<button class="btn sm" data-lk="today">${L('加入今日复习', 'Add to today')}</button>`}</div>`;
  place();
  pop.querySelector('[data-lk="card"]').addEventListener('click', () => { closeLookupPop(); openWord(hit.id); });
  pop.querySelector('[data-lk="today"]')?.addEventListener('click', (e) => { addToToday(hit.id); e.currentTarget.disabled = true; e.currentTarget.textContent = L('已加入', 'Added'); });
}
function showMwPop(pop, word, mw, place, rect) {
  const body = $('#lkbody');
  if (mw?.status !== 'entry') { body.innerHTML = `${L('MW 没有收录', 'Not in MW')}${(mw?.suggestions || []).length ? L('，是不是：', '. Did you mean: ') + mw.suggestions.slice(0, 4).map((x) => `<button class="link" data-lkw="${esc(x)}">${esc(x)}</button>`).join(' ') : ''}`; body.querySelectorAll('[data-lkw]').forEach((b) => b.addEventListener('click', () => showLookupPop(b.dataset.lkw, rect))); place(); return; }
  const m = mwSenses(mw).find((x) => !x.archaic && x.def);
  body.classList.remove('muted');
  body.innerHTML = `<div class="small">${esc(m ? `${FL_SHORT[m.fl] || m.fl || ''} ${m.def}` : '')}</div>${mwCredit(word)}
    <div class="row" style="gap:6px;margin-top:6px"><button class="btn sm" data-lk="mw">${L('看 MW 全部释义', 'All MW senses')}</button><button class="btn sm" data-lk="add">${L('加入词库', 'Add to my words')}</button></div>`;
  place();
  body.querySelector('[data-lk="mw"]').addEventListener('click', () => { closeLookupPop(); openLookup(word); });
  body.querySelector('[data-lk="add"]').addEventListener('click', async (e) => {
    const b = e.currentTarget; if (b.disabled) return;
    b.disabled = true; b.innerHTML = '<span class="spin"></span> ' + L('加入中', 'Adding');
    const r = await addWords([{ word, mw }]);
    if (r.added[0]) { b.textContent = r.pending ? L('已加入（中文待补）', 'Added (Chinese gloss to come)') : L('已加入，排在最前', 'Added to the front'); render(); }
    else { b.disabled = false; b.textContent = L('没加上，再试', 'Didn’t work; try again'); }
  });
}
document.addEventListener('selectionchange', () => { clearTimeout(lkTimer); lkTimer = setTimeout(onSelectionSettled, 450); });
document.addEventListener('mouseup', () => { clearTimeout(lkTimer); lkTimer = setTimeout(onSelectionSettled, 60); });
document.addEventListener('pointerdown', (e) => { if (!e.target.closest?.('#lkpop')) closeLookupPop(); }, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeLookupPop(); });

// ---------- 查词: one flow to find or add words ----------
// Word bank first (spelling, inflected forms, derived words), then Merriam-Webster (no AI 助教 cost);
// AI 助教 is called only to add words, once for all of them. Large one-off imports go through AI 助教
// Code instead.
const PHRASE_PARTS = /\b(to|of|off|up|on|in|out|with|away|down|by|for|at|over|into|oneself|one's|something|someone)\b/i;
function parseFindInput(text) {
  const t = String(text || '').replace(/[“”"]/g, ' ').trim();
  if (!t) return [];
  let parts;
  if (/[,\n;，、；]/.test(t)) parts = t.split(/[,\n;，、；]+/);
  else {
    const ws = t.split(/\s+/);
    parts = ws.length > 1 && ws.length <= 4 && (PHRASE_PARTS.test(t) || bankByName().has(t.toLowerCase())) ? [t] : ws;
  }
  const clean = parts.map((p) => p.trim().replace(/^[^A-Za-z]+|[^A-Za-z.]+$/g, '').replace(/\s+/g, ' ').toLowerCase()).filter((p) => /^[a-z][a-z '\-.]{0,40}$/.test(p));
  return [...new Set(clean)].slice(0, 20);
}
function lemmaCandidates(x) {
  const out = [x];
  const add = (v) => { if (v && v.length > 2 && !out.includes(v)) out.push(v); };
  if (/ies$/.test(x)) add(x.slice(0, -3) + 'y');
  if (/ied$/.test(x)) add(x.slice(0, -3) + 'y');
  if (/([^aeiou])\1(ed|ing)$/.test(x)) add(x.replace(/([^aeiou])\1(ed|ing)$/, '$1'));
  if (/ying$/.test(x)) add(x.slice(0, -4) + 'ie');
  if (/ing$/.test(x)) { add(x.slice(0, -3) + 'e'); add(x.slice(0, -3)); }
  if (/ed$/.test(x)) { add(x.slice(0, -1)); add(x.slice(0, -2)); }
  if (/es$/.test(x)) add(x.slice(0, -2));
  if (/s$/.test(x) && !/ss$/.test(x)) add(x.slice(0, -1));
  return out;
}
// Last resort when neither the book nor forms.json knows the word (custom words, rare forms):
// suffix rules, only accepted when the result is a bank word, and labelled as a guess
const DERIV = [
  [/iness$/, ['y']], [/ness$/, ['']], [/ily$/, ['y']], [/ly$/, ['', 'le']], [/osity$/, ['ous']], [/ility$/, ['le', 'il']], [/ity$/, ['', 'e']],
  [/ments?$/, ['']], [/ful$/, ['']], [/less$/, ['']], [/ization$/, ['ize']], [/izations$/, ['ize']], [/ise$/, ['ize']], [/izes?$|ized$|izing$/, ['ize']],
  [/isms?$/, ['', 'ic', 'ist']], [/ists?$/, ['', 'ism', 'ic']], [/ally$/, ['al', 'ic']], [/ical$/, ['ic']],
];
function derivCandidates(x) {
  const out = [];
  for (const [re, ends] of DERIV) if (re.test(x)) for (const e of ends) { const b = x.replace(re, e); if (b.length > 3 && b !== x) out.push(b); }
  return out;
}
function derivedIndex() {
  if (!S._derived) { S._derived = new Map(); for (const w of S.words) for (const d of w.derived || []) if (d.w) S._derived.set(d.w.toLowerCase(), w.id); }
  return S._derived;
}
function findInBank(x) {
  const names = bankByName(), der = derivedIndex();
  if (names.has(x)) return { id: names.get(x), how: '' };
  if (der.has(x)) return { id: der.get(x), how: 'derived' };
  // forms.json (scripts/build_forms.py): LemmInflect inflections and WordNet derivations of every word
  const t = S.forms?.[x];
  if (t && S.byId.has(t[0])) return { id: t[0], how: t[1] ? 'derived' : 'form' };
  for (const c of lemmaCandidates(x)) { const id = names.get(c); if (id) return { id, how: c === x ? '' : 'form' }; }
  for (const c of lemmaCandidates(x)) { const id = der.get(c); if (id) return { id, how: 'derived' }; }
  for (const c of lemmaCandidates(x).flatMap(derivCandidates)) {
    const id = names.get(c) || der.get(c);
    if (id) return { id, how: 'rule' };
  }
  return null;
}
const findNote = (x, hit) => (hit.how === 'form' ? L(`${x} 是 ${S.byId.get(hit.id).w} 的变形`, `${x} is a form of ${S.byId.get(hit.id).w}`) : hit.how === 'derived' ? L(`${x} 是 ${S.byId.get(hit.id).w} 的派生词`, `${x} is derived from ${S.byId.get(hit.id).w}`) : hit.how === 'rule' ? L(`${x} 可能是 ${S.byId.get(hit.id).w} 的派生词`, `${x} may be derived from ${S.byId.get(hit.id).w}`) : '');
function openFind(text) {
  const words = parseFindInput(text);
  if (!words.length) { toast(L('输入英文单词或短语，多个词用空格、逗号或换行分开', 'Enter English words or phrases, separated by spaces, commas or new lines')); return; }
  if (words.length === 1) {
    const hit = findInBank(words[0]);
    if (hit) { openWord(hit.id); const n = findNote(words[0], hit); if (n) toast(n); return; }
    openLookup(words[0]);
    return;
  }
  openFindList(words);
}
// Adding: AI 助教 writes all entries in one call (8 at a time); any word it misses goes in with MW's
// own senses as 中文待补. Saved custom words lead the new-word queue.
async function addWords(items) {
  const drafts = {};
  let err = null;
  if (S.sample && !S.aiOff) {
    for (let i = 0; i < items.length; i += 8) {
      try { Object.assign(drafts, await aiAddWords(items.slice(i, i + 8))); } catch (e) { err = e; }
    }
  }
  const added = [], failed = [];
  for (const it of items) {
    const d = drafts[it.word.toLowerCase()];
    const entry = d ? entryFromDraft(d) : entryFromMw(it.word, it.mw);
    if (!entry) { failed.push(it.word); continue; }
    await saveCustomEntry(entry, it.mw);
    added.push(entry);
  }
  return { added, failed, err, pending: added.filter((e) => e.tags.includes('zhpending')).length };
}
function addResultHtml(r) {
  const bits = [];
  if (r.added.length) bits.push(L(`已加入 ${r.added.length} 个，排在新词队列最前`, `Added ${r.added.length} to the front of the new-word queue`));
  if (r.pending) bits.push(L(`${r.pending} 个先用 MW 英文释义加入，中文待补（打开词卡可让 AI 助教 补）`, `${r.pending} added with the MW definition only, Chinese gloss to come (the AI tutor can fill it in from the card)`));
  if (r.failed.length) bits.push(MW_PERSIST && MW_TO_AI ? L(`没加上：${r.failed.join('、')}（MW 也没有收录）`, `Not added: ${r.failed.join(', ')} (not in MW either)`) : L(`没加上：${r.failed.join('、')}（加词需要 AI 助教写词条；Merriam-Webster 的释义不会存进词表）`, `Not added: ${r.failed.join(', ')} (adding words needs the AI tutor to write the entry; Merriam-Webster definitions are not saved to your list)`));
  const raw = r.err?.text ? `<details class="muted small"><summary>${L('AI 助教 的回复没能解析，开头是', 'Couldn’t parse the AI tutor’s reply; it began with')}</summary><pre style="white-space:pre-wrap">${esc(r.err.text.slice(0, 300))}</pre></details>` : r.err ? `<div class="muted small">${esc(aiErr(r.err))}</div>` : '';
  return `<div class="feedback small">${bits.join(L('；', '; '))}</div>${raw}`;
}
function openFindList(words) {
  openSheet(`
    <div class="sheet-head"><h2>${L(`查词 · ${words.length} 个`, `Look up · ${words.length} words`)}</h2><button class="x" data-close aria-label="${L('关闭', 'Close')}">×</button></div>
    <div id="findlist" class="list"></div>
    <div id="findact"></div>
    <div id="findres"></div>`, async (ov) => {
    const rows = words.map((x) => ({ x, hit: findInBank(x), mw: null, state: 'wait' }));
    const ai = S.sample && !S.aiOff;
    const paint = () => {
      const list = $('#findlist', ov); if (!list) return;
      list.innerHTML = rows.map((r, i) => {
        if (r.hit) { const w = S.byId.get(r.hit.id); return `<button class="item" data-open="${esc(w.id)}"><div><div class="t">${esc(w.w)}${r.hit.how ? ` <span class="muted small">← ${esc(r.x)}</span>` : ''}</div><div class="s">${esc(zhGloss(senseFor(w)) || w.senses[0]?.en || '')}</div></div>${cardChip(S.L.cards[w.id])}</button>`; }
        const def = r.mw?.status === 'entry' ? mwSenses(r.mw).find((m) => !m.archaic && m.def)?.def : '';
        const sug = r.mw && r.mw.status !== 'entry' ? (r.mw.suggestions || []).slice(0, 4) : [];
        return `<label class="item findrow"><input type="checkbox" data-pick="${i}" ${r.pick ? 'checked' : ''} ${def ? '' : 'disabled'}><div style="flex:1;min-width:0"><div class="t">${esc(r.x)} <span class="muted small">${L('不在词库', 'Not in your words')}</span></div><div class="s">${r.state === 'wait' ? '<span class="spin"></span> ' + L('查 MW', 'Looking up in MW') : def ? L('MW：', 'MW: ') + esc(def) : `${L('MW 没有收录', 'Not in MW')}${sug.length ? L('，是不是：', '. Did you mean: ') + sug.map((x) => `<button class="link" data-retry="${i}" data-w="${esc(x)}">${esc(x)}</button>`).join(' ') : ''}`}</div></div></label>`;
      }).join('');
      list.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => openWord(b.dataset.open)));
      list.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('change', () => { rows[+b.dataset.pick].pick = b.checked; paintAct(); }));
      list.querySelectorAll('[data-retry]').forEach((b) => b.addEventListener('click', async (e) => { e.preventDefault(); const r = rows[+b.dataset.retry]; r.x = b.dataset.w; r.hit = findInBank(r.x); r.state = 'wait'; paint(); if (!r.hit) { r.mw = await mwLookupRaw(r.x); r.pick = r.mw?.status === 'entry'; } r.state = 'done'; paint(); paintAct(); }));
    };
    const paintAct = () => {
      const n = rows.filter((r) => !r.hit && r.pick).length;
      const box = $('#findact', ov); if (!box) return;
      box.innerHTML = n ? (ai || MW_PERSIST && MW_TO_AI ? `<button class="btn primary" id="findadd">${ai ? L(`加入词库（${n} 个）`, `Add to my words (${n})`) : L(`用 MW 释义加入（${n} 个，中文待补）`, `Add with MW definitions (${n}, Chinese gloss to come)`)}</button><div class="muted small" style="margin-top:6px">${ai ? (MW_TO_AI ? L('AI 助教 依据 MW 释义一次写完这些词的中文释义和例句（用你自己的 AI key）。', 'The AI tutor writes Chinese glosses and examples for all of them in one go, based on MW (using your own AI key).') : L('AI 助教 一次写完这些词的释义和例句（用你自己的 AI key），不会用到 Merriam-Webster 的内容。', 'The AI tutor writes definitions and examples for all of them in one go (using your own AI key); Merriam-Webster text is not used.')) : L('AI 助教 现在不可用，先用 MW 的英文释义入库，之后可在词卡上补中文。', 'The AI tutor is unavailable, so they’re added with MW’s English definitions; the Chinese can be filled in later from each card.')}</div>` : `<div class="muted small">${L('加词需要 AI 助教写词条（在设置里填 AI key）；Merriam-Webster 的释义只供查看，不会存进词表。', 'Adding words needs the AI tutor to write the entries (add an AI key in Settings); Merriam-Webster definitions are for viewing only and are not saved to your list.')}</div>`) : '';
      $('#findadd', ov)?.addEventListener('click', async (e) => {
        const b = e.currentTarget; if (b.disabled) return;
        b.disabled = true; b.innerHTML = `<span class="spin"></span> ${ai ? L('AI 助教 在写词条', 'AI tutor is writing the entries') : L('保存中', 'Saving')}`;
        const picked = rows.filter((r) => !r.hit && r.pick);
        const res = await addWords(picked.map((r) => ({ word: r.x, mw: r.mw })));
        for (const r of picked) { const e2 = res.added.find((x) => x.w.toLowerCase() === r.x); r.hit = e2 ? { id: e2.id, how: '' } : findInBank(r.x); r.pick = false; }
        $('#findres', ov).innerHTML = addResultHtml(res);
        paint(); paintAct(); render();
      });
    };
    paint();
    // Merriam-Webster for the words not in the bank, two at a time
    const todo = rows.filter((r) => !r.hit);
    const worker = async () => { for (let r; (r = todo.shift());) { r.mw = await mwLookupRaw(r.x); r.pick = r.mw?.status === 'entry'; r.state = 'done'; paint(); paintAct(); } };
    if (!mwState().ok) rows.forEach((r) => { if (!r.hit) r.state = 'done'; });
    else await Promise.all([worker(), worker()]);
    paint(); paintAct();
  });
}
// Fill in the Chinese for a word that went in with MW's senses only
async function fillZh(id) {
  const w = S.byId.get(id);
  const mw = MW_TO_AI ? S.lookups?.get(w.w.toLowerCase()) || await mwLookupRaw(w.w) : null;
  const d = (await aiAddWords([{ word: w.w, mw }]))[w.w.toLowerCase()];
  if (!d) throw { code: 'invalid_json' };
  const e = { ...entryFromDraft(d), id, added: w.added || Date.now(), u: Date.now() };
  S.L.custom[id] = e;
  (S.L.dirtyU ||= {})[id] = 1;
  indexWords(S.data); saveLocal(); schedulePush(true);
  return e;
}

function drillLine() {
  const rs = Object.values(S.L.drill || {});
  if (!rs.length) return L(`你导入的题集，${S.drills?.items?.length ? S.drills.items.length + ' 题，' : ''}按 Section 整套做，带答案和解析`, `Your imported question set${S.drills?.items?.length ? ', ' + S.drills.items.length + ' questions' : ''}, done section by section, with answers and explanations`);
  const ok = rs.filter((r) => (r.f ?? r.ok)).length;
  return L(`做过 ${rs.length} 题 · 首次全对 ${Math.round(ok / rs.length * 100)}% · 看各套进度`, `${rs.length} done · ${Math.round(ok / rs.length * 100)}% right first time · see progress by set`);
}
const PR_SRC = [
  ['rand', L('AI 助教 出新题', 'New items from the AI tutor'), L('答案词取自你的词表（导入了题集时也取自题集），按考试填空题的风格和难度出新题；学过的词出现时照常评分，没学过的词答错会排进今天的新词。用你自己的 AI key。', 'Answer words come from your word list (and your imported question set, if any), in the style and difficulty of real exam items. Learned words are graded as usual; missed unlearned words join today’s new words. Uses your own AI key.')],
  ['learned', L('AI 助教 出新题 · 偏向学过的词', 'New items from the AI tutor · learned words'), L('每题至少一个答案是你学过的词，顺便检验它在语境里会不会用。适合背完一遍以后。', 'At least one answer per item is a word you’ve learned, testing whether you can use it in context. Best after a first pass through the list.')],
];
function openPracticeSetup() {
  const learned = Object.values(S.L.cards).filter((c) => c.st).length;
  const saved = { f: ['tc1', 'tc2', 'tc3', 'se'], n: 6, ...(S.L.prefs.prSetup || {}) };
  let src = saved.src === 'learned' ? 'learned' : 'rand';
  const ai = S.sample && !S.aiOff;
  openSheet(`
    <div class="sheet-head"><h2>${L('填空实战', 'Text Completion practice')}</h2><button class="x" data-close aria-label="${L('关闭', 'Close')}">×</button></div>
    <div id="prsetup" class="sec"><div class="muted small"><span class="spin"></span> ${L('加载中', 'Loading')}</div></div>`, async (ov, close) => {
    try { await loadDrills(); } catch (e) { /* the exercise set is unavailable; AI 助教 items still work with learned words */ }
    const save = (patch) => { S.L.prefs = { ...S.L.prefs, prSetup: { ...saved, ...patch }, u: Date.now() }; S.L.dirtyP = true; saveLocal(); };
    const paint = () => {
      const box = $('#prsetup', ov); if (!box) return;
      const srcRow = `<div class="sec" style="gap:6px">${PR_SRC.map(([k, n, d]) => `<label class="check" style="align-items:flex-start"><input type="radio" name="prsrc" value="${k}" ${src === k ? 'checked' : ''} ${!ai ? 'disabled' : ''}><span><b>${n}</b><br><span class="muted small">${d}</span></span></label>`).join('')}</div>`;
      const body = `${src === 'learned' && learned < 3 ? `<div class="feedback">${L('学过的词还太少（至少 3 个），先背一些再来。', 'You need at least 3 learned words. Learn a few first.')}</div>` : ''}
          <div class="sec" style="gap:6px"><h2 style="font-size:15px">${L('题型', 'Question types')}</h2>
            ${[['tc1', L('单空（五选一）', 'One blank (1 of 5)')], ['tc2', L('双空', 'Two blanks')], ['tc3', L('三空', 'Three blanks')], ['se', L('六选二', 'Sentence Equivalence')]].map(([k, n]) => `<label class="check"><input type="checkbox" data-f="${k}" ${saved.f.includes(k) ? 'checked' : ''}><span>${n}</span></label>`).join('')}
          </div>
          <div class="field"><label for="prn">${L('题数', 'Questions')}</label><select id="prn">${[3, 6, 9, 12].map((n) => `<option value="${n}" ${saved.n === n ? 'selected' : ''}>${L(`${n} 题`, `${n} questions`)}</option>`).join('')}</select></div>
          <button class="btn primary" id="prgo" ${(src === 'learned' && learned < 3) || !ai ? 'disabled' : ''}>${L('开始', 'Start')}</button>`;
      box.innerHTML = srcRow + body;
      box.querySelectorAll('[name="prsrc"]').forEach((r) => r.addEventListener('change', () => { src = r.value; save({ src }); paint(); }));
      $('#prgo', ov)?.addEventListener('click', () => {
        const f = [...ov.querySelectorAll('[data-f]')].filter((x) => x.checked).map((x) => x.dataset.f);
        if (!f.length) { toast(L('至少选一种题型', 'Pick at least one question type')); return; }
        const n = +$('#prn', ov).value;
        save({ f, n, src });
        close(); startPractice(shuffle([...f]), n, src);
      });
    };
    paint();
  });
}

function diagHtml(d) {
  if (!d) return '';
  return `<div class="feedback">${esc(d.summary || '')}</div>
    ${(d.patterns || []).map((p) => `<div class="sec" style="gap:4px"><b>${esc(p.title)}</b><div class="small">${esc(p.detail)}</div><div class="small">${(p.ids || []).map((id) => S.byId.get(id)).filter(Boolean).map((w) => `<button class="link" data-word="${esc(w.id)}">${esc(w.w)}</button>`).join(L('，', ', '))}</div></div>`).join('')}`;
}
function openDiagnose() {
  const d = S.L.diag;
  openSheet(`
    <div class="sheet-head"><h2>${L('错词诊断', 'Mistake diagnosis')}</h2><button class="x" data-close aria-label="${L('关闭', 'Close')}">×</button></div>
    <div id="diagout">${d ? diagHtml(d) : `<div class="muted small">${L('AI 助教 会读最近三周答错和反复遗忘的词，包括你当时误选的选项，找出规律并给出专练词单。', 'The AI tutor reads the words you missed or kept forgetting over the last three weeks, including the wrong options you picked, finds patterns and builds a focused word list.')}</div>`}</div>
    <div class="row"><button class="btn primary" id="rundiag">${d ? L('重新诊断', 'Run again') : L('开始诊断', 'Run diagnosis')}</button>${d?.focus?.length ? `<button class="btn grow" id="practice">${L(`练这 ${d.focus.length} 个词`, `Practise these ${d.focus.length} words`)}</button>` : ''}</div>`, (ov, close) => {
    bindEntryLinks(ov);
    $('#practice', ov)?.addEventListener('click', () => { S.focusIds = S.L.diag.focus; close(); startSession('focus'); });
    $('#rundiag', ov).addEventListener('click', async (e) => {
      const btn = e.currentTarget; btn.disabled = true; btn.innerHTML = '<span class="spin"></span> ' + L('分析中', 'Analysing');
      try {
        const r = await aiDiagnose();
        if (!r) { $('#diagout', ov).innerHTML = `<div class="muted small">${L('错题还太少，多做几天再来诊断。', 'Not enough mistakes yet. Practise a few more days, then come back.')}</div>`; btn.remove(); return; }
        S.L.diag = { ...r, focus: (r.focus || []).filter((id) => S.byId.has(id)).slice(0, 30), at: Date.now() };
        saveLocal();
        close(); openDiagnose();
      } catch (err) { toast(aiErr(err)); btn.disabled = false; btn.textContent = L('重新诊断', 'Run again'); }
    });
  });
}

// ---------- settings ----------
function renderSettings() {
  const p = S.L.prefs;
  const syncLine = S.db ? (S.sync.state === 'ok' ? L('已同步，最后一次 ', 'Synced, last at ') + new Date(S.sync.at).toLocaleTimeString(window.LANG === 'en' ? 'en-US' : 'zh-CN', { hour: '2-digit', minute: '2-digit' }) : S.sync.msg || L('同步中', 'Syncing')) : L('进度只保存在这台设备的浏览器里。想多设备同步，在下面连接你自己的 Supabase 项目。', 'Progress is saved in this browser only. To sync across devices, connect your own Supabase project below.');
  const RT = window.vocabRuntime || {};
  const cfg = RT.config || {};
  const deckN = S.data?.words?.length || 0;
  const imported = (() => { try { return !!localStorage.getItem(DECK_KEY); } catch (e) { return false; } })();
  app().innerHTML = `${topBar()}<div id="service-status" class="small muted"></div>
  <section class="sec">
    <h2>${L('学习计划', 'Study plan')}</h2>
    <div class="field"><label for="daily">${L('每日新词', 'New words per day')}</label><input id="daily" type="number" min="0" max="300" step="5" value="${p.dailyNew}" inputmode="numeric"><span class="hint">${L('1 到 3 个月备考，建议 40 到 60。复习量大约是新词的 3 到 5 倍。', 'For 1–3 months of prep, 40 to 60 is a good range. Reviews run about 3–5 times the new words.')}</span></div>
    <label class="check"><input id="autonew" type="checkbox" ${p.autoNew ? 'checked' : ''}><span>${L('复习多的时候自动减少新词', 'Fewer new words when reviews pile up')}<br><span class="muted small">${L('待复习超过每日新词的 4 倍时，每多 4 个复习少 1 个新词，最少 15 个。', 'When reviews exceed 4× the daily new words, every 4 extra reviews drop one new word, down to 15.')}</span></span></label>
    <div class="field"><label for="exam">${L('考试日期', 'Test date')}</label><input id="exam" type="date" value="${esc(p.examDate)}"></div>
    <div class="field"><label for="order">${L('新词顺序', 'New-word order')}</label><select id="order">
      <option value="book" ${p.order === 'book' ? 'selected' : ''}>${L('按词表顺序，穿插熟词僻义和形近词', 'List order, mixed with uncommon meanings and look-alikes')}</option>
      <option value="trap" ${p.order === 'trap' ? 'selected' : ''}>${L('熟词僻义优先', 'Uncommon meanings first')}</option>
      <option value="conf" ${p.order === 'conf' ? 'selected' : ''}>${L('形近词优先', 'Look-alikes first')}</option>
    </select></div>
    <label class="check"><input id="typing" type="checkbox" ${p.typing ? 'checked' : ''}><span>${L('熟词出“写中文意思”题', 'Ask well-known words as “write the meaning”')}<br><span class="muted small">${L('稳定度到 15 天以上的词会让你自己写意思，拿不准的由 AI 助教 判。快速模式里不出这类题。', 'Words with stability over 15 days ask you to write the meaning; the AI tutor judges unclear answers. Not used in quick mode.')}</span></span></label>
    <div class="field"><label for="screensec">${L('斩词时限（秒）', 'Screening time limit (s)')}</label><input id="screensec" type="number" min="2" max="15" step="0.5" value="${screenSecTxt()}" inputmode="decimal"><span class="hint">${L('筛查时在这个时间内选对就直接跳过这个词；超时但选对的按普通复习安排。2 到 15 秒。', 'When screening, a right answer within this time skips the word; a right answer after it is scheduled as a normal review. 2 to 15 s.')}</span></div>
    <label class="check"><input id="autonext" type="checkbox" ${p.autoNext ? 'checked' : ''}><span>${L('选择题答对后自动下一题', 'Auto-advance after a correct multiple-choice answer')}<br><span class="muted small">${L('关掉时每题都停在答案页，点“继续”或按 Enter 进入下一题。', 'When off, every question stays on the answer page; tap “Continue” or press Enter to move on.')}</span></span></label>
  </section>
  <section class="sec">
    <h2>界面语言 · Language</h2>
    <div class="field"><select id="lang"><option value="zh">中文</option><option value="en">English</option></select></div>
  </section>
  <section class="sec">
    <h2>${L('词表', 'Word list')}</h2>
    <div class="muted small">${L('现在用的是', 'Using ')}${imported ? L('你导入的词表', 'your imported list') : L('自带的示例词表', 'the bundled sample list')}${S.data?.name ? L(`「${esc(S.data.name)}」`, ` “${esc(S.data.name)}”`) : ''}${L(`，共 <span class="num">${deckN}</span> 个词。导入新词表会替换它，已学的进度按词保留（同一个词换了词表也接得上）。`, `, <span class="num">${deckN}</span> words. Importing a new list replaces it; progress is kept per word, so it carries over when the same word appears in a new list.`)}</div>
    <div class="row"><label class="btn sm" for="deckf" style="display:inline-flex;align-items:center">${L('导入词表（CSV 或 JSON）', 'Import word list (CSV or JSON)')}</label><input id="deckf" type="file" accept=".csv,.json,text/csv,application/json" hidden>${imported ? `<button class="btn sm" id="decksample">${L('换回示例词表', 'Back to the sample list')}</button>` : ''}</div>
    <div class="muted small">${L('CSV 每行一个义项：', 'CSV, one sense per row: ')}<code>word,pos,zh,en,example,example_zh,synonyms</code>${L('（近义词用分号隔开）。JSON 格式见仓库的 data/schema.md。', ' (synonyms separated by semicolons). For JSON, see data/schema.md in the repo.')}</div>
    <div class="row"><label class="btn sm" for="drillf" style="display:inline-flex;align-items:center">${L('导入题集（JSON）', 'Import question set (JSON)')}</label><input id="drillf" type="file" accept=".json,application/json" hidden>${hasDrills() ? `<button class="btn sm" id="drillrm">${L('移除题集', 'Remove question set')}</button>` : ''}</div>
  </section>
  <section class="sec">
    <h2>${L('AI 助教（可选，自带 key）', 'AI tutor (optional, bring your own key)')}</h2>
    <div class="muted small">${L('讲解、出新题、判写释义题需要一个 AI 接口。不填也能正常背词。key 只存在这台设备的浏览器里，请求从浏览器直接发给你填的服务商。', 'Explanations, new questions and grading written answers need an AI API. Everything else works without one. The key stays in this browser, and requests go straight from the browser to the provider you enter.')}</div>
    <div class="field"><label for="aibase">${L('接口地址（OpenAI 兼容）', 'API base URL (OpenAI-compatible)')}</label><input id="aibase" placeholder="https://api.openai.com/v1" value="${esc(cfg.ai?.base || '')}" autocomplete="off"></div>
    <div class="field"><label for="aimodel">${L('模型', 'Model')}</label><input id="aimodel" placeholder="gpt-4o-mini" value="${esc(cfg.ai?.model || '')}" autocomplete="off"></div>
    <div class="field"><label for="aikey">API key</label><input id="aikey" type="password" value="${esc(cfg.ai?.key || '')}" autocomplete="off"></div>
  </section>
  <section class="sec">
    <div class="mw-credit">${MW_LOGO('https://www.merriam-webster.com/')}<h2>${L('Merriam-Webster 词典（可选，自带 key）', 'Merriam-Webster dictionary (optional, bring your own key)')}</h2></div>
    <div class="muted small">${L('在 ', 'Register for free at ')}<a href="https://dictionaryapi.com/register/index" target="_blank" rel="noopener">dictionaryapi.com</a>${L(' 免费注册，申请 Merriam-Webster’s Collegiate® Dictionary 和 Collegiate Thesaurus 两个 key（免费额度仅限非商业用途）。只在你点“查 Merriam-Webster”或划词时查询，结果只在本次打开期间保留，不会存进词表，也不会发给 AI。本项目与 Merriam-Webster 无关联。', ' and request two keys, Merriam-Webster’s Collegiate® Dictionary and Collegiate Thesaurus (the free tier is for non-commercial use only). Lookups happen only when you tap “Look up in Merriam-Webster” or select a word; results are kept only for this session, never saved to your word list, and never sent to the AI. This project is not affiliated with Merriam-Webster.')}</div>
    <div class="field"><label for="mwdict">Merriam-Webster's Collegiate® Dictionary key</label><input id="mwdict" type="password" value="${esc(cfg.mw?.dict || '')}" autocomplete="off"></div>
    <div class="field"><label for="mwthes">${L("Merriam-Webster's Collegiate Thesaurus key（可选）", "Merriam-Webster's Collegiate Thesaurus key (optional)")}</label><input id="mwthes" type="password" value="${esc(cfg.mw?.thes || '')}" autocomplete="off"></div>
  </section>
  <section class="sec">
    <h2>${L('云同步（可选，Supabase）', 'Cloud sync (optional, Supabase)')}</h2>
    <div class="muted small">${RT.account ? L(`已登录 ${esc(RT.account.email || '')}，进度同步到你的 Supabase 项目。`, `Signed in as ${esc(RT.account.email || '')}; progress syncs to your Supabase project.`) : L('填入你自己 Supabase 项目的 URL 和 anon key（建表脚本在仓库 supabase/ 目录），再用邮箱登录，就能在多台设备间同步；你的 AI 也能通过 Supabase 只读地分析学习记录。', 'Enter your own Supabase project’s URL and anon key (table scripts are in the repo’s supabase/ folder), then sign in by email to sync across devices; your AI can also analyse your study records read-only through Supabase.')}</div>
    <div class="field"><label for="sburl">Project URL</label><input id="sburl" placeholder="https://xxxx.supabase.co" value="${esc(cfg.sb?.url || '')}" autocomplete="off"></div>
    <div class="field"><label for="sbanon">anon public key</label><input id="sbanon" type="password" value="${esc(cfg.sb?.anon || '')}" autocomplete="off"></div>
    ${RT.account ? `<div class="row"><button class="btn sm" id="sbout">${L('退出登录', 'Sign out')}</button></div>` : `<div class="field"><label for="sbemail">${L('邮箱（发登录链接）', 'Email (for a sign-in link)')}</label><input id="sbemail" type="email" autocomplete="email"></div><div class="row"><button class="btn sm" id="sbin" ${cfg.sb?.url && cfg.sb?.anon ? '' : 'disabled'}>${L('发送登录链接', 'Send sign-in link')}</button></div>`}
  </section>
  <div class="row"><button class="btn primary" id="savecfg">${L('保存以上设置', 'Save these settings')}</button></div>
  <section class="sec">
    <h2>${L('同步与备份', 'Sync and backup')}</h2>
    <div class="muted small">${esc(syncLine)}</div>
    <div class="row"><button class="btn sm" id="syncnow" ${S.db ? '' : 'disabled'}>${L('立即同步', 'Sync now')}</button><button class="btn sm" id="export">${L('导出进度', 'Export progress')}</button><button class="btn sm" id="exportai">${L('导出给 AI 分析', 'Export for AI analysis')}</button><label class="btn sm" for="importf" style="display:inline-flex;align-items:center">${L('导入进度', 'Import progress')}</label><input id="importf" type="file" accept="application/json,.json" hidden></div>
    <div class="muted small">${L('进度本来就自动同步：答题后几秒、切走或关掉页面时上传，重新打开或切回来时拉取另一台设备的改动。“立即同步”是马上上传再拉取一次，换设备前或右上角显示“待上传”时点一下。备份包含当前词表、题集和学习记录。恢复时词表与题集恢复到备份版本；进度、笔记和对话按较新记录合并。旧版备份仍可导入，但不含词表和题集。', 'Progress syncs automatically: it uploads a few seconds after you answer and when you leave or close the page, and pulls other devices’ changes when you reopen or come back. “Sync now” uploads and pulls right away; use it before switching devices or when the top corner shows “to upload”. Backups include the active word list, question set and study records. Restore replaces the word list and question set with the backed-up versions; progress, notes and chats merge by the newer record. Older backups still work but do not contain word lists or question sets.')}</div>
  </section>
  <section class="sec">
    <h2>${L('评分规则', 'How grading works')}</h2>
    <div class="small muted">${L('不用自己评“模糊/认识”，每道题自动评分，对错是主要依据：答错为不会；选择题和填空答对但比你平时慢很多（超过 1.6 倍）为模糊，选择题按题型分别比（读英文释义本来就慢），中英互选 4 秒内、英义选词和同义词 6 秒内答对不算模糊；写释义题不计时；只有在填空这类较难题型上很快答对才算很熟。熟词答对简单的选择题、或练习还没到期的词，不会延长间隔。AI 助教 判为部分正确时先不计分，几题后换个题型再考。之后用 FSRS 算法排下一次复习，新词的初始难度参考词频和考纲。', 'You never rate yourself; every question is graded automatically, mainly on right or wrong. Wrong means “didn’t know”. A right answer much slower than your usual (over 1.6×) on multiple choice or cloze means “shaky”; multiple choice is compared per question type (reading an English definition takes longer), and right answers within 4 s on word↔meaning or 6 s on definition→word and synonyms are never “shaky”. Written answers aren’t timed. Only a fast right answer on a harder format like cloze counts as “knew it cold”. Getting an easy multiple-choice question right on a well-known word, or practising a word that isn’t due, doesn’t lengthen the interval. When the AI tutor judges an answer partly right, it isn’t graded yet and comes back in another format a few questions later. FSRS then schedules the next review; a new word’s starting difficulty reflects its frequency and syllabus level.')}
    ${L(`词表里标为常见（scr）的词先做一次斩词筛查：${screenSecTxt()} 秒内选对释义就跳过，${SCREEN_DAYS} 天后抽查一次；考冷门义的词不走这条路。`, `Words marked common (scr) in the list are screened first: pick the right meaning within ${screenSecTxt()} s and the word is skipped, with a spot-check in ${SCREEN_DAYS} days. Words tested on an uncommon meaning aren’t screened.`)}
    ${L('你平时的用时：中选英 ', 'Your usual times: meaning → word ')}<span class="num">${(medType('mc', 'mc_zh2en') / 1000).toFixed(1)}</span>${L(' 秒，英选中 ', ' s, word → meaning ')}<span class="num">${(medType('mc', 'mc_en2zh') / 1000).toFixed(1)}</span>${L(' 秒，英义选词 ', ' s, definition → word ')}<span class="num">${(medType('mc', 'mc_def2word') / 1000).toFixed(1)}</span>${L(' 秒，填空 ', ' s, cloze ')}<span class="num">${(med('cloze') / 1000).toFixed(1)}</span>${L(' 秒，写释义 ', ' s, written meaning ')}<span class="num">${(med('type') / 1000).toFixed(1)}</span>${L(' 秒。', ' s.')}</div>
  </section>
  <section class="sec">
    <h2>${L('重置', 'Reset')}</h2>
    <div class="row"><button class="btn sm" id="reset">${L('清空全部进度', 'Erase all progress')}</button></div>
    <div id="resetconfirm"></div>
  </section>`;
  const savePrefs = (patch) => {
    const before = S.L.prefs.order;
    S.L.prefs = { ...S.L.prefs, ...patch, u: Date.now() };
    S.L.dirtyP = true;
    if (before !== S.L.prefs.order) buildNewOrder();
    saveLocal(); schedulePush(true);
  };
  RT.status?.then((c) => { const el = $('#service-status'); if (el) el.textContent = `${L('AI：', 'AI: ')}${c.ai ? c.model : L('未配置', 'not set up')} · ${L('词典：', 'Dictionary: ')}${c.mw ? L('已填 MW key', 'MW key added') : L('未配置', 'not set up')} · ${L('存储：', 'Storage: ')}${c.storage === 'supabase' ? L('Supabase 云同步', 'Supabase cloud sync') : L('仅本机', 'this device only')}`; });
  $('#lang').value = RT.lang || 'zh';
  $('#lang').addEventListener('change', (e) => { RT.setLang?.(e.target.value); location.reload(); });
  $('#savecfg').addEventListener('click', () => {
    const v = (id) => $('#' + id).value.trim();
    RT.saveConfig?.({ ai: { base: v('aibase'), model: v('aimodel'), key: v('aikey') }, mw: { dict: v('mwdict'), thes: v('mwthes') }, sb: { url: v('sburl'), anon: v('sbanon') } });
    toast(L('已保存，重新载入中', 'Saved; reloading')); setTimeout(() => location.reload(), 500);
  });
  $('#sbin')?.addEventListener('click', async (e) => {
    const email = $('#sbemail').value.trim(); if (!email) return;
    e.currentTarget.disabled = true;
    try { await RT.signIn(email); toast(L('登录链接已发到邮箱，点开后会回到这里', 'Sign-in link sent; opening it brings you back here'), 4000); } catch (err) { toast(L('发送失败：', 'Couldn’t send: ') + (err?.message || err)); e.currentTarget.disabled = false; }
  });
  $('#sbout')?.addEventListener('click', async () => { await RT.signOut?.(); location.reload(); });
  $('#deckf').addEventListener('change', importDeck);
  $('#decksample')?.addEventListener('click', () => { try { localStorage.removeItem(DECK_KEY); } catch (e) { /* ignore */ } location.reload(); });
  $('#drillf').addEventListener('change', importDrillSet);
  $('#drillrm')?.addEventListener('click', () => { try { localStorage.removeItem(DRILLS_KEY); } catch (e) { /* ignore */ } location.reload(); });
  $('#exportai').addEventListener('click', exportForAI);
  $('#daily').addEventListener('change', (e) => savePrefs({ dailyNew: Math.max(0, Math.min(300, parseInt(e.target.value, 10) || 0)) }));
  $('#exam').addEventListener('change', (e) => savePrefs({ examDate: e.target.value }));
  $('#order').addEventListener('change', (e) => savePrefs({ order: e.target.value }));
  $('#typing').addEventListener('change', (e) => savePrefs({ typing: e.target.checked }));
  $('#autonew').addEventListener('change', (e) => savePrefs({ autoNew: e.target.checked }));
  $('#autonext').addEventListener('change', (e) => savePrefs({ autoNext: e.target.checked }));
  $('#screensec').addEventListener('change', (e) => { savePrefs({ screenSec: Math.min(15, Math.max(2, parseFloat(e.target.value) || 5)) }); renderSettings(); });
  $('#syncnow').addEventListener('click', async () => { await pull(); renderSettings(); toast(S.sync.state === 'ok' ? L('已同步', 'Synced') : S.sync.msg || L('同步失败', 'Sync failed')); });
  $('#export').addEventListener('click', (e) => exportProgress(e.currentTarget));
  $('#importf').addEventListener('change', importProgress);
  $('#reset').addEventListener('click', () => {
    $('#resetconfirm').innerHTML = `<div class="feedback">${L('会删除这台设备和云端的全部学习记录，不能恢复。建议先导出备份。', 'This deletes all study records on this device and in the cloud, and can’t be undone. Export a backup first.')}<div class="row" style="margin-top:8px"><button class="btn sm" id="reset-yes" style="border-color:var(--bad);color:var(--bad)">${L('确认清空', 'Erase everything')}</button><button class="btn sm" id="reset-no">${L('取消', 'Cancel')}</button></div></div>`;
    $('#reset-no').addEventListener('click', () => { $('#resetconfirm').innerHTML = ''; });
    $('#reset-yes').addEventListener('click', resetAll);
  });
}
async function importDeck(e) {
  const f = e.target.files?.[0]; if (!f) return;
  e.target.value = '';
  try {
    const text = await f.text();
    const raw = /\.csv$/i.test(f.name) || !/^\s*[\[{]/.test(text) ? parseCsvDeck(text) : JSON.parse(text);
    const d = normalizeDeck(Array.isArray(raw) ? { words: raw } : raw);
    if (!d.words.length) throw new Error('empty');
    d.name ||= f.name.replace(/\.[^.]+$/, '');
    localStorage.setItem(DECK_KEY, JSON.stringify(d));
    toast(L(`已导入 ${d.words.length} 个词，重新载入中`, `Imported ${d.words.length} words; reloading`)); setTimeout(() => location.reload(), 600);
  } catch (err) { toast(err?.name === 'QuotaExceededError' ? L('词表太大，浏览器存不下', 'The list is too big for browser storage') : L('没读出词：检查 CSV 列或 JSON 格式', 'No words found: check the CSV columns or JSON format')); }
}
async function importDrillSet(e) {
  const f = e.target.files?.[0]; if (!f) return;
  e.target.value = '';
  try {
    const d = JSON.parse(await f.text());
    if (!d?.items?.length || !d.items.every((x) => x.id && x.type && x.text)) throw new Error('bad');
    localStorage.setItem(DRILLS_KEY, JSON.stringify(d));
    toast(L(`已导入 ${d.items.length} 道题，重新载入中`, `Imported ${d.items.length} questions; reloading`)); setTimeout(() => location.reload(), 600);
  } catch (err) { toast(L('题集格式不对，见 data/schema.md', 'Invalid question set format; see data/schema.md')); }
}
// One file any AI can read: a short Markdown summary, then every graded answer as CSV.
function exportForAI() {
  const rows = [['event_id', 'time', 'word', 'kind', 'correct', 'ms', 'grade', 'scheduled', 'lookup_capped', 'stability_before', 'difficulty_before', 'recall_predicted', 'algo']];
  let n = 0, ok = 0;
  for (const s of Object.values(S.L.sessions)) for (const it of s.items || []) {
    rows.push([it.e || '', new Date(it.t).toISOString(), S.byId.get(it.i)?.w || it.i, it.k, it.ok ? 1 : 0, it.ms ?? '', it.g ?? '', it.sch ? 1 : 0, it.cap ? 1 : 0, it.s0 ?? '', it.d0 ?? '', it.r0 ?? '', it.av || '']);
    n++; if (it.ok) ok++;
  }
  const cards = Object.values(S.L.cards).filter((c) => c.st);
  const md = `# Vocabulary study export (${dayKey()})\n\n- words studied: ${cards.length} of ${S.words.length}\n- answers logged: ${n}, correct ${n ? Math.round(ok / n * 100) : 0}%\n- scheduler: FSRS-5 with automatic grading (${ALGO_VERSION})\n\nColumns: kind = question type; grade 1-4 = Again/Hard/Good/Easy (empty = not graded); scheduled = this answer moved the review date; lookup_capped = grade capped because the word was looked up within 24 h; *_before and recall_predicted are the memory state right before the answer.\n\n\`\`\`csv\n${rows.map((r) => r.map((x) => /[",\n]/.test(String(x)) ? '"' + String(x).replace(/"/g, '""') + '"' : x).join(',')).join('\n')}\n\`\`\`\n`;
  const blob = new Blob([md], { type: 'text/markdown' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `vocab-for-ai-${dayKey()}.md`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}
async function backupData() {
  const d = { app: APP_ID, v: 3, at: new Date().toISOString(), deck: S.data, questionSet: JSON.parse(localStorage.getItem(DRILLS_KEY) || 'null'), cards: S.L.cards, prefs: S.L.prefs, custom: S.L.custom, sessions: { ...S.L.sessions },
    notes: S.L.notes, lookups: S.L.lookups, asked: S.L.asked, chats: { ...S.L.chats }, parts: {}, diag: S.L.diag, drill: S.L.drill };
  if (S.db) {
    try {
      await push();
      for (const x of (await S.db.collection('me/logs/s').get()).docs) { const r = x.data(); if ((r.items?.length || 0) > (d.sessions[x.id]?.items?.length || 0)) d.sessions[x.id] = r; }
      for (const x of (await S.db.collection('me/chat/c').get()).docs) {
        const r = x.data();
        if ((r.updated || 0) >= (d.chats[x.id]?.updated || 0)) d.chats[x.id] = r;
        for (let n = 0; n < (d.chats[x.id].parts || 0); n++) { const p = await S.db.doc(`me/chat/c/${x.id}/p/${n}`).get(); if (p.exists) d.parts[`${x.id}/${n}`] = p.data(); }
      }
      d.complete = true;
    } catch (e) { d.complete = false; }
  }
  return d;
}
async function exportProgress(btn) {
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spin"></span> ' + L('整理中', 'Preparing'); }
  const d = await backupData();
  if (btn) { btn.disabled = false; btn.textContent = L('导出进度', 'Export progress'); }
  const data = JSON.stringify(d);
  const filename = `${APP_ID}-progress-${dayKey()}.json`;
  const note = d.complete === false ? L('（云端没读全，只含这台设备上的记录）', ' (couldn’t read everything from the cloud; only this device’s records are included)') : '';
  const dl = await useCap('downloads');
  if (dl) {
    try { await dl.save({ filename, data: new Blob([data], { type: 'application/json' }) }); toast(L('已导出', 'Exported') + note); return; } catch (e) { if (e?.code === 'declined' || e?.code === 'cancelled') return; }
  }
  try { await navigator.clipboard.writeText(data); toast(L('无法下载文件，进度 JSON 已复制到剪贴板', 'Couldn’t download, so the progress JSON was copied to the clipboard') + note); } catch (e) { toast(L('导出失败：这个环境不允许下载或复制', 'Export failed: this environment allows neither downloads nor copying')); }
}
// Import merges, item by item, newest wins; nothing already here is lost, and everything imported is
// queued for the cloud.
async function importProgress(e) {
  const f = e.target.files?.[0]; if (!f) return;
  e.target.value = '';
  let d;
  try { d = JSON.parse(await f.text()); if (d.app !== APP_ID || !d.cards) throw new Error('bad'); }
  catch (err) { toast(L('文件格式不对：请选择从这里导出的 JSON', 'Wrong file format: choose a JSON exported from this app')); return; }
  try { restoreBackupMaterials(d); }
  catch (err) { toast(L('无法恢复词表或题集：检查备份格式和浏览器存储空间', 'Could not restore the word list or question set: check the backup and browser storage space')); return; }
  const { n, nc } = mergeIntoLocal(d);
  indexWords(S.data); saveLocal(true); push();
  toast(L(`导入完成：${n} 个词的进度${nc ? `、${nc} 个对话` : ''}更新了`, `Import done: progress updated for ${n} words${nc ? ` and ${nc} chats` : ''}`)); render();
}
// Version 3 carries the active study material as well as progress. Older backups leave it unchanged.
function restoreBackupMaterials(d) {
  const deck = d.deck === undefined ? null : normalizeDeck(d.deck);
  if (deck && !deck.words.length) throw new Error('invalid_deck');
  const hasQuestions = Object.hasOwn(d, 'questionSet');
  const questions = d.questionSet;
  if (hasQuestions && questions !== null && (!Array.isArray(questions?.items) || !questions.items.length || !questions.items.every(x => x.id && x.type && x.text))) throw new Error('invalid_questions');
  const changes = [];
  if (deck) changes.push([DECK_KEY, JSON.stringify(deck)]);
  if (hasQuestions) changes.push([DRILLS_KEY, questions === null ? null : JSON.stringify(questions)]);
  const previous = changes.map(([key]) => [key, localStorage.getItem(key)]);
  try {
    for (const [key, value] of changes) { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); }
  } catch (err) {
    for (const [key, value] of previous) { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); }
    throw err;
  }
  if (deck) { S.data = deck; S.forms = deck.forms || {}; }
  if (hasQuestions) S.drills = null;
}
// Item-by-item merge, newest wins; everything taken in is queued for upload. Used by backup import and when
// progress made before signing in moves into the account (runtime/index.js leaves it in ovd-pending-merge).
function mergeIntoLocal(d) {
  const LS = S.L;
  let n = 0;
  for (const [id, c] of Object.entries(d.cards)) { const l = LS.cards[id]; if (!l || (c.u || 0) > (l.u || 0)) { LS.cards[id] = c; markDirty(id); n++; } }
  for (const [id, w] of Object.entries(d.custom || {})) if (!LS.custom[id] || cstamp(w) > cstamp(LS.custom[id])) { LS.custom[id] = w; (LS.dirtyU ||= {})[id] = 1; }
  for (const [sid, x] of Object.entries(d.sessions || {})) if ((x.items?.length || 0) > (LS.sessions[sid]?.items?.length || 0)) { LS.sessions[sid] = x; LS.dirtyS[sid] = 1; }
  if ((d.prefs?.u || 0) > (LS.prefs.u || 0)) { LS.prefs = { ...DEFAULT_PREFS, ...d.prefs }; LS.dirtyP = true; }
  for (const [id, x] of Object.entries(d.notes || {})) if ((x?.u || 0) > (LS.notes[id]?.u || 0)) { LS.notes[id] = x; LS.dirtyN[id] = 1; }
  if (mergeLookups(d.lookups)) LS.dirtyL = true;
  for (const [id, t] of Object.entries(d.asked || {})) if (t > (LS.asked[id] || 0)) { LS.asked[id] = t; LS.dirtyA = true; }
  let nc = 0;
  for (const [cid, c] of Object.entries(d.chats || {})) if ((c?.updated || 0) > (LS.chats[cid]?.updated || 0)) {
    LS.chats[cid] = c; LS.dirtyC[cid] = 1; nc++;
    for (let k = 0; k < (c.parts || 0); k++) { const p = d.parts?.[`${cid}/${k}`]; if (p) (LS.partsQ ||= {})[`${cid}/${k}`] = p; }
  }
  if ((d.diag?.at || 0) > (LS.diag?.at || 0)) LS.diag = d.diag;
  if (mergeDrill(d.drill)) LS.dirtyDr = true;
  return { n, nc };
}
async function resetAll() {
  if (S.db && !S.readOnly) {
    try {
      for (let i = 0; i < NB; i++) await S.db.doc('me/cards/b/b' + String(i).padStart(2, '0')).delete();
      const ls = await S.db.collection('me/logs/s').get();
      for (const d of ls.docs) await S.db.doc('me/logs/s/' + d.id).delete();
    } catch (e) { toast(L('云端没能全部清空：', 'Couldn’t fully clear the cloud: ') + (e?.message || e?.code)); }
  }
  const keep = { prefs: S.L.prefs, custom: S.L.custom, ai: S.L.ai };
  S.L = { ...freshLocal(), ...keep };
  saveLocal(true);
  toast(L('进度已清空', 'Progress erased')); render();
}

// ---------- deck ----------
// The word list: an imported deck (Settings → 词表) if there is one, else the bundled sample.
const DECK_KEY = 'ovd-deck';
async function loadDeck() {
  try { const raw = localStorage.getItem(DECK_KEY); if (raw) { const d = JSON.parse(raw); if (d?.words?.length) return normalizeDeck(d); } } catch (e) { /* fall back to the sample */ }
  const res = await fetch('data/sample-deck.json');
  if (!res.ok) throw new Error(res.status);
  return normalizeDeck(await res.json());
}
// Imported entries get the fields the scheduler and question builder expect; confusable groups come from `conf`.
function normalizeDeck(d) {
  const words = (d.words || []).filter((w) => w?.w && w.senses?.length).map((w) => ({
    ...w, id: w.id || slugId(w.w), tags: w.tags?.length ? w.tags : ['core'],
    senses: w.senses.map((x) => ({ pos: x.pos || '', zh: x.zh || '', en: x.en || '', ex: (x.ex || []).filter((e) => e?.en) })),
    syn: w.syn || [], ant: w.ant || [], df: typeof w.df === 'number' ? w.df : 0.5,
  }));
  const ids = new Set(words.map((w) => w.id));
  for (const w of words) { if (w.conf) w.conf = w.conf.filter((c) => ids.has(c)); if (w.conf?.length && !w.tags.includes('confusable')) w.tags.push('confusable'); }
  const groups = d.confusables?.length ? d.confusables : (() => { const seen = new Set(), g = []; for (const w of words) if (w.conf?.length && !seen.has(w.id)) { const grp = [w.id, ...w.conf]; grp.forEach((x) => seen.add(x)); g.push(grp); } return g; })();
  return { version: 1, name: d.name || '', words, confusables: groups, forms: d.forms || {} };
}
const slugId = (w) => String(w).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
// CSV columns: word,pos,zh,en,example[,example_zh][,synonyms separated by ;]
function parseCsvDeck(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const body = rows.filter((r) => r.some((c) => c.trim()));
  if (body.length && /^word$/i.test(body[0][0].trim())) body.shift();
  const byWord = new Map();
  for (const [w, pos = '', zh = '', en = '', ex = '', exZh = '', syn = ''] of body) {
    const word = (w || '').trim(); if (!word) continue;
    const e = byWord.get(word.toLowerCase()) || { w: word, senses: [], syn: [] };
    if (zh.trim() || en.trim()) e.senses.push({ pos: pos.trim(), zh: zh.trim(), en: en.trim(), ex: ex.trim() ? [{ en: ex.trim(), zh: exZh.trim() }] : [] });
    for (const x of syn.split(/[;；]/).map((t) => t.trim()).filter(Boolean)) if (!e.syn.includes(x)) e.syn.push(x);
    byWord.set(word.toLowerCase(), e);
  }
  return { words: [...byWord.values()] };
}

// ---------- boot ----------
async function boot() {
  S.L = loadLocal();
  try {
    const pending = localStorage.getItem('ovd-pending-merge');
    if (pending) { const d = JSON.parse(pending); if (d?.cards) { mergeIntoLocal(d); saveLocal(true); } localStorage.removeItem('ovd-pending-merge'); }
  } catch (e) { /* a broken leftover is dropped */ }
  document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => { S.tab = b.dataset.tab; S.sub = null; window.scrollTo(0, 0); render(); }));
  try {
    S.data = await loadDeck();
    S.forms = S.data.forms || {};
    S.gm = []; S.sx = [];
  } catch (e) {
    app().innerHTML = `${topBar()}<div class="empty">${L('词库没有加载出来。检查网络后刷新页面。', 'The word list didn’t load. Check your connection and refresh.')}</div>`;
    return;
  }
  indexWords(S.data);
  render();
  const [db, sample, user, mcp] = await Promise.all([useCap('db'), useCap('sample'), useCap('user'), useCap('mcp')]);
  S.sample = sample;
  S.mcp = mcp;
  if (user) {
    try { if (!(await user.isOwner())) { S.readOnly = true; } } catch (e) { /* treat as owner */ }
  }
  if (db && !S.readOnly) { S.db = thawDb(db); await pull(); await loadMwIdx(); }
  else if (S.readOnly) setSync('error', L('只有页面主人能保存进度，你的进度只存在本机', 'Only the page owner can save progress; yours stays on this device'));
  migratePrefs();
  if (!S.session) render();
}
function migratePrefs() {
  const p = S.L.prefs;
  if ((p.pv || 0) >= PREFS_VERSION) return;
  S.L.prefs = { ...p, autoNext: false, screenSec: p.screenSec || 5, pv: PREFS_VERSION, u: Date.now() };
  S.L.dirtyP = true;
  saveLocal(); schedulePush(true);
}
// A sticky header stops env(safe-area-inset-top) below the top, so on a phone the list scrolls
// visibly through the strip under the status bar. While a header is stuck, .stuck paints that
// strip (a ::before in the page colour); no layout shift, and no strip at rest.
function markStuck() {
  for (const el of document.querySelectorAll('.search, .sess-top')) {
    const top = parseFloat(getComputedStyle(el).top) || 0;
    el.classList.toggle('stuck', el.getBoundingClientRect().top <= top + 0.5 && window.scrollY > 0);
  }
}
window.addEventListener('scroll', markStuck, { passive: true });
// all scripts are deferred: start once chat.js and practice.js have run too
// During deferred scripts readyState is already "interactive", but practice.js has not run yet.
if (document.readyState !== 'complete') document.addEventListener('DOMContentLoaded', boot, { once: true }); else boot();
