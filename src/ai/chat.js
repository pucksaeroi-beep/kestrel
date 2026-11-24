// AI chat panel: conversations per workspace, file/selection context, streaming Markdown, Apply-as-diff.
import { S, set, saveSettings, on, emit, command, exec, basename } from '../state.js';
import { h, icon, clear, toast, uid, popupMenu, popover, fmtRelative, closeMenu } from '../ui/h.js';
import { render as renderMd } from '../lib/markdown.js';
import { badgeOf, languageOf } from '../lib/lang.js';
import * as E from '../editor/editors.js';
import { stream, chatTarget, editTarget, usable, providerName, shortModel, SYSTEM_CHAT, SYSTEM_APPLY, unfence, loadProviders } from './ai.js';

let host, scroller, composer, input, chipsEl, modelBtn, sendBtn;
let chat = null;            // { id, title, messages:[{role, content, context, error}], updated }
let pending = [];           // context chips for the next message: [{type:'file'|'selection', path, text, lines}]
let autoFile = true;        // attach the active file automatically
let running = null;         // current stream handle
const MAX_CTX = 400_000;    // characters of attached context per message

const key = () => 'kestrel.chats:' + (S.ws?.root || '');
function loadAll() { try { return JSON.parse(localStorage.getItem(key()) || '[]'); } catch { return []; } }
function saveAll(list) { try { localStorage.setItem(key(), JSON.stringify(list.slice(0, 40))); } catch { /* quota */ } }
function persist() {
  if (!chat || !chat.messages.length) return;
  chat.updated = Date.now();
  const list = loadAll().filter((c) => c.id !== chat.id);
  saveAll([chat, ...list]);
}

export function mount(el) {
  host = el;
  scroller = h('div', { class: 'chat-scroll' });
  chipsEl = h('div', { class: 'chips' });
  input = h('textarea', { class: 'chat-input', rows: 1, placeholder: 'Ask anything — @ to add files, ⌘⏎ to send', spellcheck: 'false',
    oninput: autosize, onkeydown: onKey });
  modelBtn = h('button', { class: 'model-btn', onclick: (e) => modelMenu(e.currentTarget) });
  sendBtn = h('button', { class: 'send-btn', title: 'Send (↵)', onclick: () => (running ? stop() : send()) }, icon('send'));
  composer = h('div', { class: 'composer' }, chipsEl, input, h('div', { class: 'composer-row' },
    h('button', { class: 'ibtn', title: 'Add file (@)', onclick: () => pickFile() }, icon('at')),
    modelBtn, h('span', { class: 'grow' }), sendBtn));
  el.append(scroller, composer);
  on('active', renderChips);
  on('selection', () => { if (document.activeElement !== input) renderChips(); });
  on('settings', renderModel);
  on('providers', renderModel);
  newChat();
}

export function reset() { stop(); pending = []; newChat(); }

function newChat() {
  stop();
  chat = { id: uid('c'), title: '', messages: [], updated: Date.now() };
  renderAll();
  input && requestAnimationFrame(() => input.focus());
}

function autosize() { input.style.height = 'auto'; input.style.height = Math.min(220, input.scrollHeight) + 'px'; }

function onKey(e) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  else if (e.key === '@' ) { setTimeout(() => pickFile(true), 0); }
  else if (e.key === 'Escape' && running) { e.preventDefault(); stop(); }
  else if (e.key === 'Backspace' && !input.value && pending.length) { pending.pop(); renderChips(); }
}

// ---------------- context ----------------
function currentContext() {
  const ctx = [...pending];
  const f = E.activeFile();
  if (autoFile && f && !ctx.some((c) => c.type === 'file' && c.path === f)) ctx.unshift({ type: 'file', path: f, auto: true });
  return ctx;
}

function renderChips() {
  if (!chipsEl) return;
  clear(chipsEl);
  for (const c of currentContext()) {
    const [lbl, col] = badgeOf(c.path);
    chipsEl.append(h('span', { class: 'chip' + (c.auto ? ' auto' : ''), title: c.auto ? 'Current file (click × to stop attaching it)' : c.path },
      h('span', { class: 'fbadge', style: { color: col } }, lbl), basename(c.path), c.lines ? h('span', { class: 'muted' }, ` ${c.lines}`) : null,
      c.auto ? h('span', { class: 'muted' }, ' · current') : null,
      h('button', { class: 'chip-x', onclick: () => { if (c.auto) autoFile = false; else pending = pending.filter((x) => x !== c); renderChips(); } }, icon('close'))));
  }
  if (!autoFile && E.activeFile()) chipsEl.append(h('button', { class: 'chip add', onclick: () => { autoFile = true; renderChips(); } }, icon('plus'), 'current file'));
}

