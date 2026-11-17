// Cloudflare Worker: a small proxy between the portfolio's AI agent and Google Gemini.
// The Gemini key lives in the Worker as a secret (GEMINI_API_KEY) and never reaches the browser.
//
// Settings (Worker → Settings → Variables and Secrets):
//   GEMINI_API_KEY   secret, from https://aistudio.google.com/apikey   (required)
//   ALLOWED_ORIGINS  comma-separated sites allowed to call this proxy  (optional)
//   MODEL            Gemini model id                                   (optional)

const DEFAULT_ORIGINS = 'https://anandaparna126.github.io';
const DEFAULT_MODEL = 'gemini-flash-latest';
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

    const upstream = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.GEMINI_API_KEY}` },
      body: JSON.stringify({
        model: env.MODEL || DEFAULT_MODEL,
        messages: body.messages,
        tools: Array.isArray(body.tools) ? body.tools.slice(0, 12) : undefined,
        tool_choice: body.tools ? 'auto' : undefined,
        temperature: typeof body.temperature === 'number' ? Math.min(1, Math.max(0, body.temperature)) : 0.4,
        max_tokens: 700
      })
    });
    const text = await upstream.text();
    return new Response(text, { status: upstream.status, headers: { ...cors, 'Content-Type': 'application/json' } });
  }
};
