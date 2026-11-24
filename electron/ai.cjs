'use strict';
// AI providers. Keys live only in the main process (encrypted with the macOS Keychain via safeStorage);
// the renderer sees "has key: yes/no" and streamed text, never the key itself.
const fs = require('fs');
const path = require('path');
const { safeStorage } = require('electron');
const { sseParser, deltaText } = require('./sse.cjs');

const PROVIDERS = {
  anthropic: { name: 'Anthropic', kind: 'anthropic', baseURL: 'https://api.anthropic.com', keyUrl: 'https://console.anthropic.com/settings/keys',
    models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-2'] },
  openai: { name: 'OpenAI', kind: 'openai', baseURL: 'https://api.openai.com/v1', keyUrl: 'https://platform.openai.com/api-keys', models: [] },
  gemini: { name: 'Google Gemini', kind: 'gemini', baseURL: 'https://generativelanguage.googleapis.com/v1beta', keyUrl: 'https://aistudio.google.com/apikey', models: [] },
  openrouter: { name: 'OpenRouter', kind: 'openai', baseURL: 'https://openrouter.ai/api/v1', keyUrl: 'https://openrouter.ai/keys', models: [] },
  groq: { name: 'Groq', kind: 'openai', baseURL: 'https://api.groq.com/openai/v1', keyUrl: 'https://console.groq.com/keys', models: [] },
  deepseek: { name: 'DeepSeek', kind: 'openai', baseURL: 'https://api.deepseek.com/v1', keyUrl: 'https://platform.deepseek.com/api_keys', models: ['deepseek-chat', 'deepseek-reasoner'] },
  mistral: { name: 'Mistral', kind: 'openai', baseURL: 'https://api.mistral.ai/v1', keyUrl: 'https://console.mistral.ai/api-keys', models: [] },
  xai: { name: 'xAI', kind: 'openai', baseURL: 'https://api.x.ai/v1', keyUrl: 'https://console.x.ai', models: [] },
  ollama: { name: 'Ollama (local)', kind: 'openai', baseURL: 'http://localhost:11434/v1', noKey: true, models: [] },
  custom: { name: 'OpenAI-compatible', kind: 'openai', baseURL: '', optionalKey: true, models: [] },
};

// Claude models that accept output_config.effort and server-side refusal fallbacks.
const CLAUDE_EFFORT = /^claude-(opus|sonnet|haiku|fable|mythos)-(5|4-[678])/;
const CLAUDE_FALLBACK = /^claude-(fable-5-[12]|opus-5|opus-5-5|sonnet-5-5|mythos-5-[12])$/;

function createAI({ dir, getConfig }) {
  const KEYS = path.join(dir, 'keys.json');
  let keys = {};
  try { keys = JSON.parse(fs.readFileSync(KEYS, 'utf8')); } catch { keys = {}; }
  const saveKeys = () => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(KEYS, JSON.stringify(keys), { mode: 0o600 }); };

  function getKey(id) {
    const enc = keys[id];
    if (!enc) return '';
    try { return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(enc, 'base64')) : ''; } catch { return ''; }
  }
  function setKey(id, key) {
    if (!PROVIDERS[id]) throw new Error('Unknown provider');
    if (!key) { delete keys[id]; saveKeys(); return; }
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Keychain encryption is not available');
    keys[id] = safeStorage.encryptString(String(key).trim()).toString('base64');
    saveKeys();
  }

  function provider(id) {
    const p = PROVIDERS[id];
    if (!p) throw new Error('Unknown provider ' + id);
    const over = getConfig().providers?.[id] || {};
    const baseURL = (over.baseURL || p.baseURL || '').replace(/\/+$/, '');
    if (!baseURL) throw new Error(`${p.name}: set a base URL in Settings → Models`);
    const key = getKey(id);
    if (!key && !p.noKey && !p.optionalKey) throw new Error(`No API key for ${p.name}. Add one in Settings → Models.`);
    return { ...p, id, baseURL, key };
  }

  function list() {
    const cfg = getConfig().providers || {};
    return Object.entries(PROVIDERS).map(([id, p]) => ({
      id, name: p.name, kind: p.kind, keyUrl: p.keyUrl || '', noKey: !!p.noKey, optionalKey: !!p.optionalKey,
      hasKey: !!keys[id], baseURL: cfg[id]?.baseURL || p.baseURL, defaultBaseURL: p.baseURL,
      models: [...new Set([...(cfg[id]?.models || []), ...p.models])],
    }));
  }

  // -------- model discovery
  async function models(id) {
    const p = provider(id);
    let ids = [];
    if (p.kind === 'anthropic') {
      const c = anthropicClient(p);
      for await (const m of c.models.list({ limit: 100 })) ids.push(m.id);
    } else if (p.kind === 'gemini') {
      const r = await fetch(`${p.baseURL}/models?pageSize=200`, { headers: { 'x-goog-api-key': p.key } });
      if (!r.ok) throw new Error(`${p.name}: ${r.status} ${await r.text()}`);
      ids = ((await r.json()).models || []).filter((m) => (m.supportedGenerationMethods || []).includes('generateContent')).map((m) => m.name.replace(/^models\//, ''));
    } else {
      const r = await fetch(`${p.baseURL}/models`, { headers: p.key ? { Authorization: `Bearer ${p.key}` } : {} });
      if (!r.ok) throw new Error(`${p.name}: ${r.status} ${(await r.text()).slice(0, 300)}`);
      const j = await r.json();
      ids = (j.data || j.models || []).map((m) => m.id || m.name).filter(Boolean);
    }
    ids.sort();
    return ids;
  }

  function anthropicClient(p) {
    const Anthropic = require('@anthropic-ai/sdk').default;
    return new Anthropic({ apiKey: p.key, baseURL: p.baseURL, maxRetries: 1 });
  }

  // -------- streaming chat: onDelta(text) per chunk; resolves { text, stop, usage }
  const running = new Map();

  async function chat(reqId, { provider: pid, model, system, messages, maxTokens, effort }, onDelta) {
    const p = provider(pid);
    if (!model) throw new Error('Choose a model first');
    const ctrl = new AbortController();
    running.set(reqId, ctrl);
    let text = '';
    const emit = (t) => { if (t) { text += t; onDelta(t); } };
    try {
      if (p.kind === 'anthropic') {
        const c = anthropicClient(p);
        const body = { model, max_tokens: maxTokens || 32000, messages: messages.map((m) => ({ role: m.role, content: m.content })) };
        if (system) body.system = system;
        if (CLAUDE_EFFORT.test(model) && effort) body.output_config = { effort };
        if (CLAUDE_FALLBACK.test(model)) { body.betas = ['server-side-fallback-2026-07-01']; body.fallbacks = 'default'; }
        const stream = c.beta.messages.stream(body, { signal: ctrl.signal });
        for await (const ev of stream) {
          if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') emit(ev.delta.text);
        }
        const msg = await stream.finalMessage();
        if (msg.stop_reason === 'refusal') emit('\n\n> The model declined this request' + (msg.stop_details?.category ? ` (${msg.stop_details.category})` : '') + '.');
        return { text, stop: msg.stop_reason, usage: msg.usage };
      }
      let url, headers, body;
      if (p.kind === 'gemini') {
        url = `${p.baseURL}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
        headers = { 'content-type': 'application/json', 'x-goog-api-key': p.key };
        body = { contents: messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })) };
        if (system) body.systemInstruction = { parts: [{ text: system }] };
        if (maxTokens) body.generationConfig = { maxOutputTokens: maxTokens };
      } else {
        url = `${p.baseURL}/chat/completions`;
        headers = { 'content-type': 'application/json', ...(p.key ? { Authorization: `Bearer ${p.key}` } : {}) };
        if (pid === 'openrouter') Object.assign(headers, { 'X-Title': 'Kestrel' });
        body = { model, stream: true, messages: [...(system ? [{ role: 'system', content: system }] : []), ...messages] };
        if (maxTokens && maxTokens < 4096) body.max_tokens = maxTokens; // only for short completions; long chats use the model default
      }
      const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal });
      if (!r.ok) throw new Error(`${p.name} ${r.status}: ${(await r.text()).slice(0, 600)}`);
      const parser = sseParser();
      const dec = new TextDecoder();
      for await (const chunk of r.body) {
        for (const data of parser.feed(dec.decode(chunk, { stream: true }))) {
          if (data === '[DONE]') continue;
          let j; try { j = JSON.parse(data); } catch { continue; }
          if (j.error) throw new Error(`${p.name}: ${j.error.message || JSON.stringify(j.error)}`);
          emit(deltaText(p.kind, j));
        }
      }
      return { text, stop: 'end_turn' };
    } catch (e) {
      if (ctrl.signal.aborted) return { text, stop: 'aborted' };
      throw e;
    } finally { running.delete(reqId); }
  }

  function abort(reqId) { running.get(reqId)?.abort(); }

  return { list, setKey, models, chat, abort, hasKey: (id) => !!keys[id] };
}

module.exports = { createAI, PROVIDERS };
