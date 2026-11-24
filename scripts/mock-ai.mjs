// A fake AI provider for tests and screenshots — speaks the Anthropic Messages and OpenAI Chat streaming formats
// with canned replies. No real model is called.   node scripts/mock-ai.mjs [port]
import http from 'node:http';

const port = Number(process.argv[2] || process.env.MOCK_PORT || 8787);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CHAT = `Here's what **\`summary()\`** does and one thing worth fixing.

1. It looks up the forecast for a city and formats it as a short sentence.
2. Temperatures are rounded with \`Math.round\`, so \`91.4\` becomes \`91°\`.
3. The unit is never shown — a Fahrenheit forecast reads like Celsius.

Pass the unit through and print it:

\`\`\`ts src/forecast.ts
export function summary(f: Forecast, unit: Unit = 'C') {
  return \`\${f.city}: \${Math.round(f.temp)}°\${unit} and \${f.sky}, humidity \${f.humidity}%\`;
}
\`\`\`

Then call \`summary(data, unit)\` in \`src/server.ts\`.`;

function reply(system = '', last = '') {
  if (/merge a proposed code change/i.test(system)) {
    const file = /<file[^>]*>\n([\s\S]*?)\n<\/file>/.exec(last)?.[1] || '';
    return file.replace(/export function summary\(f: Forecast\) \{\n[^\n]*\n\}/, "export function summary(f: Forecast, unit: Unit = 'C') {\n  return `${f.city}: ${Math.round(f.temp)}°${unit} and ${f.sky}, humidity ${f.humidity}%`;\n}");
  }
  if (/rewrite a selected region/i.test(system)) {
    const sel = /<<<SELECTION_START>>>([\s\S]*?)<<<SELECTION_END>>>/.exec(last)?.[1] || '';
    if (/cached/.test(sel)) return "export function cached<T>(key: string, ttlMs: number, fn: () => T): T {\n  const now = Date.now();\n  const hit = store.get(key);\n  if (hit && hit.until > now) return hit.value as T;\n  // evict expired entries so the map can't grow forever\n  for (const [k, v] of store) if (v.until <= now) store.delete(k);\n  const value = fn();\n  store.set(key, { value, until: now + ttlMs });\n  return value;\n}\n";
    return sel.toUpperCase();
  }
  if (/code completion engine/i.test(system)) return "export const knots = (ms: number) => ms * 1.944;";
  return CHAT;
}

function body(req) { return new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch { r({}); } }); }); }
const lastUser = (msgs = []) => { const m = [...msgs].reverse().find((x) => x.role === 'user'); return typeof m?.content === 'string' ? m.content : (m?.content || []).map((p) => p.text || '').join(''); };
const chunks = (t) => t.match(/[\s\S]{1,14}/g) || [];

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && /\/models$/.test(url.pathname)) {
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ data: [{ id: 'claude-opus-5-5', type: 'model' }, { id: 'claude-sonnet-5-5', type: 'model' }, { id: 'claude-haiku-5-5', type: 'model' }], has_more: false }));
  }
  const b = await body(req);
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const send = (o, ev) => res.write((ev ? `event: ${ev}\n` : '') + `data: ${typeof o === 'string' ? o : JSON.stringify(o)}\n\n`);
  const sys = typeof b.system === 'string' ? b.system : (b.system || []).map?.((x) => x.text).join('') || (b.messages || []).find((m) => m.role === 'system')?.content || '';
  const text = reply(sys, lastUser(b.messages));
  const delay = /completion engine/.test(sys) ? 0 : 18;
  if (url.pathname.endsWith('/v1/messages')) {
    send({ type: 'message_start', message: { id: 'msg_mock', type: 'message', role: 'assistant', model: b.model, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } }, 'message_start');
    send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, 'content_block_start');
    for (const c of chunks(text)) { send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: c } }, 'content_block_delta'); await sleep(delay); }
    send({ type: 'content_block_stop', index: 0 }, 'content_block_stop');
    send({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 42 } }, 'message_delta');
    send({ type: 'message_stop' }, 'message_stop');
  } else {
    for (const c of chunks(text)) { send({ choices: [{ delta: { content: c } }] }); await sleep(delay); }
    send('[DONE]');
  }
  res.end();
}).listen(port, '127.0.0.1', () => console.log(`mock AI on http://127.0.0.1:${port}`));
