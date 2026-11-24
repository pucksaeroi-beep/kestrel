// Claude Code GUI: a chat-style front end for real Claude Code sessions (Agent SDK in the main process).
// Same login, settings, CLAUDE.md, skills and slash commands as the CLI; adds permission modes, approval
// cards with diffs, Claude's questions, plan review, session history and a / command menu.
import { S, set, saveSettings, on, emit, exec, basename } from '../state.js';
import { h, icon, clear, toast, uid, popupMenu, popover, closeMenu, confirm, modal, fmtRelative } from '../ui/h.js';
import { render as renderMd } from '../lib/markdown.js';
import { contextView, usageView } from './ccinfo.js';
import { badgeOf, languageOf } from '../lib/lang.js';
import * as E from '../editor/editors.js';

export const MODES = [
  { id: 'default', label: 'Manual', icon: 'hand', hint: 'Claude will ask for approval before making each edit' },
  { id: 'acceptEdits', label: 'Edit automatically', icon: 'code', hint: 'Claude will edit files without asking. Commands still ask' },
  { id: 'plan', label: 'Plan', icon: 'plan', hint: 'Claude will explore the code and present a plan before editing' },
  { id: 'auto', label: 'Auto', icon: 'bolt', hint: 'Claude will approve actions that pass a safety check and pause for anything risky' },
];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const cap = (x) => x ? x[0].toUpperCase() + x.slice(1) : x;
const CYCLE = ['default', 'acceptEdits', 'plan', 'auto'];
// handled by the GUI itself (the CLI's versions are interactive screens)
const LOCAL = [
  { name: 'clear', description: 'Start a new session', run: () => newSession() },
  { name: 'resume', description: 'Open a past session', run: () => historyMenu(histBtn) },
  { name: 'model', description: 'Switch the model (or pick from a list)', argumentHint: '[model]', run: (a) => a ? switchModel(a) : modelMenu(modelBtn) },
  { name: 'effort', description: 'Set the effort level', argumentHint: '[low|medium|high|xhigh|max|auto]', run: (a) => a ? setEffortCmd(a) : modelMenu(modelBtn) },
  { name: 'mode', description: 'Choose the permission mode', run: () => modeMenu(modeBtn) },
  { name: 'rewind', description: 'Go back to before an earlier message (files too)', run: () => rewindMenu(actBtn) },
  { name: 'context', description: 'Show what fills the context window', run: () => showContext() },
  { name: 'usage', description: 'Show plan usage limits and session cost', aliases: ['cost', 'stats'], run: () => showUsage() },
  { name: 'export', description: 'Copy the conversation as Markdown', run: () => exportChat() },
  { name: 'terminal', description: 'Switch to the claude CLI in a terminal', run: () => exec('claude.view', 'terminal') },
];

let host, scroller, input, chipsEl, modeBtn, modelBtn, sendBtn, histBtn, actBtn, titleEl, slashEl;
let turns = [];            // [{ uuid, text, node, prevAssistant }] for Rewind
let lastAssistant = null;  // uuid of the latest assistant message
let resumeNext = null;     // { id, at } for the next ensure() after a rewind
let transcript = [];       // [{ role, text }] for Export
let sid = null;            // our handle for the running SDK session
let sessionId = null;      // Claude Code's own session id (for resume)
let busy = false;          // a turn is in progress
let starting = null;       // promise while the session spins up
let commands = [];         // from the CLI
let models = [];
let mode = null;
let autoFile = true, pending = [];
const shown = new Set();    // message uuids already on screen
const tools = new Map();   // tool_use_id → { card, name, input }
const perms = new Map();   // rid → card
let liveText = null, liveThink = null, stuck = true;

const rel = (p) => { const s = String(p || ''); return S.ws && s.startsWith(S.ws.root + '/') ? s.slice(S.ws.root.length + 1) : s; };
const curMode = () => mode || set('ccMode') || 'default';

export function mount(el) {
  host = el;
  titleEl = h('span', { class: 'ell cc-title' }, 'New session');
  histBtn = h('button', { class: 'ibtn', title: 'Past sessions', onclick: (e) => historyMenu(e.currentTarget) }, icon('history'));
  const head = h('div', { class: 'cc-head' }, icon('claude'), titleEl, h('span', { class: 'grow' }),
    h('button', { class: 'ibtn', title: 'New session (/clear)', onclick: () => newSession() }, icon('plus')), histBtn,
    h('button', { class: 'ibtn', title: 'Use the claude CLI in a terminal instead', onclick: () => exec('claude.view', 'terminal') }, icon('terminal')));
  scroller = h('div', { class: 'chat-scroll cc-scroll' });
  scroller.onscroll = () => { stuck = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40; };
  chipsEl = h('div', { class: 'chips' });
  input = h('textarea', { class: 'chat-input', rows: 1, placeholder: '⌘Esc to focus or unfocus Claude', spellcheck: 'false',
    oninput: () => { autosize(); slashMenu(); }, onkeydown: onKey, onfocus: () => ensure().catch(() => {}) });
  slashEl = h('div', { class: 'cc-slash', style: { display: 'none' } });
  modeBtn = h('button', { class: 'cc-mode', onclick: (e) => modeMenu(e.currentTarget) });
  modelBtn = h('button', { class: 'cc-chip', onclick: (e) => modelMenu(e.currentTarget) });
  actBtn = h('button', { class: 'cc-act', title: 'Actions and commands (/)', onclick: (e) => actionsMenu(e.currentTarget) }, h('span', {}, '/'));
  sendBtn = h('button', { class: 'send-btn', onclick: () => (busy && !input.value.trim() ? interrupt() : send()) }, icon('send'));
  const composer = h('div', { class: 'composer cc-composer' }, slashEl, chipsEl, input, h('div', { class: 'composer-row' },
    h('button', { class: 'ibtn', title: 'Attach a file from this project (@)', onclick: () => pickFile() }, icon('plus')),
    actBtn, modelBtn, h('span', { class: 'grow' }), modeBtn, sendBtn));
  el.append(head, scroller, composer);
  // drop files/images from Finder or the explorer, paste screenshots
  el.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; el.classList.add('cc-dropping'); });
  el.addEventListener('dragleave', (e) => { if (!el.contains(e.relatedTarget)) el.classList.remove('cc-dropping'); });
  el.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); el.classList.remove('cc-dropping'); attachDropped(e.dataTransfer).catch((x) => toast(x.message, 'error')); });
  input.addEventListener('paste', (e) => {
    const imgs = [...(e.clipboardData?.files || [])].filter(isImage);
    if (!imgs.length) return;
    e.preventDefault();
    Promise.all(imgs.map(addImage)).catch((x) => toast(x.message, 'error'));
  });
  on('active', renderChips);
  on('selection', () => { if (document.activeElement !== input) renderChips(); });
  window.ks.cc.onMsg((s, m) => { if (s === sid) onMessage(m); });
  window.ks.cc.onEnd((s, err) => { if (s !== sid) return; sid = null; setBusy(false); if (err) note(err, 'err'); });
  window.ks.cc.onPerm((s, rid, req) => { if (s === sid) permCard(rid, req); });
  window.ks.cc.onPermCancel((s, rid) => { perms.get(rid)?.remove(); perms.delete(rid); });
  window.ks.cc.onStderr((s, t) => { if (s === sid) console.warn('claude:', t); });
  newSession();
}

