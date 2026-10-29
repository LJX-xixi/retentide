// Platform layer: everything the app needs from outside the page, behind window.vocabRuntime.use(name).
//   db        → Supabase document store when the learner has connected a project and signed in, else null
//               (the app then keeps progress in this browser only)
//   sample    → AI tutor with the learner's own key, else null (AI features hide themselves)
//   mcp       → Merriam-Webster with the learner's own key, else null
//   user, downloads
// Keys and settings live in this browser's localStorage under `ovd-config`; nothing is sent anywhere except the
// services the learner configured.
import { createSample } from './ai.js';
import { createMw } from './mw.js';

const CFG_KEY = 'ovd-config', ACCOUNT_KEY = 'ovd-account', PROGRESS = 'ovd-progress-v1:';
const ls = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* storage blocked */ } },
};
const readJson = (k, d) => { try { return JSON.parse(ls.get(k) || '') ?? d; } catch { return d; } };

const config = { ai: {}, mw: {}, sb: {}, ...readJson(CFG_KEY, {}) };
const account = readJson(ACCOUNT_KEY, null);       // { id, email } of the signed-in Supabase user
const hasSb = !!(config.sb?.url && config.sb?.anon);
const hasAi = !!(config.ai?.base && config.ai?.model && config.ai?.key);
const lang = window.LANG || ls.get('ovd-lang') || (/^zh/i.test(navigator.language || '') ? 'zh' : 'en');

// Supabase loads lazily and only when configured. On the way back from a sign-in link the session appears here;
// the page reloads once so the app opens that account's own progress store.
let clientP = null;
function client() {
  if (!hasSb) return Promise.resolve(null);
  return (clientP ||= import('./supabase.js').then(async (m) => {
    const c = await m.loadSupabase(config.sb);
    const { data } = await c.auth.getSession();
    const user = data?.session?.user || null;
    if ((user?.id || null) !== (account?.id || null)) {
      window.vocabRuntime.frozen = true;   // the app must not write its (old) store while we switch
      if (user) {
        // progress made before signing in moves into this account: the account's page merges it on load
        // (newest wins) and uploads it, and the anonymous copy is removed so a later account never inherits it
        const anon = ls.get(PROGRESS + 'local');
        if (anon) { ls.set('ovd-pending-merge', anon); ls.del(PROGRESS + 'local'); }
        ls.set(ACCOUNT_KEY, JSON.stringify({ id: user.id, email: user.email || '' }));
      } else ls.del(ACCOUNT_KEY);
      history.replaceState(null, '', location.pathname + location.search);
      location.reload();
      return new Promise(() => {});
    }
    return { c, m };
  }));
}

const status = (async () => ({
  ai: hasAi, model: config.ai?.model || '', mw: !!config.mw?.dict,
  storage: hasSb && account ? 'supabase' : 'local', email: account?.email || '',
}))();

const downloads = {
  save: async ({ filename, data }) => {
    const url = URL.createObjectURL(data);
    const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  },
};

let sample = null, mw = null, store = null;
window.vocabRuntime = {
  config, lang, status, account: hasSb ? account : null,
  scope: hasSb && account ? 'sb:' + account.id : 'local',
  setLang(v) { ls.set('ovd-lang', v === 'en' ? 'en' : 'zh'); },
  saveConfig(next) {
    const clean = (o) => Object.fromEntries(Object.entries(o || {}).filter(([, v]) => v));
    ls.set(CFG_KEY, JSON.stringify({ ai: clean(next.ai), mw: clean(next.mw), sb: clean(next.sb) }));
  },
  async signIn(email) {
    const x = await client(); if (!x) throw new Error('Supabase is not configured');
    const { error } = await x.c.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname } });
    if (error) throw error;
  },
  async signOut() {
    const x = await client();
    await x?.c.auth.signOut();
    ls.del(ACCOUNT_KEY);
  },
  async use(name) {
    if (name === 'db') {
      if (!hasSb) return null;
      const x = await client();
      if (!x || !account) return null;
      return (store ||= x.m.createStore(x.c));
    }
    if (name === 'sample') return hasAi ? (sample ||= createSample(config.ai)) : null;
    if (name === 'mcp') return config.mw?.dict ? (mw ||= createMw(config.mw)) : null;
    if (name === 'user') return { isOwner: async () => true, canEdit: async () => true, id: async () => (account?.id || 'local') };
    if (name === 'downloads') return downloads;
    return null;
  },
};
// pick up a session that arrived through a sign-in link even before the app asks for storage
if (hasSb) client().catch((e) => console.warn('Supabase unavailable', e));
