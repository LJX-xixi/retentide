// Merriam-Webster Collegiate + Thesaurus JSON -> compact, cleaned entries.
// Lessons from the February parser: read every homograph (list:1 … list:9, the sense a test usually wants of
// "list" is list:4), every sense including sdsense / pseq / bs, keep labels so archaic senses can
// be folded, read dros (phrases) and uros (run-on derived words), and never stop at shortdef.

const AUDIO_BASE = 'https://media.merriam-webster.com/audio/prons/en/us/mp3/';
const MAX_ENTRIES = 10;
const MAX_SENSES = 40;

export function cleanText(s) {
  if (!s) return '';
  let t = String(s)
    .replace(/\{dx_def\}.*?\{\/dx_def\}/gs, '')
    .replace(/\{dx\}.*?\{\/dx\}/gs, '')
    .replace(/\{ma\}.*?\{\/ma\}/gs, '')
    .replace(/\{bc\}/g, ': ')
    .replace(/\{ldquo\}/g, '“').replace(/\{rdquo\}/g, '”')
    .replace(/\{(?:sx|a_link|d_link|i_link|et_link|mat|dxt)\|([^|}]*)[^}]*\}/g, '$1')
    .replace(/\{[^}]*\}/g, '');
  t = t.replace(/\s+/g, ' ').replace(/\s+([,.;:)])/g, '$1').replace(/:\s*:/g, ':').trim();
  return t.replace(/^[:\s]+/, '').replace(/[:\s]+$/, '');
}