export function focus() { requestAnimationFrame(() => input?.focus()); }
/** ⌘Esc: jump into the prompt, or back to the editor when already there. */
export function toggleFocus() { if (document.activeElement === input) E.getEditor()?.focus(); else focus(); }

// ---------------- session lifecycle ----------------
function ensure(resume) {
  if (sid) return Promise.resolve(sid);
  if (starting) return starting;
  if (!S.ws) return Promise.reject(new Error('Open a folder first'));
  const id = uid('cc');
  const r = resume ? { resume } : resumeNext ? { resume: resumeNext.id, resumeAt: resumeNext.at } : {};
  resumeNext = null;
  starting = window.ks.cc.start(id, { mode: curMode(), model: set('ccModel') || 'default', effort: set('ccEffort') || undefined, ...r }).then(() => {
    sid = id;
    window.ks.cc.commands(id).then((c) => { commands = c || []; slashMenu(); }).catch(() => {});
    window.ks.cc.models(id).then((m) => { models = m || []; renderBar(); }).catch(() => {});
    return id;
  }).finally(() => { starting = null; });
  return starting;
}

export function newSession() {
  if (sid) window.ks.cc.close(sid).catch(() => {});
  sid = null; sessionId = null; busy = false; mode = null;
  turns = []; lastAssistant = null; resumeNext = null; transcript = [];
  tools.clear(); perms.clear(); shown.clear(); liveText = liveThink = null;
  if (!scroller) return;
  clear(scroller); scroller.append(emptyState());
  titleEl.textContent = 'New session';
  renderBar(); renderChips();
}

async function resumeSession(s) {
  newSession();
  titleEl.textContent = s.title;
  clear(scroller);
  try {
    const hist = await window.ks.cc.history(s.id);
    for (const m of hist) if (m.type === 'user' || m.type === 'assistant') onMessage({ type: m.type, uuid: m.uuid, message: m.message, parent_tool_use_id: m.parent_tool_use_id, replay: true });
    for (const t of tools.values()) if (t.card.classList.contains('run')) setToolState(t, 'ok');
    note('Earlier messages above. Your next message continues this session.', 'sep');
    await ensure(s.id);
  } catch (e) { note('Could not open the session: ' + e.message, 'err'); }
  stuck = true; stick();
}

function interrupt() { if (sid) window.ks.cc.interrupt(sid).catch(() => {}); }

function setBusy(v) { busy = v; renderBar(); }

// ---------------- sending ----------------
async function send(textArg) {
  let text = (textArg ?? input.value).trim();
  if (!text && textArg == null && pending.some((c) => c.type === 'image')) text = 'Look at the attached image.';
  if (!text) return;
  const sl = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text);
  const cmd = sl && LOCAL.find((c) => (c.name === sl[1] || c.aliases?.includes(sl[1])) && (!sl[2] || c.argumentHint));
  if (cmd) { input.value = ''; autosize(); hideSlash(); cmd.run(sl[2]?.trim() || ''); return; }
  if (sl?.[1] === 'compact' && !turns.some((t) => !t.text.startsWith('/'))) {
    input.value = ''; autosize(); hideSlash();
    note('Nothing to compact yet: this session has no conversation. Send a message first, or open a past session (/resume).', 'muted');
    return;
  }
  hideSlash();
  const ctx = text.startsWith('/') ? [] : currentContext();
  let wire = text;
  const sel = ctx.find((c) => c.type === 'selection');
  const files = ctx.filter((c) => c.type === 'file').map((c) => '@' + (/\s/.test(c.path) ? `"${c.path}"` : c.path));
  const images = ctx.filter((c) => c.type === 'image');
  if (sel) wire = `<selection path="${sel.path}" lines="${sel.lines}">\n${sel.text}\n</selection>\n\n` + wire;
  if (files.length) wire = `(Open in the editor: ${files.join(' ')})\n\n` + wire;
  if (scroller.querySelector('.chat-empty')) clear(scroller);
  const node = userBubble(text, ctx);
  const turn = { text, node, prevAssistant: lastAssistant, uuid: null };
  turns.push(turn);
  input.value = ''; autosize(); pending = []; renderChips();
  if (titleEl.textContent === 'New session') titleEl.textContent = text.slice(0, 60);
  try {
    await ensure();
    setBusy(true);
    turn.uuid = await window.ks.cc.send(sid, images.length
      ? [...images.map((c) => ({ type: 'image', source: { type: 'base64', media_type: c.media, data: c.data } })), { type: 'text', text: wire }]
      : wire);
  } catch (e) { setBusy(false); note(e.message, 'err'); }
}

// ---------------- incoming messages ----------------
function onMessage(m) {
  if (m.type === 'system') {
    if (m.subtype === 'init') {
      sessionId = m.session_id; mode = m.permissionMode || mode;
      if (m.slash_commands?.length && !commands.length) commands = m.slash_commands.map((n) => ({ name: n, description: '' }));
      S.cc = { model: m.model }; renderBar();
    } else if (m.subtype === 'session_title_changed' && m.title) titleEl.textContent = m.title;
    else if (m.subtype === 'compact_boundary') note('Conversation compacted', 'sep');
    else if (m.subtype === 'api_retry') note(`API busy — retrying (attempt ${m.attempt ?? ''})…`, 'muted');
    else if (m.subtype === 'local_command_output' || m.subtype === 'command_output') outputBlock(m.content ?? m.output ?? '');
    else if (m.subtype === 'status' && m.permissionMode) { mode = m.permissionMode; renderBar(); }
    return;
  }
  if (m.type === 'stream_event') return onStream(m);
  if (m.parent_tool_use_id) { subagentActivity(m); return; }
  // Claude Code re-sends some earlier command output after /compact; show each message once
  if ((m.type === 'assistant' || m.type === 'user') && m.uuid) { if (shown.has(m.uuid)) return; shown.add(m.uuid); }
  if (m.type === 'assistant') {
    if (m.uuid) lastAssistant = m.uuid;
    for (const b of m.message?.content || []) {
      if (b.type === 'text') { transcript.push({ role: 'assistant', text: b.text }); if (liveText) { paintText(liveText, b.text); liveText = null; } else paintText(addNode('msg assistant'), b.text); }
      else if (b.type === 'thinking' || b.type === 'redacted_thinking') { if (liveThink) finishThinking(liveThink, b.thinking); else if (b.thinking) finishThinking(thinkingNode(), b.thinking); liveThink = null; }
      else if (b.type === 'tool_use' || b.type === 'server_tool_use' || b.type === 'mcp_tool_use') toolCard(b);
    }
    if (m.error) note(m.error === 'rate_limit' ? 'Usage limit reached.' : String(m.error), 'err');
  } else if (m.type === 'user') {
    const c = m.message?.content;
    if (typeof c === 'string') {
      const out = /<local-command-std(?:out|err)>([\s\S]*?)<\/local-command-std(?:out|err)>/.exec(c);
      if (out) outputBlock(out[1]);
      else if (m.replay && !m.isMeta && !/^<(command-|local-command|system-reminder)/.test(c)) replayTurn(m, stripWire(c));
      return;
    }
    for (const b of c || []) {
      if (b.type === 'tool_result') toolResult(b, m.tool_use_result);
      else if (b.type === 'text' && m.replay && !/^<(command-|local-command|system-reminder)/.test(b.text)) replayTurn(m, stripWire(b.text));
    }
  } else if (m.type === 'result') {
    if (liveThink) finishThinking(liveThink);
    for (const n of scroller.querySelectorAll('.cc-think')) if (n.querySelector('.cc-think-l')?.textContent === 'Thinking…') finishThinking(n);
    liveText = liveThink = null;
    setBusy(false);
    for (const t of tools.values()) if (t.card.classList.contains('run')) setToolState(t, 'ok');
    if (m.is_error || (m.subtype && m.subtype !== 'success')) {
      const msg = m.subtype === 'error_max_turns' ? 'Stopped: reached the turn limit.' : m.subtype === 'error_during_execution' ? null : (m.result || m.errors?.join('\n') || 'Claude Code stopped with an error.');
      if (msg) note(msg, 'err');
    }
    if (m.duration_ms && m.num_turns) note(`${(m.duration_ms / 1000).toFixed(1)}s · ${m.num_turns} turn${m.num_turns === 1 ? '' : 's'}`, 'foot');
  }
}
function replayTurn(m, text) { turns.push({ text, node: userBubble(text, []), prevAssistant: lastAssistant, uuid: m.uuid }); }
const stripWire = (t) => t.replace(/^\(Open in the editor: [^)]*\)\n\n/, '').replace(/^<selection [^>]*>[\s\S]*?<\/selection>\n\n/, '');

