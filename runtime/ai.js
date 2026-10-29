// AI tutor with the learner's own key: any chat-completions endpoint that speaks the OpenAI format and
// accepts browser requests (CORS). Exposed as the `sample` capability the app calls:
//   sample(input, { onText, signal, tools, images, json, modelTier }) -> { text, truncated }
//   sample.json(prompt, opts) -> parsed JSON value
// Streams with server-sent events and runs up to six rounds of tool calls (the app's word-bank tool).

export async function* sseEvents(body) {
  const reader = body.getReader(), decoder = new TextDecoder();
  let pending = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      pending += decoder.decode(value || new Uint8Array(), { stream: !done }).replace(/\r/g, '');
      let end;
      while ((end = pending.indexOf('\n\n')) >= 0) {
        const event = pending.slice(0, end); pending = pending.slice(end + 2);
        const data = event.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
        if (data === '[DONE]') return;
        if (data) yield JSON.parse(data);
      }
      if (done) { if (pending.trim()) throw new Error('stream_interrupted'); break; }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

const fileData = (file) => new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = reject; r.readAsDataURL(file); });

export function createSample({ base, model, key }) {
  const url = base.replace(/\/+$/, '') + '/chat/completions';
  async function request(body, signal) {
    let res;
    try {
      res = await fetch(url, { method: 'POST', signal, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
    } catch (e) {
      if (signal?.aborted) throw e;
      // a network-level failure here is almost always CORS: the provider does not accept browser requests
      throw Object.assign(new Error('Could not reach the AI endpoint from the browser (network or CORS). Check the URL, or use a provider that allows browser requests.'), { code: 'network' });
    }
    if (!res.ok) {
      const x = await res.json().catch(() => ({}));
      const code = res.status === 401 || res.status === 403 ? 'not_granted' : res.status === 429 ? 'rate_limited' : 'ai_error';
      throw Object.assign(new Error(x.error?.message || `AI endpoint returned HTTP ${res.status}`), { code });
    }
    return res;
  }
  async function sample(input, opts = {}) {
    const messages = typeof input === 'string' ? [{ role: 'user', content: input }] : structuredClone(input);
    if (opts.images?.length) {
      const last = messages[messages.length - 1];
      last.content = [{ type: 'text', text: last.content }, ...await Promise.all(opts.images.slice(0, 3).map(async (f) => ({ type: 'image_url', image_url: { url: await fileData(f) } })))];
    }
    const tools = (opts.tools || []).map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema || { type: 'object', properties: {} } } }));
    let text = '', truncated = false;
    try {
      for (let round = 0; round < 6; round++) {
        const body = { model, messages, stream: true, ...(tools.length ? { tools } : {}), ...(opts.json ? { response_format: { type: 'json_object' } } : {}) };
        const res = await request(body, opts.signal);
        let content = '', finish = null;
        const calls = [];
        for await (const event of sseEvents(res.body)) {
          if (event.error) throw new Error(event.error.message || 'stream error');
          const choice = event.choices?.[0]; if (!choice) continue;
          if (choice.finish_reason) finish = choice.finish_reason;
          const d = choice.delta || {};
          if (d.content) { content += d.content; text += d.content; opts.onText?.({ text, delta: d.content }); }
          for (const c of d.tool_calls || []) {
            const t = calls[c.index ?? 0] ||= { id: '', type: 'function', function: { name: '', arguments: '' } };
            if (c.id) t.id = c.id; if (c.function?.name) t.function.name += c.function.name; if (c.function?.arguments) t.function.arguments += c.function.arguments;
          }
        }
        truncated = finish === 'length';
        if (!calls.length) {
          if (!text.trim()) throw new Error('The model returned no text; try again.');
          return { text, truncated, modelTierApplied: opts.modelTier || 'default' };
        }
        messages.push({ role: 'assistant', content: content || null, tool_calls: calls });
        for (const call of calls) {
          if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
          const tool = opts.tools?.find((t) => t.name === call.function.name);
          let result;
          try { if (!tool) throw new Error('unknown tool'); result = await tool.execute(JSON.parse(call.function.arguments || '{}'), { signal: opts.signal }); }
          catch (e) { if (opts.signal?.aborted) throw e; result = { error: e.message || 'tool failed' }; }
          messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result).slice(0, 25000) });
        }
      }
      throw new Error('Too many tool rounds; narrow the question and try again.');
    } catch (e) {
      throw Object.assign(new Error(e.message || 'AI request failed'), { code: opts.signal?.aborted ? 'cancelled' : e.code || 'ai_error', text });
    }
  }
  sample.json = async (prompt, opts = {}) => {
    const r = await sample([{ role: 'system', content: 'Return a JSON object with one key "result" containing exactly the JSON value requested by the user (object or array). No markdown or commentary.' }, { role: 'user', content: prompt }], { ...opts, json: true });
    if (r.truncated) throw Object.assign(new Error('The answer was cut off; ask for fewer items.'), { code: 'output_truncated', text: r.text });
    try {
      const x = JSON.parse(r.text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
      if (x !== null && typeof x === 'object') return Object.hasOwn(x, 'result') ? x.result : x;
      throw new Error('not an object');
    } catch {
      throw Object.assign(new Error('The AI did not return valid JSON; try again.'), { code: 'invalid_json', text: r.text });
    }
  };
  sample.limits = async () => ({ maxPromptBytes: 262144, tools: { maxCount: 4 }, images: { maxCount: 3, maxInputBytes: 8e6, mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] } });
  return sample;
}
