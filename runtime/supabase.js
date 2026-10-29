// Optional cloud sync on the learner's own Supabase project (schema: supabase/migrations/0001_init.sql).
// Gives the app the small document API it already uses (doc/collection/where/orderBy/limit/get/set/update/delete)
// over one `documents` table, keeping the merge rules that stop a stale tab or device from rolling data back:
//   - card buckets merge card by card, newest `u` wins
//   - a session log never shrinks; prefs, notes, chats and custom words keep the newer stamp
//   - every write is conditional on the revision it read, retried on conflict
// Session logs are also written as one row per answer to `reviews` (idempotent on event_id) for analysis.
const SUPABASE_JS = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';

const plain = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
function deepMerge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) { if (k === '__proto__') continue; out[k] = plain(v) && plain(a?.[k]) ? deepMerge(a[k], v) : v; }
  return out;
}
export function mergedWrite(path, old, next, update) {
  if (path.startsWith('me/cards/b/') && old) {
    const c = { ...old.c };
    for (const [id, card] of Object.entries(next.c || {})) if (!c[id] || (card.u || 0) >= (c[id].u || 0)) c[id] = card;
    return { ...old, ...next, c };
  }
  if (old && path.startsWith('me/logs/s/') && (old.items?.length || 0) > (next.items?.length || 0)) return old;
  const stamp = (x) => x?.u || x?.updated || x?.added || 0;
  if (old && /^(me\/chat\/c\/[^/]+|me\/notes\/w\/[^/]+|me\/custom\/w\/[^/]+|me\/prefs)$/.test(path) && stamp(old) > stamp(next)) return old;
  return update ? deepMerge(old || {}, next) : next;
}
function filterRows(rows, filters, order, limit) {
  let docs = rows.map((r) => ({ path: r.path, id: r.path.split('/').pop(), data: r.data }));
  for (const [field, op, value] of filters) {
    docs = docs.filter((d) => (op === '>=' ? d.data[field] >= value : op === '<=' ? d.data[field] <= value : op === '==' ? d.data[field] === value : op === 'array-contains' ? Array.isArray(d.data[field]) && d.data[field].includes(value) : true));
  }
  if (order) docs.sort((a, b) => { const x = a.data[order[0]], y = b.data[order[0]]; return (x === y ? 0 : x > y ? 1 : -1) * (order[1] === 'desc' ? -1 : 1); });
  return limit > 0 ? docs.slice(0, limit) : docs;
}
const snap = (path, data) => ({ id: path.split('/').pop(), exists: data != null, data: () => (data == null ? undefined : structuredClone(data)), metadata: {} });
const parentOf = (path) => path.slice(0, path.lastIndexOf('/'));

function reviewRows(sid, items) {
  return (items || []).filter((it) => it.e).map((it) => ({
    event_id: it.e, session_id: sid, word_id: it.i, kind: it.k, correct: !!it.ok, ms: it.ms ?? null,
    grade: it.g || null, scheduled: !!it.sch, lookup_capped: !!it.cap,
    stability_before: it.s0 ?? null, difficulty_before: it.d0 ?? null, recall_predicted: it.r0 ?? null,
    algo: it.av || null, answered_at: new Date(it.t).toISOString(),
  }));
}

export async function loadSupabase(cfg) {
  const { createClient } = await import(SUPABASE_JS);
  return createClient(cfg.url, cfg.anon, { auth: { persistSession: true, detectSessionInUrl: true, storageKey: 'ovd-sb-auth' } });
}

export function createStore(client) {
  async function read(path) {
    const { data, error } = await client.from('documents').select('data,revision').eq('path', path).maybeSingle();
    if (error) throw Object.assign(new Error(error.message), { code: 'unavailable' });
    return data;
  }
  async function write(path, next, update = false) {
    if (!plain(next)) throw Object.assign(new Error('document must be an object'), { code: 'invalid_argument' });
    let committed;
    for (let attempt = 0; attempt < 6; attempt++) {
      const row = await read(path);
      if (update && !row) throw Object.assign(new Error('missing document'), { code: 'invalid_argument' });
      const value = mergedWrite(path, row?.data || null, next, update);
      if (row) {
        const { data, error } = await client.from('documents').update({ data: value, revision: row.revision + 1, updated_at: new Date().toISOString() })
          .eq('path', path).eq('revision', row.revision).select('revision');
        if (error) throw Object.assign(new Error(error.message), { code: 'unavailable' });
        if (data?.length) { committed = value; break; }
      } else {
        const { error } = await client.from('documents').insert({ path, collection: parentOf(path), data: value });
        if (!error) { committed = value; break; }
        if (error.code !== '23505') throw Object.assign(new Error(error.message), { code: 'unavailable' }); // 23505: another tab created it first
      }
      if (attempt === 5) throw Object.assign(new Error('write conflict'), { code: 'resource_exhausted' });
    }
    if (path.startsWith('me/logs/s/')) {
      const rows = reviewRows(path.split('/').pop(), committed.items);
      if (rows.length) {
        const { error } = await client.from('reviews').upsert(rows, { onConflict: 'user_id,event_id', ignoreDuplicates: true });
        if (error) throw Object.assign(new Error(error.message), { code: 'unavailable' });
      }
    }
  }
  const doc = (path) => ({
    path, id: path.split('/').pop(),
    get: async () => snap(path, (await read(path))?.data ?? null),
    set: (data) => write(path, data),
    update: (data) => write(path, data, true),
    delete: async () => { const { error } = await client.from('documents').delete().eq('path', path); if (error) throw Object.assign(new Error(error.message), { code: 'unavailable' }); },
    collection: (p) => coll(path + '/' + p),
  });
  const coll = (path, filters = [], order = null, limit = 0) => ({
    path,
    doc: (id) => doc(path + '/' + id),
    where: (...f) => coll(path, [...filters, f], order, limit),
    orderBy: (field, dir = 'asc') => coll(path, filters, [field, dir], limit),
    limit: (n) => coll(path, filters, order, n),
    get: async () => {
      const rows = [];
      for (let from = 0; ; from += 1000) {
        const { data, error } = await client.from('documents').select('path,data').eq('collection', path).order('path').range(from, from + 999);
        if (error) throw Object.assign(new Error(error.message), { code: 'unavailable' });
        rows.push(...data);
        if (data.length < 1000) break;
      }
      const docs = filterRows(rows, filters, order, limit).map((d) => snap(d.path, d.data));
      return { docs, size: docs.length, empty: !docs.length };
    },
  });
  return { doc, collection: coll };
}