function onStream(m) {
  if (m.parent_tool_use_id) return;
  const ev = m.event;
  if (ev.type === 'content_block_start') {
    if (ev.content_block.type === 'text') { liveText = addNode('msg assistant'); liveText._t = ''; paintText(liveText, '', true); }
    else if (ev.content_block.type === 'thinking') { liveThink = thinkingNode(); }
  } else if (ev.type === 'content_block_delta') {
    if (ev.delta.type === 'text_delta' && liveText) { liveText._t += ev.delta.text; if (!liveText._raf) liveText._raf = requestAnimationFrame(() => { liveText && (liveText._raf = 0, paintText(liveText, liveText._t, true)); }); }
    else if (ev.delta.type === 'thinking_delta' && liveThink) { liveThink._t = (liveThink._t || '') + ev.delta.thinking; }
  }
}

// ---------------- rendering ----------------
function addNode(cls) { const n = h('div', { class: cls }); scroller.append(n); stick(); return n; }
function stick() { if (stuck) requestAnimationFrame(() => { scroller.scrollTop = scroller.scrollHeight; }); }

function note(text, kind = 'muted') { addNode('cc-note ' + kind).append(kind === 'err' ? icon('alert') : '', h('span', {}, text)); }

function userBubble(text, ctx) {
  const n = addNode('msg user');
  if (ctx?.length) n.append(h('div', { class: 'msg-ctx' }, ctx.map((c) => c.type === 'image'
    ? h('span', { class: 'chip mini cc-imgchip', title: c.name }, h('img', { src: c.thumb }), c.name)
    : h('span', { class: 'chip mini', onclick: () => { if (!c.path.startsWith('/')) E.open(c.path); } }, basename(c.path), c.lines ? ' ' + c.lines : ''))));
  n.append(h('div', { class: 'bubble' }, text));
  transcript.push({ role: 'user', text });
  return n;
}

function paintText(node, text, live) {
  clear(node);
  node.append(h('div', { class: 'md' }, text ? renderMd(text, { codeBlock, onLink: (u) => window.ks.shell.external(u), onInlineCode: linkify })
    : h('div', { class: 'typing' }, h('i'), h('i'), h('i'))));
  if (!live && text) node.append(h('div', { class: 'msg-actions' }, h('button', { class: 'ibtn', title: 'Copy', onclick: () => { window.ks.clip.copy(text); toast('Copied'); } }, icon('copy'))));
  stick();
}

function thinkingNode() {
  const n = addNode('cc-think');
  n.append(h('button', { class: 'cc-think-h', onclick: () => n.classList.toggle('open') }, icon('sparkle'), h('span', { class: 'cc-think-l' }, 'Thinking…')));
  return n;
}
function finishThinking(n, text) {
  const t = text || n._t || '';
  if (!t) { n.remove(); return; } // thinking not shown by this model/setting
  n.querySelector('.cc-think-l').textContent = 'Thought';
  if (!n.querySelector('.cc-think-b')) n.append(h('div', { class: 'cc-think-b' }, t));
}