const norm = (s) => String(s || '').toLowerCase().replace(/\*/g, '').replace(/[’']/g, "'").replace(/\s+/g, ' ').trim();
const baseId = (id) => norm(String(id || '').split(':')[0]);

export function audioUrl(file) {
  if (!file) return null;
  const sub = file.startsWith('bix') ? 'bix' : file.startsWith('gg') ? 'gg' : /^[^a-z]/i.test(file) ? 'number' : file[0];
  return `${AUDIO_BASE}${sub}/${file}.mp3`;
}

function labelsOf(node) {
  const out = [];
  for (const lb of node?.lbs || []) if (typeof lb === 'string') out.push(lb);
  for (const sl of node?.sls || []) if (typeof sl === 'string') out.push(sl);
  if (node?.sgram) out.push(node.sgram);
  return out;
}
const isArchaic = (labels) => labels.some((l) => /archaic|obsolete|dialect/i.test(l));

// dt = [["text", "..."], ["vis", [{t}]], ["uns", [[["text", ...], ["vis", ...]]]], ["snote", ...], ...]
function readDt(dt) {
  const def = [], ex = [], notes = [];
  for (const item of dt || []) {
    if (!Array.isArray(item)) continue;
    const [type, val] = item;
    if (type === 'text') def.push(cleanText(val));
    else if (type === 'vis') for (const v of val || []) { const t = cleanText(v?.t); if (t) ex.push(t); }
    else if (type === 'uns') {
      for (const group of val || []) {
        const inner = readDt(group);
        if (inner.def) notes.push(inner.def);
        ex.push(...inner.ex);
      }
    } else if (type === 'snote') {
      for (const part of val || []) if (part?.[0] === 't') notes.push(cleanText(part[1]));
    }
  }
  return { def: def.filter(Boolean).join('; '), ex, notes };
}

// sense numbers come in pieces ("1 a", then "b", then "(2)"); rebuild the full label
function snTracker() {
  let num = '', letter = '', paren = '';
  return (sn) => {
    if (!sn) return [num, letter, paren].filter(Boolean).join(' ');
    for (const tok of String(sn).split(/\s+/)) {
      if (/^\d+$/.test(tok)) { num = tok; letter = ''; paren = ''; }
      else if (/^[a-z]$/.test(tok)) { letter = tok; paren = ''; }
      else if (/^\(\d+\)$/.test(tok)) paren = tok;
    }
    return [num, letter, paren].filter(Boolean).join(' ');
  };
}

function readSseq(sseq, entryId, inherited = [], vd = '') {
  const senses = [];
  const track = snTracker();
  let senLabels = [];
  const add = (payload) => {
    if (senses.length >= MAX_SENSES) return;
    const { def, ex, notes } = readDt(payload.dt);
    const labels = [...inherited, ...senLabels, ...labelsOf(payload)];
    const sense = { sid: `${entryId}#${senses.length + 1}`, sn: track(payload.sn), def, ex: ex.slice(0, 3) };
    if (vd) sense.vd = vd;
    if (labels.length) sense.lbs = [...new Set(labels)];
    if (isArchaic(labels)) sense.archaic = true;
    if (notes.length) sense.note = notes.join(' ');
    if (payload.sdsense) {
      const sd = readDt(payload.sdsense.dt);
      if (sd.def) sense.sub = { sd: payload.sdsense.sd || '', def: sd.def, ex: sd.ex.slice(0, 2) };
    }
    if (def || sense.sub) senses.push(sense);
  };
  const walk = (node) => {
    if (!Array.isArray(node)) return;
    if (typeof node[0] === 'string' && node.length === 2) {
      const [tag, payload] = node;
      if (tag === 'sense') add(payload);
      else if (tag === 'sen') { track(payload?.sn); senLabels = labelsOf(payload); }
      else if (tag === 'bs') add(payload?.sense || {});
      else if (tag === 'pseq') walk(payload);
      return;
    }
    for (const child of node) walk(child);
  };
  for (const seq of sseq || []) { senLabels = []; walk(seq); }
  return senses;
}

function readDef(defBlocks, entryId, inherited = []) {
  const out = [];
  for (const block of defBlocks || []) {
    out.push(...readSseq(block?.sseq, entryId, inherited, block?.vd || '').map((s, i) => ({ ...s, sid: `${entryId}#${out.length + i + 1}` })));
  }
  return out;
}

function parseEntry(e) {
  const id = e.meta?.id || '';
  const prs = e.hwi?.prs?.[0];
  const entry = {
    id,
    hw: cleanText(e.hwi?.hw || id).replace(/\*/g, ''),
    fl: e.fl || (e.cxs ? 'cross-reference' : ''),
    senses: readDef(e.def, id, labelsOf(e)),
  };
  if (e.hom) entry.hom = e.hom;
  if (prs?.mw) entry.prs = prs.mw;
  const audio = (e.hwi?.prs || []).map((p) => p?.sound?.audio).find(Boolean);
  if (audio) entry.audio = audioUrl(audio);
  // every pronunciation variant of this homograph (e.g. "ˌe-kə-ˈnä-mik, ˌē-"), each with its recording
  const variants = (e.hwi?.prs || []).filter((p) => p?.mw).slice(0, 4).map((p) => ({ mw: p.mw, ...(p.sound?.audio ? { au: p.sound.audio } : {}), ...(p.l ? { l: cleanText(p.l) } : {}) }));
  if (variants.length > 1) entry.prsAll = variants;
  const lbs = labelsOf(e);
  if (lbs.length) entry.lbs = lbs;
  if (e.cxs?.length) entry.see = e.cxs.map((c) => [c.cxl, ...(c.cxtis || []).map((x) => x.cxt)].filter(Boolean).join(' ')).join('; ');
  const et = (e.et || []).filter((x) => x[0] === 'text').map((x) => cleanText(x[1])).join(' ');
  if (et) entry.et = et;
  if (e.uros?.length) entry.uros = e.uros.map((u) => ({ w: cleanText(u.ure).replace(/\*/g, ''), fl: u.fl || '' }));
  if (e.dros?.length) entry.dros = e.dros.slice(0, 12).map((d) => ({ phrase: cleanText(d.drp), senses: readDef(d.def, `${id}~${cleanText(d.drp)}`) }));
  return entry;
}

// "give way to" / "stave something off" / "take something for granted" -> forms MW is likely to list
export function queryVariants(word) {
  const w = norm(word);
  const out = [w];
  const noFiller = norm(w.replace(/\b(something|someone|somebody|sth\.?|sb\.?|one's|oneself)\b/g, ' '));
  if (noFiller && noFiller !== w) out.push(noFiller);
  for (const v of [...out]) {
    const trimmed = v.replace(/\s+(to|of|with|from|for|on|at|in|into|by|about|up|out)$/, '');
    if (trimmed !== v && trimmed.includes(' ')) out.push(trimmed);
  }
  return [...new Set(out)];
}

function matchEntries(raw, variants) {
  const entries = raw.filter((x) => x && typeof x === 'object' && x.meta);
  const exact = entries.filter((e) => variants.includes(baseId(e.meta.id)));
  if (exact.length) return { list: exact, how: 'exact' };
  const viaStem = entries.filter((e) => (e.meta.stems || []).some((s) => variants.includes(norm(s))) && !String(e.meta.id).includes(' '));
  if (viaStem.length) return { list: viaStem, how: 'stem' };
  return { list: [], how: 'none' };
}

// Phrases often live inside another entry's dros ("take for granted" under "grant").
function findDros(raw, variants) {
  const hits = [];
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue;
    for (const d of e.dros || []) {
      if (variants.includes(norm(cleanText(d.drp)))) hits.push({ id: `${e.meta.id}~${cleanText(d.drp)}`, hw: cleanText(d.drp), fl: 'phrase', senses: readDef(d.def, `${e.meta.id}~${cleanText(d.drp)}`) });
    }
  }
  return hits;
}

export function parseDictionary(raw, query) {
  if (!Array.isArray(raw) || !raw.length) return { q: query, status: 'not_found', entries: [] };
  if (typeof raw[0] === 'string') return { q: query, status: 'suggestions', suggestions: raw.slice(0, 12), entries: [] };
  const variants = queryVariants(query);
  const { list, how } = matchEntries(raw, variants);
  let entries = list.slice(0, MAX_ENTRIES).map(parseEntry);
  let match = how;
  if (!entries.length) {
    entries = findDros(raw, variants);
    match = entries.length ? 'phrase' : 'none';
  }
  if (!entries.length) {
    return { q: query, status: 'related', related: raw.filter((x) => x?.meta).slice(0, 8).map((e) => e.meta.id), entries: [] };
  }
  return { q: query, status: 'entry', match, entries };
}

export function parseThesaurus(raw, query) {
  if (!Array.isArray(raw) || !raw.length || typeof raw[0] === 'string') return [];
  const variants = queryVariants(query);
  const words = (lists) => [...new Set((lists || []).flat().map((x) => x?.wd).filter(Boolean))];
  const out = [];
  for (const e of raw) {
    if (!e?.meta || !variants.includes(baseId(e.meta.id))) continue;
    const senses = [];
    const walk = (node) => {
      if (!Array.isArray(node)) return;
      if (node[0] === 'sense' && node[1] && typeof node[1] === 'object') {
        const s = node[1];
        const { def, ex } = readDt(s.dt);
        senses.push({ def, ex: ex.slice(0, 1), syn: words(s.syn_list), rel: words(s.rel_list).slice(0, 12), near: words(s.near_list).slice(0, 8), ant: words(s.ant_list) });
        return;
      }
      for (const c of node) walk(c);
    };
    for (const d of e.def || []) walk(d.sseq);
    out.push({ id: e.meta.id, fl: e.fl || '', senses });
  }
  return out.slice(0, MAX_ENTRIES);
}