export function addSelection() {
  const ed = E.getEditor(), f = E.activeFile();
  if (!f) return;
  const s = ed.getSelection();
  if (!s || s.isEmpty()) { addFile(f); return; }
  const text = ed.getModel().getValueInRange(s);
  pending.push({ type: 'selection', path: f, text, lines: `L${s.startLineNumber}-${s.endLineNumber}` });
  renderChips(); exec('layout.chat', true, 'chat'); input.focus();
}
export function addFile(p) {
  if (!pending.some((c) => c.type === 'file' && c.path === p)) pending.push({ type: 'file', path: p });
  renderChips(); exec('layout.chat', true, 'chat'); input.focus();
}

async function pickFile(fromAt) {
  const { pickFile: pf } = await import('../views/palette.js');
  const p = await pf('Add a file to the chat');
  if (fromAt && input.value.endsWith('@')) input.value = input.value.slice(0, -1);
  if (p) addFile(p); else input.focus();
}

async function buildContext(ctx) {
  let out = '', size = 0;
  for (const c of ctx) {
    let text = c.text;
    if (c.type === 'file') {
      const d = E.docs.get(c.path);
      text = d?.model ? d.model.getValue() : (await window.ks.fs.read(c.path).catch(() => ({}))).text;
      if (text == null) continue;
    }
    if (size + text.length > MAX_CTX) { out += `<note>${c.path} was not attached: the context limit of ${MAX_CTX} characters was reached.</note>\n`; continue; }
    size += text.length;
    out += c.type === 'selection' ? `<selection path="${c.path}" lines="${c.lines}">\n${text}\n</selection>\n` : `<file path="${c.path}">\n${text}\n</file>\n`;
  }
  return out;
}

// ---------------- sending ----------------
async function send(textArg) {
  const text = (textArg ?? input.value).trim();
  if (!text || running) return;
  const { provider, model } = chatTarget();
  const p = S.providers.find((x) => x.id === provider);
  if (!p || !usable(p)) { toast(h('div', {}, `Set up ${providerName(provider)} first (API key or Claude Code login). `, h('a', { href: '#', onclick: (e) => { e.preventDefault(); exec('settings.open', 'models'); } }, 'Open Settings')), 'error'); return; }
  const ctx = currentContext().map(({ auto, ...c }) => c);
  const user = { role: 'user', content: text, context: ctx.map((c) => ({ type: c.type, path: c.path, lines: c.lines })), wire: (await buildContext(ctx)) + text };
  chat.messages.push(user);
  if (!chat.title) chat.title = text.slice(0, 60);
  pending = []; input.value = ''; autosize(); renderChips();
  const reply = { role: 'assistant', content: '', model, provider };
  chat.messages.push(reply);
  renderAll();
  const node = scroller.lastChild;
  const messages = chat.messages.slice(0, -1).filter((m) => !m.error).map((m) => ({ role: m.role, content: m.wire || m.content }));
  let raf = 0;
  running = stream({ provider, model, system: SYSTEM_CHAT + (set('systemPrompt') ? '\n\nUser instructions:\n' + set('systemPrompt') : '') + workspaceNote(), messages, effort: set('effort') }, (full) => {
    reply.content = full;
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; paintMessage(node, reply, true); stick(); });
  });
  renderSend();
  try {
    const r = await running.promise;
    reply.content = r.text;
    if (r.stop === 'aborted') reply.stopped = true;
  } catch (e) {
    reply.error = e.message;
  } finally {
    cancelAnimationFrame(raf);
    running = null;
    paintMessage(node, reply, false); renderSend(); stick(); persist();
  }
}
function stop() { running?.abort(); }
function workspaceNote() { return S.ws ? `\n\nWorkspace: ${S.ws.name}${S.git?.branch ? ` (git branch ${S.git.branch})` : ''}. Current file: ${E.activeFile() || 'none'}.` : ''; }

let stuck = true;
function stick() { if (stuck) scroller.scrollTop = scroller.scrollHeight; }