function outputBlock(text) {
  const clean = String(text).replace(/\x1b\[[0-9;]*m/g, '').trim();
  if (clean) addNode('cc-output').append(h('pre', {}, clean));
}

function codeBlock(b) {
  const pre = h('pre', { class: 'code' }, h('code', {}, b.code));
  import('../editor/monaco.js').then(({ monaco }) => monaco.editor.colorize(b.code, languageOf(b.file || 'x.' + (b.lang || 'txt')), { tabSize: 2 })
    .then((html) => { pre.firstChild.innerHTML = html; }).catch(() => {}));
  return h('div', { class: 'codeblock' }, h('div', { class: 'cb-head' }, h('span', { class: 'cb-lang' }, b.file || b.lang || 'text'), h('span', { class: 'cb-actions' },
    h('button', { class: 'cb-btn', title: 'Copy', onclick: () => { window.ks.clip.copy(b.code); toast('Copied'); } }, icon('copy')))), pre);
}

function linkify(el, text) {
  if (!/^[\w@./-]+\.[\w]+(:\d+)?$/.test(text) || !S.files) return;
  const [p, line] = text.split(':');
  const r = rel(p);
  const match = S.files.find((f) => f === r || f.endsWith('/' + r));
  if (match) { el.classList.add('link'); el.title = 'Open ' + match; el.addEventListener('click', () => E.open(match, { line: line ? +line : undefined })); }
}

// ---------------- tool cards ----------------
function summary(name, i = {}) {
  const f = i.file_path || i.notebook_path || i.path;
  switch (name) {
    case 'Read': return [rel(f), i.offset ? `from line ${i.offset}` : ''];
    case 'Write': case 'Edit': case 'MultiEdit': case 'NotebookEdit': return [rel(f), ''];
    case 'Bash': return [i.description || '', i.command];
    case 'Grep': return [i.pattern, i.path ? 'in ' + rel(i.path) : (i.glob || '')];
    case 'Glob': return [i.pattern, i.path ? 'in ' + rel(i.path) : ''];
    case 'WebFetch': return [i.url, ''];
    case 'WebSearch': return [i.query, ''];
    case 'Agent': case 'Task': return [i.description || i.subagent_type || '', ''];
    case 'Skill': return [i.skill || i.command || '', i.args || ''];
    case 'TodoWrite': return [`${(i.todos || []).filter((t) => t.status === 'completed').length}/${(i.todos || []).length} done`, ''];
    default: { const s = JSON.stringify(i); return [s.length > 80 ? s.slice(0, 80) + '…' : s, '']; }
  }
}
const TOOL_ICON = { Read: 'file', Write: 'newFile', Edit: 'edit', MultiEdit: 'edit', Bash: 'terminal', Grep: 'search', Glob: 'search', WebFetch: 'globe', WebSearch: 'globe', Agent: 'bot', Task: 'bot', TodoWrite: 'list', Skill: 'wand' };

function toolCard(b) {
  if (tools.has(b.id)) return;
  const name = b.name.replace(/^mcp__(.+?)__/, '$1 · ');
  const [main, sub] = summary(b.name, b.input);
  const body = h('div', { class: 'cc-tool-b' });
  const target = b.input?.file_path && rel(b.input.file_path);
  const card = h('div', { class: 'cc-tool run' },
    h('div', { class: 'cc-tool-h', onclick: () => card.classList.toggle('open') },
      h('span', { class: 'cc-st' }), icon(TOOL_ICON[b.name] || 'sparkle'), h('b', {}, name),
      h('span', { class: 'ell cc-tool-s' + (target ? ' link' : ''), title: main, onclick: target ? (e) => { e.stopPropagation(); E.open(target); } : null }, main),
      icon('chevronRight', 'cc-caret')),
    sub ? h('div', { class: 'cc-tool-sub ell', title: sub }, sub) : null, body);
  if (b.name === 'TodoWrite') { card.classList.add('open'); body.append(todoList(b.input?.todos)); }
  else body.append(h('pre', { class: 'cc-pre' }, b.name === 'Bash' ? b.input.command : JSON.stringify(b.input, null, 2)));
  scroller.append(card); stick();
  tools.set(b.id, { card, name: b.name, input: b.input, body });
}

function todoList(todos = []) {
  return h('div', { class: 'cc-todos' }, todos.map((t) => h('div', { class: 'cc-todo ' + t.status }, icon(t.status === 'completed' ? 'check' : t.status === 'in_progress' ? 'play' : 'dot'), h('span', {}, t.status === 'in_progress' ? (t.activeForm || t.content) : t.content))));
}

function setToolState(t, st) { t.card.classList.remove('run', 'ok', 'bad'); t.card.classList.add(st); }

function toolResult(b, structured) {
  const t = tools.get(b.tool_use_id);
  if (!t) return;
  setToolState(t, b.is_error ? 'bad' : 'ok');
  let text = typeof b.content === 'string' ? b.content : (b.content || []).filter((x) => x.type === 'text').map((x) => x.text).join('\n');
  if (t.name === 'TodoWrite') return;
  if (structured?.structuredPatch && ['Edit', 'MultiEdit', 'Write'].includes(t.name)) {
    let add = 0, del = 0;
    for (const hk of structured.structuredPatch) for (const l of hk.lines || []) { if (l[0] === '+') add++; else if (l[0] === '-') del++; }
    t.card.querySelector('.cc-tool-h').insertBefore(h('span', { class: 'cc-delta' }, h('span', { class: 'add' }, '+' + add), ' ', h('span', { class: 'del' }, '−' + del)), t.card.querySelector('.cc-caret'));
  }
  if (text) {
    if (text.length > 6000) text = text.slice(0, 6000) + '\n…';
    t.body.append(h('div', { class: 'cc-res-h muted sm' }, b.is_error ? 'Error' : 'Result'), h('pre', { class: 'cc-pre' + (b.is_error ? ' err' : '') }, text));
    if (b.is_error && !/denied|rejected|doesn't want/i.test(text)) t.card.classList.add('open');
  }
}

function subagentActivity(m) {
  const t = tools.get(m.parent_tool_use_id);
  if (!t || m.type !== 'assistant') return;
  for (const b of m.message?.content || []) {
    if (b.type !== 'tool_use') continue;
    let line = t.card.querySelector('.cc-sub-act');
    if (!line) { line = h('div', { class: 'cc-sub-act muted sm ell' }); t.card.insertBefore(line, t.body); }
    t.subCount = (t.subCount || 0) + 1;
    line.textContent = `↳ ${b.name} ${summary(b.name, b.input)[0] || ''} · ${t.subCount} tool use${t.subCount === 1 ? '' : 's'}`;
  }
}

// ---------------- permission prompts ----------------
function answer(rid, result) {
  window.ks.cc.answer(sid, rid, result);
  const c = perms.get(rid); perms.delete(rid);
  if (E.tabs.some((t) => t.id === 'ccperm:' + rid)) E.close('ccperm:' + rid, { force: true });
  if (c) { c.classList.add('done'); c.querySelectorAll('button, textarea, input').forEach((x) => { x.disabled = true; }); setTimeout(() => c.remove(), 200); }
  input.focus();
}

function permCard(rid, req) {
  if (req.tool === 'AskUserQuestion') return questionCard(rid, req);
  if (req.tool === 'ExitPlanMode') return planCard(rid, req);
  const i = req.input || {};
  const fileTool = ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(req.tool);
  const detail = req.tool === 'Bash' ? h('pre', { class: 'cc-pre cmd' }, i.command)
    : fileTool ? h('div', { class: 'cc-perm-file' }, icon('file'), h('span', { class: 'ell' }, rel(i.file_path || i.notebook_path)),
      h('button', { class: 'btn xs', onclick: () => showDiff(rid, req) }, icon('split'), 'View diff'))
      : h('pre', { class: 'cc-pre' }, JSON.stringify(i, null, 2).slice(0, 3000));
  const why = h('input', { class: 'input sm', placeholder: 'Tell Claude what to do instead (optional)', onkeydown: (e) => { if (e.key === 'Enter') deny(); } });
  const deny = () => answer(rid, { behavior: 'deny', message: why.value.trim() ? 'The user said no and wrote: ' + why.value.trim() : 'The user denied this action.' });
  const allow = () => answer(rid, { behavior: 'allow', updatedInput: i });
  const always = req.suggestions?.length ? () => answer(rid, { behavior: 'allow', updatedInput: i, updatedPermissions: req.suggestions }) : null;
  const card = h('div', { class: 'cc-perm', tabindex: '-1', onkeydown: (e) => {
    if (e.target === why) return;
    if (e.key === 'Enter') { e.preventDefault(); allow(); } else if (e.key === 'Escape') { e.preventDefault(); deny(); }
  } },
    h('div', { class: 'cc-perm-t' }, icon('key'), h('b', {}, req.title || `Allow ${req.displayName || req.tool}?`)),
    req.description && !fileTool ? h('div', { class: 'muted sm' }, req.description) : null,
    req.reason ? h('div', { class: 'muted sm' }, req.reason) : null,
    detail, why,
    h('div', { class: 'cc-perm-a' },
      h('button', { class: 'btn sm primary', onclick: allow }, 'Allow', h('span', { class: 'kbd' }, '↵')),
      always ? h('button', { class: 'btn sm', title: suggestText(req.suggestions), onclick: always }, fileTool ? 'Allow all edits this session' : "Allow, don't ask again") : null,
      h('span', { class: 'grow' }),
      h('button', { class: 'btn sm', onclick: deny }, 'Deny', h('span', { class: 'kbd' }, 'esc'))));
  perms.set(rid, card);
  scroller.append(card); stuck = true; stick();
  requestAnimationFrame(() => card.focus());
}
function suggestText(list = []) {
  return list.map((s) => s.type === 'setMode' ? `Switch to ${MODES.find((m) => m.id === s.mode)?.label || s.mode}` : s.type === 'addRules' ? 'Allow ' + s.rules.map((r) => r.toolName + (r.ruleContent ? `(${r.ruleContent})` : '')).join(', ') + ` (${s.destination})` : s.type).join('\n');
}

async function showDiff(rid, req) {
  const i = req.input, path = i.file_path || i.notebook_path, r = rel(path);
  let original = '';
  const d = E.docs.get(r);
  if (d?.model) original = d.model.getValue();
  else original = await (r !== path ? window.ks.fs.read(r).then((x) => x.text ?? '') : window.ks.fs.readAbs(path)).catch(() => '');
  let modified = original;
  if (req.tool === 'Write') modified = i.content;
  else {
    for (const e of req.tool === 'MultiEdit' ? i.edits : [i]) modified = e.replace_all ? modified.split(e.old_string).join(e.new_string) : modified.replace(e.old_string, () => e.new_string);
  }
  E.openDiff({
    id: 'ccperm:' + rid, title: basename(path), sub: original ? 'Claude Code · proposed edit' : 'Claude Code · new file', badge: 'CC', path: r, original, modified,
    actions: [
      { label: 'Deny', icon: 'x', run: (t) => { E.close(t.id, { force: true }); if (perms.has(rid)) answer(rid, { behavior: 'deny', message: 'The user rejected this edit.' }); } },
      { label: 'Allow', icon: 'check', primary: true, run: (t) => { E.close(t.id, { force: true }); if (perms.has(rid)) answer(rid, { behavior: 'allow', updatedInput: i }); } }],
  });
}

function questionCard(rid, req) {
  const qs = req.input?.questions || [];
  const picked = qs.map(() => new Set());
  const other = qs.map(() => h('input', { class: 'input sm', placeholder: 'Other…' }));
  const card = h('div', { class: 'cc-perm cc-ask' },
    qs.map((q, qi) => h('div', { class: 'cc-q' },
      h('div', { class: 'cc-q-h' }, q.header ? h('span', { class: 'cc-tag' }, q.header) : null, h('b', {}, q.question)),
      h('div', { class: 'cc-opts' }, q.options.map((o) => {
        const b = h('button', { class: 'cc-opt', title: o.description, onclick: () => {
          if (q.multiSelect) { picked[qi].has(o.label) ? picked[qi].delete(o.label) : picked[qi].add(o.label); b.classList.toggle('on'); }
          else { picked[qi].clear(); picked[qi].add(o.label); b.parentNode.querySelectorAll('.cc-opt').forEach((x) => x.classList.toggle('on', x === b)); if (qs.length === 1) submit(); }
        } }, h('b', {}, o.label), h('span', { class: 'muted sm' }, o.description));
        return b;
      })), other[qi])),
    h('div', { class: 'cc-perm-a' }, h('button', { class: 'btn sm primary', onclick: () => submit() }, 'Submit'), h('span', { class: 'grow' }),
      h('button', { class: 'btn sm', onclick: () => answer(rid, { behavior: 'deny', message: 'The user dismissed the question.' }) }, 'Skip')));
  function submit() {
    const answers = {};
    qs.forEach((q, qi) => { const v = [...picked[qi], other[qi].value.trim()].filter(Boolean).join(', '); if (v) answers[q.question] = v; });
    answer(rid, { behavior: 'allow', updatedInput: { ...req.input, answers } });
  }
  perms.set(rid, card); scroller.append(card); stuck = true; stick();
}

function planCard(rid, req) {
  const plan = req.input?.plan || '';
  const why = h('input', { class: 'input sm', placeholder: 'What should change in the plan?' });
  const go = (m) => { answer(rid, { behavior: 'allow', updatedInput: req.input, updatedPermissions: [{ type: 'setMode', mode: m, destination: 'session' }] }); mode = m; renderBar(); };
  const card = h('div', { class: 'cc-perm cc-plan' },
    h('div', { class: 'cc-perm-t' }, icon('list'), h('b', {}, 'Ready to code? Here is Claude\'s plan')),
    h('div', { class: 'md cc-plan-b' }, renderMd(plan, { codeBlock })),
    h('div', { class: 'cc-perm-a col' },
      h('button', { class: 'btn sm primary', onclick: () => go('acceptEdits') }, 'Yes, and edit automatically'),
      h('button', { class: 'btn sm', onclick: () => go('default') }, 'Yes, but ask before each edit'),
      h('div', { class: 'cc-row' }, why, h('button', { class: 'btn sm', onclick: () => answer(rid, { behavior: 'deny', message: why.value.trim() ? 'Keep planning. The user wants: ' + why.value.trim() : 'The user wants to keep planning.' }) }, 'Keep planning'))));
  perms.set(rid, card); scroller.append(card); stuck = true; stick();
}

// ---------------- composer ----------------
function autosize() { input.style.height = 'auto'; input.style.height = Math.min(220, input.scrollHeight) + 'px'; }

function onKey(e) {
  if (slashEl.style.display !== 'none') {
    const items = [...slashEl.querySelectorAll('.cc-sl-item')];
    let i = items.findIndex((x) => x.classList.contains('on'));
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); i = (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length; items.forEach((x, k) => x.classList.toggle('on', k === i)); items[i]?.scrollIntoView({ block: 'nearest' }); return; }
    const typed = input.value.trim().slice(1);
    const exact = e.key === 'Enter' && allCommands().some((c) => c.name === typed || c.aliases?.includes(typed));
    if (!exact && (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) && items[i]) { e.preventDefault(); items[i].click(); return; }
    if (exact) hideSlash();
    if (e.key === 'Escape') { e.preventDefault(); hideSlash(); return; }
  }
  if (e.key === 'Tab' && e.shiftKey) { e.preventDefault(); cycleMode(); return; }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  else if (e.key === '@') setTimeout(() => pickFile(true), 0);
  else if (e.key === 'Escape' && busy) { e.preventDefault(); interrupt(); }
  else if (e.key === 'Backspace' && !input.value && pending.length) { pending.pop(); renderChips(); }
}

function allCommands() {
  const seen = new Set(LOCAL.map((c) => c.name));
  return [...LOCAL.map((c) => ({ ...c, local: true })), ...commands.filter((c) => !seen.has(c.name) && seen.add(c.name))];
}
function slashMenu() {
  const m = /^\/(\S*)$/.exec(input.value);
  if (!m) return hideSlash();
  const q = m[1].toLowerCase();
  // exact name or alias first, then names that start with the text (shortest first), then the rest
  const rank = (c) => { const n = c.name.toLowerCase(); return n === q || c.aliases?.includes(q) ? 0 : n.startsWith(q) ? 1 + n.length / 1000 : 2; };
  const list = allCommands().filter((c) => c.name.toLowerCase().includes(q) || c.aliases?.some((a) => a.includes(q)))
    .sort((a, b) => rank(a) - rank(b)).slice(0, 60);
  clear(slashEl);
  if (!list.length) { slashEl.append(h('div', { class: 'muted sm cc-sl-empty' }, sid ? 'No matching command' : 'Loading commands…')); }
  list.forEach((c, k) => slashEl.append(h('button', { class: 'cc-sl-item' + (k === 0 ? ' on' : ''), onmousedown: (e) => e.preventDefault(), onclick: () => pickCommand(c) }, h('b', {}, '/' + c.name), c.argumentHint ? h('span', { class: 'muted' }, ' ' + c.argumentHint) : null, h('span', { class: 'muted sm ell' }, c.description || ''))));
  slashEl.style.display = '';
}
/** Run a command that takes no arguments; otherwise put "/name " in the box so the user can add them. */
function pickCommand(c) {
  hideSlash();
  if (c.local) { input.value = ''; autosize(); c.run(''); return; }
  if (!c.argumentHint) { send('/' + c.name); return; }
  input.value = '/' + c.name + ' '; autosize(); input.focus();
}
function hideSlash() { if (slashEl) slashEl.style.display = 'none'; }

function currentContext() {
  const ctx = [...pending];
  const f = E.activeFile();
  if (autoFile && f && !ctx.some((c) => c.path === f)) {
    const ed = E.getEditor(), s = ed?.getSelection();
    if (s && !s.isEmpty()) ctx.unshift({ type: 'selection', path: f, text: ed.getModel().getValueInRange(s), lines: `L${s.startLineNumber}-${s.endLineNumber}`, auto: true });
    else ctx.unshift({ type: 'file', path: f, auto: true });
  }
  return ctx;
}
function renderChips() {
  if (!chipsEl) return;
  clear(chipsEl);
  for (const c of currentContext()) {
    if (c.type === 'image') {
      chipsEl.append(h('span', { class: 'chip cc-imgchip', title: `${c.name} · ${(c.size / 1024).toFixed(0)} KB` }, h('img', { src: c.thumb }), c.name,
        h('button', { class: 'chip-x', onclick: () => { pending = pending.filter((x) => x !== c); renderChips(); } }, icon('close'))));
      continue;
    }
    const [lbl, col] = badgeOf(c.path);
    chipsEl.append(h('span', { class: 'chip' + (c.auto ? ' auto' : ''), title: c.auto ? 'Sent with your message as context (× to stop)' : c.path },
      h('span', { class: 'fbadge', style: { color: col } }, lbl), basename(c.path), c.lines ? h('span', { class: 'muted' }, ' ' + c.lines) : null,
      c.auto ? h('span', { class: 'muted' }, c.type === 'selection' ? ' · selection' : ' · current') : null,
      h('button', { class: 'chip-x', onclick: () => { if (c.auto) autoFile = false; else pending = pending.filter((x) => x !== c); renderChips(); } }, icon('close'))));
  }
  if (!autoFile && E.activeFile()) chipsEl.append(h('button', { class: 'chip add', onclick: () => { autoFile = true; renderChips(); } }, icon('plus'), 'current file'));
}
export function addFile(p) { if (!pending.some((c) => c.path === p)) pending.push({ type: 'file', path: p }); renderChips(); focus(); }

// ---------------- dropped and pasted files ----------------
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const isImage = (f) => IMAGE_TYPES.includes(f.type);
const MAX_SIDE = 2000, MAX_BYTES = 3.5e6; // the API takes ≤ 5 MB per image (base64 adds a third), and scales big ones down anyway

const readB64 = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = () => rej(r.error); r.readAsDataURL(blob); });

