// node scripts/test_engine.mjs — storage merge rules, the Merriam-Webster parser, and the bundled deck.
// (Hand-written MW fixture: no real API responses are kept in this repository.)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mergedWrite, createStore } from '../runtime/supabase.js';
import { fakeClient } from './fake_supabase.mjs';
import { parseDictionary, cleanText, audioUrl } from '../runtime/mw-parse.js';

const here = (p) => new URL(p, import.meta.url);

// --- sync merge rules: a stale tab or device can't roll data back ---
{
  const old = { c: { a: { u: 5, s: 3 }, b: { u: 9, s: 10 } } };
  const stale = { c: { a: { u: 7, s: 4 }, b: { u: 2, s: 1 } } };
  const m = mergedWrite('me/cards/b/b01', old, stale, false);
  assert.equal(m.c.a.s, 4, 'newer card wins');
  assert.equal(m.c.b.s, 10, 'older card from a stale tab does not overwrite');
  const keepsOthers = mergedWrite('me/cards/b/b01', old, { c: { z: { u: 1 } } }, false);
  assert.ok(keepsOthers.c.a && keepsOthers.c.b && keepsOthers.c.z, 'cards edited elsewhere survive');
  const log = mergedWrite('me/logs/s/x', { items: [1, 2, 3] }, { items: [1] }, false);
  assert.equal(log.items.length, 3, 'a session log never shrinks');
  assert.equal(mergedWrite('me/prefs', { u: 10, dailyNew: 40 }, { u: 5, dailyNew: 99 }, false).dailyNew, 40, 'older prefs ignored');
  assert.deepEqual(mergedWrite('me/x/y', { a: { b: 1, c: 2 } }, { a: { c: 3 } }, true), { a: { b: 1, c: 3 } }, 'update deep-merges');
}

// --- MW parser on a hand-written entry ---
{
  const raw = JSON.parse(readFileSync(here('./fixtures/mw-collegiate-sample.json'), 'utf8'));
  const d = parseDictionary(raw, 'placate');
  assert.equal(d.status, 'entry');
  assert.equal(d.entries[0].hw.replace(/\*/g, ''), 'placate');
  assert.ok(JSON.stringify(d).includes('to calm someone'), 'definition text kept');
  assert.equal(cleanText('{bc}to calm {it}someone{/it}'), 'to calm someone');
  assert.match(audioUrl('placat01'), /\/p\/placat01\.mp3$/);
  assert.equal(parseDictionary(['placard', 'placid'], 'plaacate').status !== 'entry', true, 'suggestions are not an entry');
}