// ---------------- rendering ----------------
function renderAll() {
  if (!scroller) return;
  clear(scroller);
  scroller.onscroll = () => { stuck = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40; };
  if (!chat.messages.length) scroller.append(emptyState());
  for (const m of chat.messages) { const n = h('div', { class: 'msg ' + m.role }); paintMessage(n, m, false); scroller.append(n); }
  renderChips(); renderModel(); renderSend();
  stuck = true; requestAnimationFrame(stick);
}

function emptyState() {
  const ideas = [['Explain this file', 'Explain what the current file does, step by step.'], ['Find bugs', 'Review the current file for bugs and edge cases. Be specific.'],
    ['Write tests', 'Write unit tests for the current file.'], ['Refactor', 'Suggest a cleaner structure for the current file and show the code.']];
  const past = loadAll().slice(0, 5);
  return h('div', { class: 'chat-empty' },
    h('img', { src: './logo.svg', class: 'chat-logo', alt: '' }),
    h('h3', {}, 'Ask Kestrel'),
    h('p', { class: 'muted' }, 'Chat with any model using your own API keys. The current file is attached automatically.'),
    h('div', { class: 'ideas' }, ideas.map(([t, q]) => h('button', { class: 'idea', onclick: () => send(q) }, icon('sparkle'), t))),
    past.length ? h('div', { class: 'past' }, h('div', { class: 'past-title' }, 'Recent chats'), past.map((c) => h('button', { class: 'past-item', onclick: () => { chat = c; renderAll(); } },
      icon('chat'), h('span', { class: 'ell' }, c.title || 'Untitled'), h('span', { class: 'muted sm' }, fmtRelative(c.updated))))) : null);
}

function paintMessage(node, m, live) {
  clear(node);
  if (m.role === 'user') {
    if (m.context?.length) node.append(h('div', { class: 'msg-ctx' }, m.context.map((c) => h('span', { class: 'chip mini', onclick: () => E.open(c.path) }, basename(c.path), c.lines ? ' ' + c.lines : ''))));
    node.append(h('div', { class: 'bubble' }, m.content));
    return;
  }
  const body = h('div', { class: 'md' });
  if (m.content) body.append(renderMd(m.content, { codeBlock: (b) => codeBlock(b, live), onLink: (u) => window.ks.shell.external(u), onInlineCode: linkify }));
  else if (live) body.append(h('div', { class: 'typing' }, h('i'), h('i'), h('i')));
  node.append(h('div', { class: 'msg-head' }, h('span', { class: 'avatar' }, icon('sparkle')), h('b', {}, shortModel(m.model)), h('span', { class: 'muted sm' }, providerName(m.provider))), body);
  if (m.error) node.append(h('div', { class: 'msg-err' }, icon('alert'), h('span', {}, m.error), h('button', { class: 'btn sm', onclick: () => retry() }, 'Retry')));
  if (m.stopped) node.append(h('div', { class: 'muted sm' }, 'Stopped.'));
  if (!live && !m.error && m.content) node.append(h('div', { class: 'msg-actions' },
    h('button', { class: 'ibtn', title: 'Copy', onclick: () => { window.ks.clip.copy(m.content); toast('Copied'); } }, icon('copy')),
    h('button', { class: 'ibtn', title: 'Retry', onclick: () => retry() }, icon('refresh'))));
}

// `src/app.ts` in prose → clickable when it's a workspace file
function linkify(el, text) {
  if (!/^[\w@./-]+\.[\w]+(:\d+)?$/.test(text) || !S.files) return;
  const [p, line] = text.split(':');
  const match = S.files.find((f) => f === p || f.endsWith('/' + p));
  if (match) { el.classList.add('link'); el.title = 'Open ' + match; el.addEventListener('click', () => E.open(match, { line: line ? +line : undefined })); }
}

function retry() {
  if (running) return;
  const lastUser = [...chat.messages].reverse().find((m) => m.role === 'user');
  if (!lastUser) return;
  const i = chat.messages.lastIndexOf(lastUser);
  chat.messages = chat.messages.slice(0, i);
  pending = (lastUser.context || []).filter((c) => c.type === 'file').map((c) => ({ type: 'file', path: c.path }));
  send(lastUser.content);
}

