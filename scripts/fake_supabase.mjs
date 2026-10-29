// In-memory stand-in for the parts of supabase-js the store uses (one user, so RLS is implicit).
// Lets the tests exercise conditional writes, conflicts and idempotent review upserts without a server.
export function fakeClient({ beforeUpdate } = {}) {
  const tables = { documents: new Map(), reviews: new Map() };
  function query(table) {
    const st = { table, filters: [], op: 'select', payload: null, range: null, opts: {}, order: null };
    const rows = () => [...tables[table].values()].filter((r) => st.filters.every(([k, v]) => r[k] === v));
    const run = async () => {
      if (st.op === 'select') { let r = rows(); if (st.order) r.sort((a,b)=>a[st.order]<b[st.order]?-1:a[st.order]>b[st.order]?1:0); if (st.range) r = r.slice(st.range[0], st.range[1] + 1); return { data: r.map((x) => structuredClone(x)), error: null }; }
      if (st.op === 'update') {
        if (beforeUpdate) await beforeUpdate(st);
        const hit = rows(); for (const r of hit) Object.assign(r, structuredClone(st.payload));
        return { data: hit.map((r) => ({ revision: r.revision })), error: null };
      }
      if (st.op === 'insert') {
        if (tables[table].has(st.payload.path)) return { data: null, error: { code: '23505', message: 'duplicate' } };
        tables[table].set(st.payload.path, { revision: 1, ...structuredClone(st.payload) }); return { data: null, error: null };
      }
      if (st.op === 'upsert') { for (const r of st.payload) if (!tables[table].has(r.event_id)) tables[table].set(r.event_id, structuredClone(r)); return { data: null, error: null }; }
      if (st.op === 'delete') { for (const r of rows()) tables[table].delete(r.path); return { data: null, error: null }; }
    };
    const api = {
      select() { return api; }, eq(k, v) { st.filters.push([k, v]); return api; }, range(a, b) { st.range = [a, b]; return api; }, order(k) { st.order=k; return api; },
      update(p) { st.op = 'update'; st.payload = p; return api; }, insert(p) { st.op = 'insert'; st.payload = p; return api; },
      upsert(p, o) { st.op = 'upsert'; st.payload = p; st.opts = o; return api; }, delete() { st.op = 'delete'; return api; },
      maybeSingle: async () => { const r = await run(); return { data: r.data[0] || null, error: r.error }; },
      then: (res, rej) => run().then(res, rej),
    };
    return api;
  }
  return { from: query, tables };
}