/** An image as the API wants it: base64 plus its type, shrunk to fit when it is too big. */
async function addImage(file) {
  let blob = file, media = file.type;
  const bmp = await createImageBitmap(file).catch(() => null);
  if (!bmp) throw new Error(`Could not read the image ${file.name || ''}`);
  const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  if (scale < 1 || file.size > MAX_BYTES) {
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(bmp, 0, 0, c.width, c.height);
    blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.88)); media = 'image/jpeg';
  }
  const t = document.createElement('canvas'), ts = 64 / Math.max(bmp.width, bmp.height);
  t.width = Math.max(1, Math.round(bmp.width * ts)); t.height = Math.max(1, Math.round(bmp.height * ts));
  t.getContext('2d').drawImage(bmp, 0, 0, t.width, t.height);
  bmp.close?.();
  pending.push({ type: 'image', name: file.name || 'pasted image', media, data: await readB64(blob), size: blob.size, thumb: t.toDataURL('image/png') });
  renderChips(); focus();
}

/** Drop on the panel: images are attached, other files and folders are @-mentioned. */
async function attachDropped(dt) {
  const inner = dt.getData('text/kestrel-path');
  if (inner) { addFile(inner); return; }
  for (const f of [...(dt.files || [])]) {
    const abs = window.ks.pathOf(f);
    const st = abs ? await window.ks.fs.statAbs(abs).catch(() => null) : null;
    if (isImage(f) && !st?.dir) await addImage(f);
    else if (abs) addFile(st?.rel ?? abs);
  }
}
async function pickFile(fromAt, inline) {
  const { pickFile: pf } = await import('../views/palette.js');
  const p = await pf(inline ? 'Mention a file' : 'Attach a file');
  if (fromAt && input.value.endsWith('@')) input.value = input.value.slice(0, -1);
  if (p && (inline || fromAt)) { input.value += (input.value && !/\s$/.test(input.value) ? ' ' : '') + '@' + p + ' '; autosize(); input.focus(); }
  else if (p) addFile(p); else input.focus();
}

