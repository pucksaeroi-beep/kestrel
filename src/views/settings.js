// Settings sheet: General · Editor · Models & API keys · AI features · Claude Code.
import { S, set, saveSettings, command, exec } from '../state.js';
import { h, icon, clear, toast, closeMenu } from '../ui/h.js';
import { loadProviders, usable, shortModel, providerName } from '../ai/ai.js';
import { modelMenu } from '../ai/chat.js';
import { setupAutocomplete } from '../ai/inline.js';

let back = null, section = 'general';
const SECTIONS = [['general', 'General', 'settings'], ['editor', 'Editor', 'code'], ['models', 'Models & API Keys', 'key'], ['ai', 'AI Features', 'sparkle'], ['claude', 'Claude Code', 'claude']];

export function open(sec = section) {
  section = sec;
  if (!back) {
    back = h('div', { class: 'modal-back show settings-back', onmousedown: (e) => { if (e.target === back) close(); } });
    document.body.append(back);
    document.addEventListener('keydown', esc, true);
  }
  draw();
}
function close() { back?.remove(); back = null; document.removeEventListener('keydown', esc, true); }
function esc(e) { if (e.key === 'Escape' && !document.querySelector('.menu')) { e.stopPropagation(); close(); } }

function draw() {
  clear(back);
  const nav = h('div', { class: 'set-nav' }, h('div', { class: 'set-brand' }, h('img', { src: './logo.svg', alt: '' }), h('b', {}, 'Settings')),
    SECTIONS.map(([id, label, ic]) => h('button', { class: 'set-nav-item' + (section === id ? ' on' : ''), onclick: () => { section = id; draw(); } }, icon(ic), label)),
    h('div', { class: 'grow' }), h('div', { class: 'muted sm set-ver' }, `Kestrel ${S.version}`));
  const body = h('div', { class: 'set-body' });
  ({ general, editor, models, ai, claude })[section](body);
  back.append(h('div', { class: 'settings' }, nav, h('div', { class: 'set-main' }, h('button', { class: 'ibtn set-close', onclick: close }, icon('close')), body)));
}

// -------- controls
const row = (label, hint, ctl) => h('div', { class: 'set-row' }, h('div', { class: 'set-label' }, h('div', {}, label), hint ? h('div', { class: 'muted sm' }, hint) : null), h('div', { class: 'set-ctl' }, ctl));
const toggle = (k, after) => h('button', { class: 'switch' + (set(k) ? ' on' : ''), onclick: async () => { await saveSettings({ [k]: !set(k) }); after?.(); draw(); } }, h('i'));
const select = (k, opts, num) => h('select', { class: 'input', onchange: (e) => saveSettings({ [k]: num ? +e.target.value : e.target.value }) }, opts.map(([v, l]) => h('option', { value: v, selected: String(set(k)) === String(v) }, l)));
const number = (k, min, max, step = 1) => h('input', { class: 'input num', type: 'number', min, max, step, value: set(k), onchange: (e) => { const v = Math.min(max, Math.max(min, +e.target.value || set(k))); saveSettings({ [k]: v }); } });
const text = (k, ph, wide) => h('input', { class: 'input' + (wide ? ' wide' : ''), value: set(k), placeholder: ph, spellcheck: 'false', onchange: (e) => saveSettings({ [k]: e.target.value }) });
const seg = (k, opts) => h('div', { class: 'seg' }, opts.map(([v, l, ic]) => h('button', { class: set(k) === v ? 'on' : '', onclick: async () => { await saveSettings({ [k]: v }); draw(); } }, ic ? icon(ic) : null, l)));
const title = (t, sub) => [h('h2', {}, t), sub ? h('p', { class: 'muted set-sub' }, sub) : null].filter(Boolean);

function general(b) {
  b.append(...title('General'),
    row('Appearance', null, seg('theme', [['dark', 'Dark', 'moon'], ['light', 'Light', 'sun'], ['system', 'System', 'laptop']])),
    row('Auto save', 'Save files automatically', select('autoSave', [['off', 'Off'], ['afterDelay', 'After a short delay'], ['onFocusChange', 'When the editor loses focus']])),
    row('Terminal font size', null, number('terminalFontSize', 9, 24, 0.5)));
}
function editor(b) {
  b.append(...title('Editor'),
    row('Font size', null, number('fontSize', 9, 28, 0.5)),
    row('Font family', 'Leave empty for JetBrains Mono → SF Mono → Menlo', text('fontFamily', "'JetBrains Mono', Menlo", true)),
    row('Font ligatures', null, toggle('ligatures')),
    row('Tab size', null, select('tabSize', [[2, '2 spaces'], [4, '4 spaces'], [8, '8 spaces']], true)),
    row('Word wrap', null, select('wordWrap', [['off', 'Off'], ['on', 'On'], ['bounded', 'At 80 columns']])),
    row('Minimap', null, toggle('minimap')),
    row('Sticky scroll', 'Keep the enclosing function/class at the top', toggle('stickyScroll')),
    row('Show whitespace', null, select('renderWhitespace', [['none', 'Never'], ['selection', 'In selection'], ['boundary', 'Boundaries'], ['all', 'Always']])),
    row('Format on save', 'Uses the built-in formatter for JS/TS/JSON/CSS/HTML', toggle('formatOnSave')));
}

