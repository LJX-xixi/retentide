// Merriam-Webster Collegiate Dictionary + Thesaurus, called from the browser with the learner's own keys.
// Exposed in the shape the app expects from a dictionary tool: callTool(server, 'lookup_word' | 'pronounce', input).
// Policy (docs/merriam-webster.md): the app calls this only when the learner asks for a word; nothing is
// stored beyond this page visit and nothing is forwarded to an AI model.
import { audioUrl, parseDictionary, parseThesaurus, queryVariants } from './mw-parse.js';

const MAX_UPSTREAM = 3; // spelling variants tried per lookup, to stay well inside the free daily quota

async function mwFetch(ref, word, key, signal) {
  const url = `https://www.dictionaryapi.com/api/v3/references/${ref}/json/${encodeURIComponent(word)}?key=${encodeURIComponent(key)}`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw Object.assign(new Error(`Merriam-Webster ${ref} returned HTTP ${res.status}`), { code: res.status === 403 ? 'selection_required' : 'mw_error' });
  const text = await res.text();
  try { return JSON.parse(text); } catch { throw Object.assign(new Error('Merriam-Webster did not return JSON — check the key'), { code: 'selection_required' }); }
}

export function createMw(keys) {
  async function lookupWord(word, withThesaurus = true) {
    let dict = null;
    for (const v of queryVariants(word).slice(0, MAX_UPSTREAM)) {
      const parsed = parseDictionary(await mwFetch('collegiate', v, keys.dict), word);
      if (parsed.status === 'entry') { dict = parsed; break; }
      dict ||= parsed;
    }
    const out = { ...dict, source: 'Merriam-Webster', fetchedAt: new Date().toISOString() };
    if (withThesaurus && dict.status === 'entry' && keys.thes) {
      const head = dict.entries[0].id.split(/[:~]/)[0];
      try { out.thes = parseThesaurus(await mwFetch('thesaurus', head, keys.thes), head); } catch (e) { out.thesError = String(e.message || e); }
    }
    return out;
  }
  // Audio plays straight from MW's media server (an <audio> element needs no CORS), so only the URL is returned.
  async function pronounce(word, audio) {
    let file = typeof audio === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(audio) ? audio : null;
    if (!file) {
      const variants = queryVariants(word);
      const raw = await mwFetch('collegiate', variants[0], keys.dict);
      const entries = Array.isArray(raw) ? raw.filter((e) => e && e.meta) : [];
      const exact = entries.filter((e) => variants.includes(String(e.meta.id).split(':')[0].toLowerCase()));
      for (const e of exact.length ? exact : entries) {
        const p = (e.hwi?.prs || []).find((x) => x?.sound?.audio);
        if (p) { file = p.sound.audio; break; }
      }
    }
    if (!file) throw new Error(`No Merriam-Webster recording for "${word}"`);
    return { word, file, url: audioUrl(file) };
  }
  return {
    async callTool(_server, tool, input = {}) {
      if (!keys.dict) throw Object.assign(new Error('No Merriam-Webster key'), { code: 'server_not_connected' });
      const payload = tool === 'pronounce' ? await pronounce(String(input.word || ''), input.audio) : await lookupWord(String(input.word || ''), input.thesaurus !== false);
      return { payload, structuredContent: payload };
    },
  };
}
