// Regression checks for imported-deck startup, portable backups and interrupted analytics writes.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createStore } from '../runtime/supabase.js';
import { fakeClient } from './fake_supabase.mjs';

const src = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const section = (from, to) => {
  const start = src.indexOf(from), end = src.indexOf(to, start);
  assert.ok(start >= 0 && end > start, from);
  return src.slice(start, end);
};

// Deferred scripts execute while readyState is interactive. A cached deck resolves immediately,
// so boot must wait for practice.js rather than relying on a network fetch to yield long enough.
for (const readyState of ['loading', 'interactive', 'complete']) {
  let booted = 0, practiceReady = readyState === 'complete';
  const events = new Map();
  vm.runInNewContext(src.slice(src.indexOf("if (document.readyState")), {
    document: { readyState, addEventListener: (name, fn) => events.set(name, fn) },
    boot() { assert.ok(practiceReady, 'practice definitions must exist before boot'); booted++; },
  });
  if (readyState !== 'complete') {
    assert.equal(booted, 0);
    practiceReady = true;
    events.get('DOMContentLoaded')();
  }
  assert.equal(booted, 1);
}

// A backup must carry imported study material, not just card ids pointing into another device's list.
{
  const values = new Map(); let failValue;
  const localStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { if (value === failValue) throw new Error('quota'); values.set(key, value); },
    removeItem: key => values.delete(key),
  };
  const deck = { name: 'Imported animals', words: [{ id: 'quokka', w: 'quokka', senses: [{ en: 'a small marsupial', zh: '短尾矮袋鼠' }] }] };
  const questionSet = { items: [{ id: 'q1', type: 'tc1', text: 'A ____ rests.', blanks: [{ options: ['quokka'], answer: 0 }] }] };
  values.set('deck', JSON.stringify(deck)); values.set('questions', JSON.stringify(questionSet));
  const c = { APP_ID: 'retentide', DECK_KEY: 'deck', DRILLS_KEY: 'questions', localStorage,
    S: { data: deck, db: null, L: { cards: { quokka: { s: 3, u: 10 } }, sessions: {}, chats: {} } } };
  vm.createContext(c);
  vm.runInContext([
    src.match(/^const slugId = .*$/m)[0],
    section('function normalizeDeck(', 'const slugId ='),
    section('async function backupData(', 'async function exportProgress('),
    section('function restoreBackupMaterials(', '// Item-by-item merge'),
  ].join('\n'), c);
  const backup = JSON.parse(JSON.stringify(await c.backupData()));
  assert.equal(backup.v, 3);
  assert.deepEqual(backup.deck, deck);
  assert.deepEqual(backup.questionSet, questionSet);
  values.clear(); c.S.data = { words: [] }; c.S.drills = { stale: true };
  c.restoreBackupMaterials(backup);
  assert.equal(c.S.data.words[0].id, 'quokka');
  assert.equal(JSON.parse(values.get('questions')).items[0].id, 'q1');
  assert.equal(c.S.drills, null, 'loaded question cache must be invalidated');
  const snapshot = JSON.stringify([...values]);
  c.restoreBackupMaterials({ v: 2, cards: {} });
  assert.equal(JSON.stringify([...values]), snapshot, 'legacy backups preserve active material');
  assert.throws(() => c.restoreBackupMaterials({ deck: { words: [] } }));
  assert.equal(JSON.stringify([...values]), snapshot);
  const newQuestions = { items: [{ id: 'q2', type: 'tc1', text: 'Another ____.' }] };
  failValue = JSON.stringify(newQuestions);
  assert.throws(() => c.restoreBackupMaterials({ deck: { ...deck, name: 'Replacement' }, questionSet: newQuestions }), /quota/);
  assert.equal(JSON.stringify([...values]), snapshot, 'failed restore rolls back material writes');
}

// A failed reviews write must remain pending in the actual upload loop and retry without duplicate rows.
{
  const base = fakeClient(); let fail = true;
  const client = { from: table => table === 'reviews' && fail ? {
    upsert: async () => ({ error: { message: 'temporary analytics outage' } }),
  } : base.from(table) };
  const db = createStore(client);
  const items = [1, 2].map(n => ({ e: 'event' + n, t: n, i: 'quokka', k: 'mc_en2zh', ok: 1, g: 3 }));
  await assert.rejects(db.doc('me/logs/s/s1').set({ items }), e => e.code === 'unavailable');
  assert.equal(base.tables.documents.get('me/logs/s/s1').data.items.length, 2);
  const timers = [], states = [];
  const c = { S: { db, readOnly: false, L: {
    dirty: {}, dirtyS: { s1: 1 }, sessions: { s1: { items: items.slice(0, 1) } }, dirtyP: false,
    dirtyC: {}, dirtyN: {}, dirtyU: {}, partsQ: {}, dirtyA: false, dirtyL: false, dirtyDr: false,
  } }, pushTimer: null, navigator: { onLine: true },
  setSync: s => states.push(s), handleSyncError: () => states.push('offline'), saveLocal() {},
  clearTimeout() {}, setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; } };
  vm.createContext(c);
  vm.runInContext(section('let pushing = false', 'function handleSyncError('), c);
  await c.push();
  assert.equal(c.S.L.dirtyS.s1, 1, 'failed analysis upload stays queued');
  assert.equal(states.at(-1), 'offline');
  assert.equal(timers[0].ms, 1000);
  fail = false; await timers[0].fn();
  assert.equal(c.S.L.dirtyS.s1, undefined);
  assert.equal(states.at(-1), 'ok');
  assert.equal(base.tables.reviews.size, 2, 'retry projects the merged document, including the longer stored log');
  await db.doc('me/logs/s/s1').set({ items });
  assert.equal(base.tables.reviews.size, 2, 'retry never duplicates events');
}
console.log('release regression checks passed');
