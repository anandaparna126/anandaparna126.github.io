// Cloudflare Worker: a small proxy between the portfolio's AI agent and Google Gemini.
// The Gemini key lives in the Worker as a secret (GEMINI_API_KEY) and never reaches the browser.
//
// Settings (Worker → Settings → Variables and Secrets):
//   GEMINI_API_KEY   secret, from https://aistudio.google.com/apikey   (required)
//   ALLOWED_ORIGINS  comma-separated sites allowed to call this proxy  (optional)
//   MODEL            Gemini model id                                   (optional)

const DEFAULT_ORIGINS = 'https://anandaparna126.github.io,https://aparnaanand.tech,https://www.aparnaanand.tech';
const DEFAULT_MODEL = 'gemini-flash-latest';
// tried in order when a model is busy (503), rate-limited (429) or not available (404)
const FALLBACK_MODELS = ['gemini-flash-lite-latest', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash'];
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
const MAX_BODY = 40_000;          // bytes
const MAX_MESSAGES = 30;
const PER_MINUTE = 8;             // replies per visitor per minute (best effort, per Worker instance)

const hits = new Map();

const tooMany = ip => {
  const now = Date.now(), list = (hits.get(ip) || []).filter(t => now - t < 60_000);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > PER_MINUTE;
};

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || DEFAULT_ORIGINS).split(',').map(s => s.trim());
    const cors = {
      'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : allowed[0],
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin'
    };
    const reply = (status, data) => new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return reply(405, { error: 'POST only' });
    if (!allowed.includes(origin)) return reply(403, { error: 'origin not allowed' });
    if (!env.GEMINI_API_KEY) return reply(500, { error: 'GEMINI_API_KEY is not set' });
    if (tooMany(request.headers.get('CF-Connecting-IP') || 'unknown')) return reply(429, { error: 'Too many messages. Please wait a minute.' });

    const raw = await request.text();
    if (raw.length > MAX_BODY) return reply(413, { error: 'message too long' });
    let body;
    try { body = JSON.parse(raw); } catch (e) { return reply(400, { error: 'bad JSON' }); }
    if (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > MAX_MESSAGES) return reply(400, { error: 'bad messages' });

    const models = [env.MODEL || DEFAULT_MODEL, ...FALLBACK_MODELS.filter(m => m !== (env.MODEL || DEFAULT_MODEL))];
    let status = 502, text = JSON.stringify({ error: 'no model answered' });
    for (const model of models) {
      // give each model 12 s; a stuck model moves us on to the next one
      const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 12_000);
      let upstream;
      try {
        upstream = await fetch(GEMINI_URL, {
        signal: ctrl.signal,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.GEMINI_API_KEY}` },
        body: JSON.stringify({
          model,
          messages: body.messages,
          tools: Array.isArray(body.tools) && body.tools.length ? body.tools.slice(0, 12) : undefined,
          tool_choice: Array.isArray(body.tools) && body.tools.length ? 'auto' : undefined,
          temperature: typeof body.temperature === 'number' ? Math.min(1, Math.max(0, body.temperature)) : 0.4,
          max_tokens: 700
        })
        });
      } catch (e) {
        status = 504; text = JSON.stringify({ error: `${model} timed out` });
        continue;
      } finally { clearTimeout(timer); }
      status = upstream.status;
      text = await upstream.text();
      if (![404, 429, 500, 503].includes(status)) break;   // success, or an error another model won't fix
    }
    return new Response(text, { status, headers: { ...cors, 'Content-Type': 'application/json' } });
  }
};