function models(b) {
  b.append(...title('Models & API Keys', 'Keys are encrypted with your macOS Keychain and stay on this Mac — they are only sent to the provider you chose.'));
  const grid = h('div', { class: 'prov-grid' });
  b.append(grid);
  for (const p of S.providers) grid.append(providerCard(p));
}

function providerCard(p) {
  const keyIn = h('input', { class: 'input', type: 'password', placeholder: p.hasKey ? '•••••••••••• saved' : p.noKey ? 'No key needed' : 'Paste API key', spellcheck: 'false', autocomplete: 'off', disabled: p.noKey });
  const urlIn = h('input', { class: 'input sm', value: p.baseURL || '', placeholder: 'Base URL, e.g. http://localhost:1234/v1', spellcheck: 'false' });
  const showUrl = p.id === 'custom' || p.id === 'ollama' || p.baseURL !== p.defaultBaseURL;
  const saveKey = async () => {
    try { await window.ks.ai.setKey(p.id, keyIn.value); keyIn.value = ''; await loadProviders(); toast(`${p.name} key saved`); draw(); } catch (e) { toast(e.message, 'error'); }
  };
  const card = h('div', { class: 'prov' + (usable(p) ? ' ready' : '') },
    h('div', { class: 'prov-head' }, h('span', { class: 'pdot' }), h('b', {}, p.name), h('span', { class: 'grow' }),
      usable(p) ? h('span', { class: 'pill ok' }, p.noKey ? 'local' : p.auth === 'claude' ? 'Claude login' : 'ready') : null,
      p.keyUrl ? h('button', { class: 'link sm', onclick: () => window.ks.shell.external(p.keyUrl) }, 'Get a key ↗') : null),
    p.claudeLogin ? anthropicAuth(p) : null,
    p.noKey || p.auth === 'claude' ? null : h('div', { class: 'prov-key' }, keyIn, h('button', { class: 'btn sm', onclick: saveKey }, 'Save'), p.hasKey ? h('button', { class: 'btn sm ghost', title: 'Remove key', onclick: async () => { await window.ks.ai.setKey(p.id, ''); await loadProviders(); draw(); } }, icon('trash')) : null),
    showUrl || p.id === 'custom' ? h('div', { class: 'prov-key' }, urlIn, h('button', { class: 'btn sm', onclick: async () => { await window.ks.ai.setProvider(p.id, { baseURL: urlIn.value.trim() }); await loadProviders(); toast('Base URL saved'); draw(); } }, 'Set URL')) : null,
    h('div', { class: 'prov-models' },
      p.models.length ? h('span', { class: 'muted sm' }, `${p.models.length} models`) : h('span', { class: 'muted sm' }, usable(p) ? 'No models loaded yet' : ''),
      usable(p) ? h('button', { class: 'link sm', onclick: async (e) => { e.currentTarget.textContent = 'Loading…'; try { await window.ks.ai.models(p.id); await loadProviders(); toast(`Loaded ${p.name} models`); } catch (err) { toast(err.message, 'error'); } draw(); } }, 'Fetch models') : null));
  keyIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveKey(); });
  return card;
}