function codeBlock(b, live) {
  const target = b.file && (S.files?.includes(b.file) ? b.file : S.files?.find((f) => f.endsWith('/' + b.file))) || b.file;
  const pre = h('pre', { class: 'code' }, h('code', {}, b.code));
  const wrap = h('div', { class: 'codeblock' },
    h('div', { class: 'cb-head' },
      h('span', { class: 'cb-lang' }, target ? h('span', { class: 'cb-file', onclick: () => S.files?.includes(target) && E.open(target) }, target) : (b.lang || 'text')),
      live && !b.closed ? h('span', { class: 'muted sm' }, 'writing…') : h('span', { class: 'cb-actions' },
        h('button', { class: 'cb-btn', title: 'Copy', onclick: () => { window.ks.clip.copy(b.code); toast('Copied'); } }, icon('copy')),
        h('button', { class: 'cb-btn', title: 'Insert at cursor', onclick: () => insertAtCursor(b.code) }, icon('insert')),
        h('button', { class: 'cb-btn apply', title: target ? `Apply to ${target}` : 'Apply to the current file', onclick: (e) => apply(b, target, e.currentTarget) }, icon('play'), 'Apply'))),
    pre);
  // highlight once the block is complete (Monaco colorize is async and cheap)
  if (!live || b.closed) import('../editor/monaco.js').then(({ monaco }) => monaco.editor.colorize(b.code, languageOf(target || 'x.' + (b.lang || 'txt')), { tabSize: 2 }).then((html) => {
    const code = pre.firstChild;
    code.innerHTML = html; // colorize() escapes the source text; it only adds its own <span> markup
  }).catch(() => {}));
  return wrap;
}

function insertAtCursor(code) {
  const ed = E.getEditor();
  if (!E.activeFile()) { toast('Open a file first'); return; }
  const sel = ed.getSelection();
  ed.executeEdits('kestrel-chat', [{ range: sel, text: code, forceMoveMarkers: true }]);
  ed.focus();
}

/** Show a code block as a diff against its target file; merge partial snippets with the edit model first. */
async function apply(b, target, btn) {
  const path = target && (S.files?.includes(target) || E.docs.has(target)) ? target : (target || E.activeFile());
  if (!path) { toast('Open the file to apply this to first'); return; }
  let current = '';
  const d = E.docs.get(path);
  if (d?.model) current = d.model.getValue();
  else { const r = await window.ks.fs.read(path).catch(() => null); current = r?.text ?? ''; }
  let proposed = b.code;
  const looksPartial = current && (/\.\.\.\s*(existing|rest|unchanged|previous)/i.test(b.code) || b.code.length < current.length * 0.6);
  if (looksPartial) {
    btn.disabled = true; btn.classList.add('busy');
    const tgt = editTarget();
    try {
      const r = await stream({ ...tgt, system: SYSTEM_APPLY, messages: [{ role: 'user', content: `<file path="${path}">\n${current}\n</file>\n<edit>\n${b.code}\n</edit>` }], effort: 'low' }).promise;
      proposed = unfence(r.text);
      if (current.endsWith('\n') && !proposed.endsWith('\n')) proposed += '\n';
    } catch (e) { toast('Apply failed: ' + e.message, 'error'); return; }
    finally { btn.disabled = false; btn.classList.remove('busy'); }
  }
  const exists = !!current || S.files?.includes(path);
  E.openDiff({
    id: 'apply:' + path, title: basename(path), sub: exists ? 'Proposed change' : 'New file', badge: 'AI', path, original: current, modified: proposed,
    actions: [
      { label: 'Reject', icon: 'x', run: (t) => E.close(t.id) },
      { label: 'Accept', icon: 'check', primary: true, title: 'Write the change to the file (⌘S)', run: async (t) => {
        const text = t.modified.getValue();
        const doc = E.docs.get(path);
        if (doc?.model) { doc.model.pushEditOperations([], [{ range: doc.model.getFullModelRange(), text }], () => null); await E.save(path); }
        else await window.ks.fs.write(path, text);
        E.close(t.id); S.files = null; E.open(path, { pin: true }); toast(`Applied to ${basename(path)}`);
      } }],
  });
}

// ---------------- model picker ----------------
function renderModel() {
  if (!modelBtn) return;
  const { provider, model } = chatTarget();
  const p = S.providers.find((x) => x.id === provider);
  clear(modelBtn);
  modelBtn.append(h('span', { class: 'dot' + (p && usable(p) ? ' ok' : '') }), h('span', { class: 'ell' }, shortModel(model) || 'Choose model'), icon('chevronDown'));
  modelBtn.title = `${providerName(provider)} · ${model}`;
}
function renderSend() {
  if (!sendBtn) return;
  clear(sendBtn); sendBtn.append(icon(running ? 'stop' : 'send'));
  sendBtn.classList.toggle('stop', !!running); sendBtn.title = running ? 'Stop (Esc)' : 'Send (↵)';
}