// --- bundled deck: shape the app relies on, original content flags ---
{
  const deck = JSON.parse(readFileSync(here('../data/sample-deck.json'), 'utf8'));
  assert.equal(deck.license, 'CC BY 4.0');
  const ids = new Set();
  for (const w of deck.words) {
    assert.ok(w.id && w.w && !ids.has(w.id), 'unique id ' + w.id); ids.add(w.id);
    assert.ok(w.senses.length >= 1, w.id);
    for (const s of w.senses) assert.ok(s.pos && s.zh && s.en && s.ex?.[0]?.en, 'complete sense ' + w.id);
    assert.ok(w.df >= 0 && w.df <= 1, 'df ' + w.id);
    for (const c of w.conf || []) assert.ok(deck.words.some((x) => x.id === c), 'look-alike exists ' + c);
  }
  for (const g of deck.confusables) assert.ok(g.every((id) => ids.has(id)));
  assert.ok(deck.words.length >= 100);
}
// --- word-list import: CSV parser and normalisation (functions lifted from app.js) ---
{
  const src = readFileSync(here('../app.js'), 'utf8');
  const grab = (name) => { const i = src.indexOf(`function ${name}(`); assert.ok(i >= 0, name); let depth = 0, j = src.indexOf('{', i); for (; j < src.length; j++) { if (src[j] === '{') depth++; else if (src[j] === '}' && --depth === 0) break; } return src.slice(i, j + 1); };
  const slug = src.match(/const slugId = .*;/)[0];
  const mod = new Function(`${slug}\n${grab('parseCsvDeck')}\n${grab('normalizeDeck')}\nreturn { parseCsvDeck, normalizeDeck };`)();
  const csv = 'word,pos,zh,en,example,example_zh,synonyms\nplacate,v.t.,平息,to calm someone,"She tried to placate them, briefly.",她试图安抚他们。,appease;mollify\nplacate,v.t.,讨好,to win favour,,,\nplacid,adj.,平静的,calm and quiet,,,\n';
  const d = mod.normalizeDeck(mod.parseCsvDeck(csv));
  assert.equal(d.words.length, 2, 'rows of one word merge');
  const p = d.words.find((w) => w.w === 'placate');
  assert.equal(p.senses.length, 2);
  assert.equal(p.senses[0].ex[0].en, 'She tried to placate them, briefly.', 'quoted comma kept');
  assert.deepEqual(p.syn, ['appease', 'mollify']);
  assert.equal(p.df, 0.5, 'default prior difficulty');
  const j = mod.normalizeDeck({ words: [{ w: 'Ab', senses: [{ en: 'x' }], conf: ['missing'] }] });
  assert.equal(j.words[0].id, 'ab'); assert.deepEqual(j.words[0].conf, []);
}
// --- Supabase adapter: conditional writes under concurrency, idempotent answer log ---
{
  // tab B writes between tab A's read and A's update → A's conditional update misses and retries on fresh data
  let raced = false, client;
  client = fakeClient({ beforeUpdate: async (st) => {
    if (raced || st.table !== 'documents') return;
    raced = true;
    const row = client.tables.documents.get('me/cards/b/b01');
    row.data = { c: { ...row.data.c, fromB: { u: 50 } } }; row.revision += 1;
  } });
  const db = createStore(client);
  await db.doc('me/cards/b/b01').set({ c: { a: { u: 1 } } });
  await db.doc('me/cards/b/b01').set({ c: { fromA: { u: 40 } } });
  const c = (await db.doc('me/cards/b/b01').get()).data().c;
  assert.ok(c.a && c.fromA && c.fromB, 'both tabs\' cards survive a write race');
  // a stale tab with an older copy of a card cannot roll it back
  await db.doc('me/cards/b/b01').set({ c: { fromB: { u: 10, stale: true } } });
  assert.ok(!(await db.doc('me/cards/b/b01').get()).data().c.fromB.stale, 'stale card ignored');
  // session logs → one review row per answer, never duplicated by re-uploads
  const items = [{ e: 'e1', t: 1, i: 'abate', k: 'mc_en2zh', ok: 1, ms: 900, g: 3, sch: 1, s0: 2.1, d0: 5, r0: 0.93, av: 'v1' }, { e: 'e2', t: 2, i: 'belie', k: 'learn', ok: 1, g: 0 }];
  await db.doc('me/logs/s/s1').set({ items });
  await db.doc('me/logs/s/s1').set({ items: [...items, { e: 'e3', t: 3, i: 'cogent', k: 'mc_zh2en', ok: 0, g: 1, sch: 1 }] });
  assert.equal(client.tables.reviews.size, 3, 'answers upserted once each');
  const r1 = client.tables.reviews.get('e1');
  assert.equal(r1.scheduled, true); assert.equal(r1.recall_predicted, 0.93); assert.equal(r1.grade, 3);
  // collection queries see nested documents only under their own parent
  await db.doc('me/chat/c/x').set({ updated: 1 }); await db.doc('me/chat/c/x/p/0').set({ msgs: [] });
  assert.equal((await db.collection('me/chat/c').get()).size, 1);
}
// --- Merriam-Webster policy: no stored MW content, nothing for the AI, including the add-word fallback ---
{
  const src = readFileSync(here('../app.js'), 'utf8');
  for (const k of ['MW_PERSIST', 'MW_TO_AI']) assert.match(src, new RegExp(`const ${k} = false;`), k + ' defaults to false');
  assert.match(src, /const MW_AUTO_PER_DAY = 0;/, 'no automatic lookups');
  const i = src.indexOf('function entryFromMw('); let depth = 0, j = src.indexOf('{', i);
  for (; j < src.length; j++) { if (src[j] === '{') depth++; else if (src[j] === '}' && --depth === 0) break; }
  const entryFromMw = new Function('MW_PERSIST', 'MW_TO_AI', 'mwSenses', 'FL_SHORT', 'newCustomId', `${src.slice(i, j + 1)}; return entryFromMw;`)(
    false, false, () => [{ def: 'to calm someone', entry: 'placate', fl: 'verb', ex: ['e.g.'] }], { verb: 'v.' }, (w) => 'u-' + w);
  const mw = { status: 'entry', entries: [{ id: 'placate', hw: 'pla*cate' }] };
  assert.equal(entryFromMw('placate', mw), null, 'an MW result never becomes a saved entry under the default policy');
  assert.match(src, /mwCredit\(word\)/, 'MW results carry the logo credit');
}
console.log('engine tests passed');
