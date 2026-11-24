'use strict';
// AI providers. Keys live only in the main process (encrypted with the macOS Keychain via safeStorage);
// the renderer sees "has key: yes/no" and streamed text, never the key itself.
const fs = require('fs');
const path = require('path');
const { safeStorage } = require('electron');
const { spawn, execFile } = require('child_process');
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

/**
 * Flatten a chat history into one prompt for `claude -p`, which takes a single user turn.
 * Earlier turns become a transcript; the last user message stays last and unwrapped.
 */
function cliPrompt(messages) {
  const last = messages[messages.length - 1];
  const prev = messages.slice(0, -1);
  if (!prev.length) return String(last?.content ?? '');
  const turns = prev.map((m) => `<turn role="${m.role === 'assistant' ? 'assistant' : 'user'}">\n${m.content}\n</turn>`).join('\n');
  return `<conversation_so_far>\n${turns}\n</conversation_so_far>\n\n${last.content}`;
}

/**
 * claude: { bin(): path of the claude CLI, env(): environment for it }. Lets the Anthropic provider
 * work without an API key by going through the user's own Claude Code login (Pro/Max/Team/Enterprise).
 */
function createAI({ dir, getConfig, claude }) {
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
    if (p.kind === 'anthropic' && claude && authOf(id, key) === 'claude') return { ...p, id, baseURL, key: '', viaCli: true };
    if (!key && !p.noKey && !p.optionalKey) throw new Error(`No API key for ${p.name}. Add one in Settings → Models.`);
    return { ...p, id, baseURL, key };
  }
  /** Anthropic auth: 'key' or 'claude' (Claude Code login). 'auto' = the key when one is saved, else the login. */
  function authOf(id, key = getKey(id)) {
    const a = getConfig().providers?.[id]?.auth || 'auto';
    return a === 'auto' ? (key ? 'key' : 'claude') : a;
  }

  // -------- Claude Code login status (`claude auth status`), cached
  let login = null, loginAt = 0, loginP = null;
  function cliEnv() {
    const env = { ...process.env, ...(claude?.env?.() || {}) };
    delete env.ELECTRON_RUN_AS_NODE;
    for (const k of Object.keys(env)) if (/^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_AGENT_SDK)/.test(k)) delete env[k];
    delete env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_AUTH_TOKEN; // use the login, not a stray key from the shell
    return env;
  }
  function claudeLogin(force) {
    if (!claude) return Promise.resolve({ loggedIn: false, error: 'unavailable' });
    if (!force && login && Date.now() - loginAt < 60_000) return Promise.resolve(login);
    if (loginP) return loginP;
    loginP = new Promise((resolve) => {
      execFile(claude.bin(), ['auth', 'status'], { env: cliEnv(), timeout: 15000 }, (err, out) => {
        let j = null; try { j = JSON.parse(out); } catch { /* not JSON */ }
        // only what the UI needs; never the account email or org
        login = j ? { loggedIn: !!j.loggedIn, method: j.authMethod || '', plan: j.subscriptionType || j.planTier || '' }
          : { loggedIn: false, error: err?.code === 'ENOENT' ? 'Claude Code is not installed' : 'Could not read the Claude Code login' };
        loginAt = Date.now(); loginP = null; resolve(login);
      });
    });
    return loginP;
  }

  async function list(force) {
    const cfg = getConfig().providers || {};
    const cc = claude ? await claudeLogin(force) : null;
    return Object.entries(PROVIDERS).map(([id, p]) => ({
      id, name: p.name, kind: p.kind, keyUrl: p.keyUrl || '', noKey: !!p.noKey, optionalKey: !!p.optionalKey,
      hasKey: !!keys[id], baseURL: cfg[id]?.baseURL || p.baseURL, defaultBaseURL: p.baseURL,
      models: [...new Set([...(cfg[id]?.models || []), ...p.models])],
      ...(p.kind === 'anthropic' && cc ? { authPref: cfg[id]?.auth || 'auto', auth: authOf(id), claudeLogin: cc } : {}),
    }));
  }

  // -------- model discovery
  async function models(id) {
    const p = provider(id);
    let ids = [];
    if (p.viaCli) {
      ids = [...PROVIDERS.anthropic.models]; // the CLI has no model listing; it accepts any id the account can use
    } else if (p.kind === 'anthropic') {
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
      if (p.viaCli) return await chatCli(p, { model, system, messages, effort }, ctrl.signal, emit, () => text);
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

  /** One turn through `claude -p` (stream-json): no tools, no settings/MCP/session files, a neutral cwd. */
  function chatCli(p, { model, system, messages, effort }, signal, emit, soFar) {
    const cwd = path.join(dir, 'claude-cli');
    fs.mkdirSync(cwd, { recursive: true });
    const args = ['-p', '--output-format', 'stream-json', '--include-partial-messages', '--verbose', '--tools', '',
      '--no-session-persistence', '--strict-mcp-config', '--setting-sources', '', '--model', model];
    if (system) args.push('--system-prompt', system);
    if (effort && CLAUDE_EFFORT.test(model)) args.push('--effort', effort);
    return new Promise((resolve, reject) => {
      const child = spawn(claude.bin(), args, { cwd, env: cliEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
      let buf = '', err = '', result = null, stop = null, usage = null, settled = false;
      const done = (fn, v) => { if (!settled) { settled = true; signal.removeEventListener('abort', kill); fn(v); } };
      const kill = () => { child.kill('SIGTERM'); done(resolve, { text: soFar(), stop: 'aborted' }); };
      signal.addEventListener('abort', kill);
      child.on('error', (e) => done(reject, new Error(e.code === 'ENOENT' ? 'Claude Code is not installed — install it or add an Anthropic API key.' : e.message)));
      child.stderr.on('data', (d) => { err += d; });
      child.stdout.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!line) continue;
          let j; try { j = JSON.parse(line); } catch { continue; }
          if (j.type === 'stream_event') {
            const ev = j.event;
            if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') emit(ev.delta.text);
            else if (ev?.type === 'message_delta') { stop = ev.delta?.stop_reason || stop; usage = ev.usage || usage; }
          } else if (j.type === 'result') result = j;
        }
      });
      child.on('close', (code) => {
        if (signal.aborted) return;
        if (result?.is_error || (code && !soFar())) {
          const msg = (typeof result?.result === 'string' && result.result) || err.trim().split('\n').pop() || `claude exited with code ${code}`;
          return done(reject, new Error(/log ?in|auth|credential|401/i.test(msg) ? `Claude Code login: ${msg} — run \`claude auth login\` or add an API key.` : `Claude Code: ${msg}`));
        }
        if ((result?.stop_reason || stop) === 'refusal') emit('\n\n> The model declined this request.');
        done(resolve, { text: soFar(), stop: result?.stop_reason || stop || 'end_turn', usage: result?.usage || usage });
      });
      child.stdin.end(cliPrompt(messages));
    });
  }

  return { list, setKey, models, chat, abort, hasKey: (id) => !!keys[id] };
}

module.exports = { createAI, PROVIDERS, cliPrompt };