// ---------------- mode, model, effort ----------------
const modelInfo = () => models.find((m) => m.value === (set('ccModel') || 'default'));
/** The chip shows the model the session is really using (from Claude Code), not just the saved choice. */
const modelName = () => {
  const cur = set('ccModel') || 'default', info = modelInfo(), live = S.cc?.model;
  if (live && (!info || info.resolvedModel !== live)) {
    const hit = models.find((m) => m.value !== 'default' && (m.resolvedModel === live || m.value === live));
    return hit?.displayName || live.replace(/^claude-/, '');
  }
  if (cur === 'default' && info?.resolvedModel) return models.find((m) => m.value !== 'default' && m.resolvedModel === info.resolvedModel)?.displayName || 'Default';
  return info?.displayName?.replace(/ \(.*\)$/, '') || cur;
};
const effortLevels = () => modelInfo()?.supportedEffortLevels || (models.length && !modelInfo()?.supportsEffort ? [] : EFFORTS.slice(0, 4));
const curEffort = () => set('ccEffort') || 'auto'; // auto = the model's own default

function renderBar() {
  if (!modeBtn) return;
  const md = MODES.find((m) => m.id === curMode()) || { id: curMode(), label: cap(curMode()), icon: 'alert' };
  clear(modeBtn); modeBtn.append(icon(md.icon), h('span', {}, md.label === 'Edit automatically' ? 'Edit auto' : md.label));
  modeBtn.className = 'cc-mode m-' + md.id; modeBtn.title = `${md.label} — ${md.hint || ''} (⇧Tab to switch)`;
  clear(modelBtn); modelBtn.append(h('span', { class: 'ell' }, modelName()), effortLevels().length ? h('span', { class: 'cc-chip-sub' }, cap(curEffort())) : null);
  modelBtn.title = 'Model and effort';
  clear(sendBtn); sendBtn.append(icon(busy ? 'stop' : 'send'));
  emit('status');
  sendBtn.classList.toggle('stop', busy); sendBtn.title = busy ? 'Stop (Esc) — or type to queue a message' : 'Send (↵)';
}