export function modelMenu(anchor, field = 'chat') {
  const cur = field === 'chat' ? chatTarget() : { provider: set(field + 'Provider'), model: set(field + 'Model') };
  const filter = h('input', { class: 'input sm', placeholder: 'Filter models or type a model id…', spellcheck: 'false' });
  const listEl = h('div', { class: 'model-list' });
  const pick = (provider, model) => { saveSettings({ [field + 'Provider']: provider, [field + 'Model']: model }); closeMenu(); };
  const draw = () => {
    clear(listEl);
    const q = filter.value.trim().toLowerCase();
    for (const p of S.providers) {
      const ok = usable(p);
      const models = p.models.filter((m) => !q || m.toLowerCase().includes(q) || p.name.toLowerCase().includes(q));
      if (!models.length && !(q && ok)) { if (!q) listEl.append(h('div', { class: 'ml-prov' }, h('span', {}, p.name), ok ? h('button', { class: 'link sm', onclick: () => refresh(p.id) }, 'load models') : h('button', { class: 'link sm', onclick: () => { closeMenu(); exec('settings.open', 'models'); } }, 'add key'))); continue; }
      listEl.append(h('div', { class: 'ml-prov' }, h('span', {}, p.name), ok ? h('button', { class: 'link sm', title: 'Fetch the model list from the provider', onclick: () => refresh(p.id) }, 'refresh') : h('button', { class: 'link sm', onclick: () => { closeMenu(); exec('settings.open', 'models'); } }, 'add key')));
      for (const m of models.slice(0, 60)) listEl.append(h('button', { class: 'ml-item' + (cur.provider === p.id && cur.model === m ? ' on' : '') + (ok ? '' : ' off'), disabled: !ok, onclick: () => pick(p.id, m) }, h('span', { class: 'ell' }, m), cur.provider === p.id && cur.model === m ? icon('check') : null));
      if (q && ok && !p.models.includes(filter.value.trim())) listEl.append(h('button', { class: 'ml-item custom', onclick: () => pick(p.id, filter.value.trim()) }, icon('plus'), h('span', { class: 'ell' }, `Use “${filter.value.trim()}” with ${p.name}`)));
    }
  };
  const refresh = async (id) => { try { await window.ks.ai.models(id); await loadProviders(); draw(); } catch (e) { toast(e.message, 'error'); } };
  filter.addEventListener('input', draw);
  filter.addEventListener('keydown', (e) => { if (e.key === 'Enter') listEl.querySelector('.ml-item:not([disabled])')?.click(); });
  draw();
  popover(h('div', { class: 'model-pop' }, filter, listEl, h('div', { class: 'ml-foot' }, h('button', { class: 'link sm', onclick: () => { closeMenu(); exec('settings.open', 'models'); } }, icon('key'), ' Manage API keys…'))), anchor);
  requestAnimationFrame(() => filter.focus());
}

export function historyMenu(anchor) {
  const list = loadAll();
  popupMenu([
    { label: 'New Chat', icon: 'plus', kbd: '⌥⌘N', onClick: () => newChat() },
    list.length ? '-' : null,
    ...list.slice(0, 15).map((c) => ({ label: c.title || 'Untitled', icon: 'chat', kbd: fmtRelative(c.updated).replace(' ago', ''), onClick: () => { stop(); chat = c; renderAll(); } })),
    list.length ? '-' : null,
    list.length ? { label: 'Clear History', danger: true, icon: 'trash', onClick: () => { saveAll([]); toast('Chat history cleared'); } } : null,
  ].filter(Boolean), anchor);
}

command('chat.focus', 'AI: Chat', () => { exec('layout.chat', true, 'chat'); requestAnimationFrame(() => input.focus()); });
command('chat.addSelection', 'AI: Add Selection to Chat', () => addSelection());
command('chat.addFile', 'AI: Add File to Chat', (p) => addFile(p || E.activeFile()));
command('chat.new', 'AI: New Chat', () => { exec('layout.chat', true, 'chat'); newChat(); });
command('chat.model', 'AI: Choose Chat Model…', () => { exec('layout.chat', true, 'chat'); requestAnimationFrame(() => modelMenu(modelBtn)); });