/** Anthropic: API key, or the Claude Code login (Pro/Max/Team/Enterprise plan) through the claude CLI. */
function anthropicAuth(p) {
  const cc = p.claudeLogin;
  const pick = async (auth) => { await window.ks.ai.setProvider(p.id, { auth }); await loadProviders(); draw(); };
  const opt = (v, label, tip) => h('button', { class: p.authPref === v ? 'on' : '', title: tip, onclick: () => pick(v) }, label);
  const status = cc.loggedIn
    ? h('span', { class: 'muted sm' }, `Signed in to Claude Code${cc.plan ? ` · ${cc.plan[0].toUpperCase()}${cc.plan.slice(1)} plan` : cc.method ? ` · ${cc.method}` : ''}`)
    : h('span', { class: 'muted sm' }, cc.error || 'Not signed in to Claude Code');
  const signIn = () => {
    if (!S.ws) { toast('Open a folder first, or run `claude auth login` in Terminal'); return; }
    close(); exec('terminal.new', { command: 'claude auth login', title: 'claude login' });
    toast('Finish signing in, then reopen Settings → Models');
  };
  return h('div', { class: 'prov-auth' },
    h('div', { class: 'seg sm' }, opt('auto', 'Auto', 'API key when one is saved, otherwise the Claude Code login'), opt('key', 'API key', 'Always use the API key'), opt('claude', 'Claude login', 'Always use the Claude Code login (your Claude plan)')),
    h('div', { class: 'hrow' }, h('span', { class: 'pdot' + (cc.loggedIn ? ' on' : '') }), status, h('span', { class: 'grow' }),
      cc.loggedIn ? null : h('button', { class: 'link sm', onclick: signIn }, 'Sign in…'),
      h('button', { class: 'link sm', title: 'Check again', onclick: async () => { await loadProviders(true); draw(); } }, 'Refresh')),
    h('div', { class: 'muted sm' }, p.authPref === 'auto'
      ? (p.auth === 'claude' ? 'No API key saved — using your Claude Code login, like the claude CLI does.' : 'Using the saved API key. Remove it to use your Claude Code login.')
      : p.auth === 'claude' ? 'Requests go through the claude CLI with your plan’s usage limits. Autocomplete is slower this way.' : 'Requests use the API key below and are billed to your Console account.'));
}

const modelPick = (field, label) => {
  const pv = set(field + 'Provider'), m = set(field + 'Model');
  return h('button', { class: 'model-btn big', onclick: (e) => { modelMenu(e.currentTarget, field); const iv = setInterval(() => { if (!document.querySelector('.model-pop')) { clearInterval(iv); draw(); } }, 300); } },
    h('span', { class: 'ell' }, pv && m ? `${shortModel(m)} · ${providerName(pv)}` : label), icon('chevronDown'));
};

function ai(b) {
  b.append(...title('AI Features'),
    row('Chat model', 'Used by the chat panel (⌘L)', modelPick('chat', 'Choose…')),
    row('Thinking effort', 'Claude only — lower is faster and cheaper', select('effort', [['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high'], ['max', 'Max']])),
    row('Edit model (⌘K)', 'Also used to merge “Apply” snippets. Empty = same as chat', h('div', { class: 'hrow' }, modelPick('edit', 'Same as chat'), set('editModel') ? h('button', { class: 'btn sm ghost', onclick: async () => { await saveSettings({ editProvider: '', editModel: '' }); draw(); } }, 'Reset') : null)),
    row('Autocomplete', 'Ghost-text suggestions as you type (Tab to accept). Uses tokens on every pause.', toggle('autocomplete', setupAutocomplete)),
    row('Autocomplete model', 'Pick a fast, cheap model', modelPick('complete', 'Choose…')),
    row('Custom instructions', 'Added to every chat', h('textarea', { class: 'input area', rows: 4, placeholder: 'e.g. Answer in Thai. Prefer TypeScript and functional style.', onchange: (e) => saveSettings({ systemPrompt: e.target.value }) }, set('systemPrompt'))));
}

function claude(b) {
  b.append(...title('Claude Code', 'Kestrel speaks the same local IDE protocol as the official VS Code extension, so the real claude CLI can open diffs, read your selection and see diagnostics.'),
    row('Status', null, h('div', { class: 'hrow' }, h('span', { class: 'pill ' + (S.ide.connected ? 'ok' : '') }, S.ide.connected ? 'connected' : S.ide.port ? 'waiting' : 'off'), S.ide.port ? h('span', { class: 'muted sm' }, `port ${S.ide.port}`) : null)),
    row('Command', 'What “Launch Claude Code” runs in your login shell', text('claudeCommand', 'claude', true)),
    h('div', { class: 'set-note' }, h('b', {}, 'How it works'),
      h('ul', {},
        h('li', {}, 'Launch with ⌘Esc — it opens in the right pane and connects automatically.'),
        h('li', {}, 'When Claude edits a file you get a diff tab: Accept writes it, Reject tells Claude no. You can tweak the right side before accepting.'),
        h('li', {}, 'Your current selection is shared live; ⌥⌘K sends it as an @-mention.'),
        h('li', {}, 'Running claude in another terminal? Type /ide and choose Kestrel.'))));
}

command('settings.open', 'Preferences: Open Settings', (sec) => { closeMenu(); open(sec); });
command('settings.models', 'Preferences: Models & API Keys', () => open('models'));