async function applyMode(id) {
  mode = id; saveSettings({ ccMode: id }); renderBar();
  if (sid) await window.ks.cc.setMode(sid, id).catch((e) => toast(e.message, 'error'));
}
function cycleMode() { const i = CYCLE.indexOf(curMode()); applyMode(CYCLE[(i + 1) % CYCLE.length]); }

async function applyEffort(level) {
  if (level === 'auto') level = null;
  await saveSettings({ ccEffort: level }); renderBar();
  if (sid) await window.ks.cc.setEffort(sid, level).catch((e) => toast(e.message, 'error'));
}
async function setEffortCmd(arg) {
  const level = arg.toLowerCase();
  if (level !== 'auto' && !EFFORTS.includes(level)) { note(`Unknown effort “${arg}”. Use one of: ${EFFORTS.join(', ')}, auto`, 'err'); return; }
  await applyEffort(level);
  note(level === 'auto' ? 'Effort: the model default' : `Effort set to ${level}`, 'muted');
}

/** Switch the model by its value ("sonnet"), its name ("Sonnet 5.5") or a full id, then keep the chip in sync. */
async function switchModel(arg) {
  try { await loadModels(); } catch { /* no session yet: the choice applies when it starts */ }
  const a = arg.trim(), lo = a.toLowerCase();
  const hit = models.find((m) => m.value === a) || models.find((m) => m.displayName?.toLowerCase() === lo || m.resolvedModel === a);
  const value = hit?.value || a;
  if (sid) {
    try { await window.ks.cc.setModel(sid, value); } catch (e) { note('Could not switch the model: ' + e.message, 'err'); return; }
  }
  await saveSettings({ ccModel: value });
  S.cc = { ...S.cc, model: hit?.resolvedModel || (value === 'default' ? null : value) };
  renderBar();
  if (!sid) note(`Model: ${modelName()}`, 'muted');
}
/** "Effort (Medium) ●○○○" — click a dot to set the level. */
function effortRow() {
  const levels = effortLevels();
  if (!levels.length) return null;
  const seg = h('div', { class: 'cc-seg' });
  const draw = () => {
    clear(seg);
    for (const l of ['auto', ...levels]) seg.append(h('button', { class: 'cc-seg-b' + (curEffort() === l ? ' on' : ''), title: l === 'auto' ? 'The model\'s own default' : `Effort: ${l}`,
      onclick: (e) => { e.stopPropagation(); applyEffort(l).then(draw); } }, l === 'xhigh' ? 'XHigh' : cap(l)));
  };
  draw();
  return h('div', { class: 'cc-eff' }, h('div', { class: 'cc-eff-h' }, icon('gauge'), h('span', {}, 'Effort'), h('span', { class: 'muted sm' }, 'how hard Claude thinks')), seg);
}

function modeMenu(anchor) {
  const pop = h('div', { class: 'cc-pop cc-modes' },
    h('div', { class: 'cc-pop-h' }, h('span', {}, 'Modes'), h('span', { class: 'muted sm' }, h('kbd', {}, '⇧'), ' + ', h('kbd', {}, 'tab'), ' to switch')),
    MODES.map((m) => h('button', { class: 'cc-mode-it' + (curMode() === m.id ? ' on' : ''), onclick: () => { closeMenu(); applyMode(m.id); } },
      icon(m.icon), h('span', { class: 'cc-mode-tx' }, h('b', {}, m.label), h('span', { class: 'muted sm' }, m.hint)), curMode() === m.id ? icon('check', 'cc-ok') : null)),
    effortLevels().length ? h('div', { class: 'cc-pop-sep' }) : null, effortRow());
  popover(pop, anchor, { class: 'cc-popover' });
}

async function loadModels() {
  if (models.length) return;
  await ensure(); models = await window.ks.cc.models(sid); renderBar();
}
async function modelMenu(anchor) {
  try { await loadModels(); } catch (e) { toast(e.message, 'error'); return; }
  const cur = set('ccModel') || 'default';
  const pop = h('div', { class: 'cc-pop' }, effortRow(), effortLevels().length ? h('div', { class: 'cc-pop-sep' }) : null,
    h('div', { class: 'cc-pop-h' }, h('span', {}, 'Model')),
    h('div', { class: 'cc-model-list' }, models.map((m) => h('button', { class: 'cc-row-it' + (m.value === cur ? ' on' : ''), title: m.description, onclick: () => { closeMenu(); switchModel(m.value); } }, h('span', { class: 'cc-nm' }, m.displayName), h('span', { class: 'muted sm ell' }, m.value === 'default' ? '' : m.description?.split('·')[0] || ''), h('span', { class: 'grow' }), m.value === cur ? icon('check', 'cc-ok') : null))));
  popover(pop, anchor, { class: 'cc-popover' });
  pop.querySelector('.cc-row-it.on')?.scrollIntoView({ block: 'nearest' });
}
export function openModelMenu(anchor) { return modelMenu(anchor || modelBtn); }
/** For the status bar: the Claude Code model and effort. */
export function statusModel() { return { name: modelName(), effort: effortLevels().length ? cap(curEffort()) : '' }; }

// ---------------- /context and /usage ----------------
async function infoDialog(title, load, view, fallback) {
  let data;
  try { await ensure(); data = await load(); } catch (e) { data = null; }
  if (!data) { if (fallback) send(fallback); return; }
  modal(title, view(data), [], { class: 'cc-info', closeX: true });
}
const showContext = () => infoDialog('Context usage', () => window.ks.cc.contextUsage(sid), contextView, null);
const showUsage = () => infoDialog('Account & Usage', async () => { const r = await window.ks.cc.usage(sid); return r?.usage || r?.account ? r : null; },
  (r) => usageView(r, { open: (u) => window.ks.shell.external(u), run: (t) => send(t) }), null);

/** The "/" button: filterable actions (Context, Model, Kestrel) plus every slash command. */
function actionsMenu(anchor) {
  ensure().then(() => { if (!models.length) window.ks.cc.models(sid).then((m) => { models = m || []; renderBar(); }).catch(() => {}); }).catch(() => {});
  const groups = () => [
    ['Context', [
      { label: 'Attach file…', icon: 'plus', run: () => pickFile() },
      { label: 'Mention file from this project…', icon: 'at', run: () => pickFile(false, true) },
      { label: 'Clear conversation', icon: 'trash', run: () => newSession() },
      { label: 'Rewind', icon: 'rewind', disabled: !turns.length, run: () => rewindMenu(actBtn) },
      { label: 'Past sessions…', icon: 'history', run: () => historyMenu(actBtn) },
      { label: 'Export conversation', icon: 'exportDoc', disabled: !transcript.length, run: () => exportChat() }]],
    ['Model', [
      { label: 'Switch model…', icon: 'sparkle', kbd: modelName(), run: () => modelMenu(actBtn) },
      { el: effortRow() }]],
    ['Slash commands', commands.map((c) => ({ label: '/' + c.name, sub: c.description, run: () => pickCommand(c) }))],
    ['Kestrel', [{ label: 'Use the claude CLI in a terminal', icon: 'terminal', run: () => exec('claude.view', 'terminal') }]],
  ];
  const filter = h('input', { class: 'cc-filter', placeholder: 'Filter actions…', spellcheck: 'false' });
  const list = h('div', { class: 'cc-act-list' });
  let flat = [], at = 0;
  const draw = () => {
    clear(list); flat = [];
    const q = filter.value.trim().toLowerCase().replace(/^\//, '');
    for (const [name, items] of groups()) {
      const vis = items.filter((it) => it.el ? !q : !q || it.label.toLowerCase().includes(q) || it.sub?.toLowerCase().includes(q));
      if (!vis.length) continue;
      list.append(h('div', { class: 'cc-pop-g' }, name));
      for (const it of vis.slice(0, q ? 40 : 200)) {
        if (it.el) { list.append(it.el); continue; }
        const i = flat.length;
        const row = h('button', { class: 'cc-row-it', disabled: it.disabled, onmouseenter: () => mark(i), onclick: () => { closeMenu(); it.run(); } },
          it.icon ? icon(it.icon) : null, h('span', { class: it.sub ? 'cc-mono' : '' }, it.label), it.sub ? h('span', { class: 'muted sm ell' }, it.sub) : null,
          h('span', { class: 'grow' }), it.kbd ? h('span', { class: 'muted sm' }, it.kbd) : null);
        flat.push(row); list.append(row);
      }
    }
    if (!flat.length) list.append(h('div', { class: 'muted sm cc-sl-empty' }, commands.length ? 'Nothing matches' : 'Loading commands…'));
    mark(0);
  };
  const mark = (i) => { at = Math.max(0, Math.min(flat.length - 1, i)); flat.forEach((r, k) => r.classList.toggle('on', k === at)); };
  filter.addEventListener('input', draw);
  filter.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); mark(at + (e.key === 'ArrowDown' ? 1 : -1)); flat[at]?.scrollIntoView({ block: 'nearest' }); }
    else if (e.key === 'Enter') { e.preventDefault(); flat[at]?.click(); }
    else if (e.key === 'Escape') { closeMenu(); input.focus(); }
  });
  draw();
  const pop = popover(h('div', { class: 'cc-pop cc-actions' }, filter, list), anchor, { class: 'cc-popover' });
  if (!commands.length) { const t = setInterval(() => { if (!pop.isConnected) return clearInterval(t); if (commands.length) { clearInterval(t); draw(); } }, 400); }
  requestAnimationFrame(() => filter.focus());
}

// ---------------- rewind + export ----------------
function rewindMenu(anchor) {
  if (busy) { toast('Stop Claude first (Esc)'); return; }
  const list = turns.filter((t) => t.node?.isConnected).slice().reverse();
  if (!list.length) { toast('Nothing to rewind yet'); return; }
  popupMenu([{ header: 'Rewind to before…' }, ...list.slice(0, 15).map((t) => ({ label: t.text.slice(0, 70), icon: 'rewind', onClick: () => rewindTo(t) }))], anchor);
}
async function rewindTo(t) {
  let files = null;
  if (sid && t.uuid) files = await window.ks.cc.rewind(sid, t.uuid, true).catch(() => null);
  const n = files?.canRewind ? (files.filesChanged || []).length : 0;
  const msg = n ? `Go back to before “${t.text.slice(0, 60)}”? ${n} file${n === 1 ? '' : 's'} will be restored (+${files.insertions || 0} −${files.deletions || 0}): ${files.filesChanged.map(rel).join(', ')}`
    : `Go back to before “${t.text.slice(0, 60)}”? The conversation goes back; no file changes need undoing.`;
  if (!(await confirm('Rewind', msg, 'Rewind'))) return;
  if (n) { const r = await window.ks.cc.rewind(sid, t.uuid, false).catch((e) => ({ error: e.message })); if (r?.error) toast('Files not restored: ' + r.error, 'error'); }
  const keepId = sessionId, at = t.prevAssistant;
  // drop everything from this message on, then continue the session from just before it
  const idx = turns.indexOf(t);
  let el = t.node; while (el) { const nx = el.nextSibling; el.remove(); el = nx; }
  turns = turns.slice(0, idx);
  const ti = transcript.findLastIndex((x) => x.role === 'user' && x.text === t.text); if (ti >= 0) transcript = transcript.slice(0, ti);
  if (sid) window.ks.cc.close(sid).catch(() => {});
  sid = null; setBusy(false); tools.clear(); perms.clear(); liveText = liveThink = null;
  resumeNext = keepId && at ? { id: keepId, at } : null;
  lastAssistant = at;
  if (!scroller.childNodes.length) scroller.append(emptyState());
  input.value = t.text; autosize(); input.focus();
  toast(n ? `Rewound — ${n} file${n === 1 ? '' : 's'} restored` : 'Rewound');
}

function exportChat() {
  if (!transcript.length) { toast('Nothing to export yet'); return; }
  const md = `# ${titleEl.textContent}\n\n` + transcript.map((x) => (x.role === 'user' ? '## You\n\n' : '## Claude\n\n') + x.text).join('\n\n') + '\n';
  window.ks.clip.copy(md); toast('Conversation copied as Markdown');
}

async function historyMenu(anchor) {
  let list = [];
  try { list = await window.ks.cc.list(); } catch (e) { toast(e.message, 'error'); return; }
  popupMenu([{ label: 'New session', icon: 'plus', onClick: () => newSession() }, list.length ? '-' : null,
    ...list.slice(0, 20).map((s) => ({ label: s.title.slice(0, 70), icon: 'chat', kbd: fmtRelative(s.updated).replace(' ago', ''), onClick: () => resumeSession(s) })),
    !list.length ? { label: 'No past sessions in this folder', disabled: true } : null].filter(Boolean), anchor);
}

function emptyState() {
  const ideas = [['Explain this project', 'Give me a short tour of this project: what it does and how the code is organised.'], ['Find bugs', 'Review the current file for bugs and edge cases, and fix the real ones.'],
    ['Write tests', 'Write tests for the current file and run them.'], ['/init', '/init']];
  return h('div', { class: 'chat-empty' },
    h('div', { class: 'claude-mark' }, icon('claude')),
    h('h3', {}, 'Claude Code'),
    h('p', { class: 'muted' }, 'The real Claude Code, with your login, settings, CLAUDE.md, skills and MCP servers. It reads and edits files in this folder and runs commands — asking first, depending on the mode.'),
    h('div', { class: 'ideas' }, ideas.map(([t, q]) => h('button', { class: 'idea', onclick: () => send(q) }, icon(t.startsWith('/') ? 'terminal' : 'sparkle'), t))),
    h('div', { class: 'muted sm cc-tipline' }, h('kbd', {}, '/'), ' commands · ', h('kbd', {}, '@'), ' files · ', h('kbd', {}, '⇧Tab'), ' mode · ', h('kbd', {}, 'esc'), ' stop'));
}
