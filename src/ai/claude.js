// Claude Code: runs the real `claude` CLI in a pane and answers its IDE requests
// (diffs to review, open file, selection, diagnostics) — the same protocol as the VS Code extension.
import { monaco } from '../editor/monaco.js';
import { S, set, saveSettings, on, emit, command, exec, basename } from '../state.js';
import { h, icon, clear, toast, debounce } from '../ui/h.js';
import * as E from '../editor/editors.js';
import { createTerminal } from '../views/terminal.js';
import * as GUI from './ccgui.js';

let host, termEl, card, bar, term = null, guiHost, cliHost;
const view = () => set('claudeView') || 'gui';

export function mount(el) {
  host = el;
  termEl = h('div', { class: 'claude-term' });
  card = h('div', { class: 'claude-card' });
  bar = h('div', { class: 'claude-bar' });
  guiHost = h('div', { class: 'cc-gui' });
  cliHost = h('div', { class: 'cc-cli' }, card, bar, termEl);
  el.append(guiHost, cliHost);
  GUI.mount(guiHost);
  on('ide', renderCard);
  renderCard();
  applyView();
}

function applyView() {
  guiHost.style.display = view() === 'gui' ? '' : 'none';
  cliHost.style.display = view() === 'gui' ? 'none' : '';
}
export function setView(v) {
  saveSettings({ claudeView: v }); applyView();
  exec('layout.chat', true, 'claude');
  if (v === 'gui') GUI.focus(); else if (running()) focus();
}

export const running = () => !!term && !term.exited;

function renderCard() {
  if (!card) return;
  const live = running();
  const showTerm = !!term; // keep the output of an exited session readable
  card.style.display = showTerm ? 'none' : '';
  termEl.style.display = showTerm ? '' : 'none';
  bar.style.display = term && !live ? '' : 'none';
  clear(bar);
  if (term && !live) bar.append(icon('alert'), h('span', {}, 'Claude Code exited.'), h('span', { class: 'grow' }),
    h('button', { class: 'btn xs', onclick: () => { term.dispose(); term = null; clear(termEl); renderCard(); } }, 'Close'),
    h('button', { class: 'btn xs primary', onclick: () => start() }, 'Restart'));
  if (showTerm) return;
  clear(card);
  card.append(
    h('div', { class: 'claude-hero' }, h('div', { class: 'claude-mark' }, icon('claude')), h('h3', {}, 'Claude Code'),
      h('p', { class: 'muted' }, 'Runs the official claude CLI right here, connected to the editor: proposed edits open as diffs you accept or reject, and Claude sees your current selection.')),
    h('button', { class: 'btn primary wide', onclick: () => start() }, icon('play'), term?.exited ? 'Restart Claude Code' : 'Start Claude Code', h('span', { class: 'kbd' }, '⌘Esc')),
    h('div', { class: 'claude-facts' },
      fact(S.ide.port ? 'ok' : 'bad', S.ide.port ? `Editor bridge ready on port ${S.ide.port}` : 'Editor bridge is not running'),
      fact(S.ide.connected ? 'ok' : 'idle', S.ide.connected ? 'Claude Code is connected' : 'Waiting for Claude Code to connect'),
      fact('idle', h('span', {}, 'From another terminal, run ', h('code', {}, '/ide'), ' inside claude and pick Kestrel.'))),
    h('div', { class: 'claude-tips' },
      h('div', { class: 'tip' }, h('kbd', {}, '⌥⌘K'), h('span', {}, 'send the selection to Claude as an @-mention')),
      h('div', { class: 'tip' }, h('kbd', {}, '⇧↵'), h('span', {}, 'new line in the Claude prompt')),
      h('div', { class: 'tip muted sm' }, h('a', { href: '#', onclick: (e) => { e.preventDefault(); setView('gui'); } }, '← Back to the Claude Code panel'), ' (same features, with buttons and diffs)'),
      h('div', { class: 'tip muted sm' }, 'Not installed? ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); window.ks.shell.external('https://docs.claude.com/en/docs/claude-code/setup'); } }, 'Install Claude Code'), '. Change the command in Settings → Claude Code.')));
}
const fact = (st, text) => h('div', { class: 'fact ' + st }, h('span', { class: 'fdot' }), h('span', {}, text));

export async function start(forceTerminal) {
  if (!S.ws) { toast('Open a folder first'); return; }
  exec('layout.chat', true, 'claude');
  if (view() === 'gui' && !forceTerminal) { GUI.toggleFocus(); return; }
  if (view() !== 'terminal') { saveSettings({ claudeView: 'terminal' }); applyView(); }
  if (running()) { term.focus(); return; }
  term?.dispose(); clear(termEl);
  card.style.display = 'none'; termEl.style.display = '';
  term = await createTerminal(termEl, { command: set('claudeCommand') || 'claude', onExit: () => renderCard() });
  renderCard();
  requestAnimationFrame(() => { term.fit(); term.focus(); });
}
export function stop() { term?.dispose(); term = null; clear(termEl); renderCard(); GUI.newSession(); }
export function focus() { if (view() === 'gui') return GUI.focus(); if (running()) requestAnimationFrame(() => { term.fit(); term.focus(); }); }

// ---------------- the IDE side of the protocol ----------------
const absOf = (rel) => S.ws.root + '/' + rel;
const relOf = (abs) => { const p = String(abs || '').replace(/^file:\/\//, ''); return S.ws && p.startsWith(S.ws.root + '/') ? decodeURIComponent(p.slice(S.ws.root.length + 1)) : null; };

function selectionPayload() {
  const ed = E.getEditor(), f = E.activeFile();
  if (!f || !ed?.getModel()) return null;
  const s = ed.getSelection();
  return {
    text: s && !s.isEmpty() ? ed.getModel().getValueInRange(s) : '',
    filePath: absOf(f), fileUrl: monaco.Uri.file(absOf(f)).toString(),
    selection: { start: { line: s.startLineNumber - 1, character: s.startColumn - 1 }, end: { line: s.endLineNumber - 1, character: s.endColumn - 1 }, isEmpty: s.isEmpty() },
  };
}
let latest = null;
const sendSelection = debounce(() => {
  const p = selectionPayload();
  if (!p) return;
  latest = p;
  if (S.ide.connected) window.ks.ide.notify('selection_changed', p);
}, 120);
on('selection', sendSelection);
on('active', sendSelection);

const SEV = { 8: 'Error', 4: 'Warning', 2: 'Information', 1: 'Hint' };
function diagnostics(uri) {
  const rel = uri ? relOf(uri) : null;
  const markers = monaco.editor.getModelMarkers(rel ? { resource: monaco.Uri.file(absOf(rel)) } : {}).filter((m) => m.resource.scheme === 'file');
  const by = new Map();
  if (rel) by.set(monaco.Uri.file(absOf(rel)).toString(), []);
  for (const m of markers) {
    const k = m.resource.toString();
    if (!by.has(k)) by.set(k, []);
    by.get(k).push({ message: m.message, severity: SEV[m.severity] || 'Information', source: m.source || m.owner, code: typeof m.code === 'object' ? m.code?.value : m.code,
      range: { start: { line: m.startLineNumber - 1, character: m.startColumn - 1 }, end: { line: m.endLineNumber - 1, character: m.endColumn - 1 } } });
  }
  return [...by].map(([uri, diagnostics]) => ({ uri, diagnostics }));
}

const diffCalls = new Map(); // tab_name → { tabId, resolve }

const handlers = {
  async openDiff({ old_file_path, new_file_path, new_file_contents, tab_name }) {
    const path = new_file_path || old_file_path;
    const rel = relOf(path);
    let original = '';
    if (rel) { const d = E.docs.get(rel); original = d?.model ? d.model.getValue() : ((await window.ks.fs.read(rel).catch(() => null))?.text ?? ''); }
    else original = await window.ks.fs.readAbs(old_file_path).catch(() => '');
    return new Promise((resolve) => {
      const id = 'claude:' + tab_name;
      let done = false;
      const finish = (r) => { if (done) return; done = true; diffCalls.delete(tab_name); resolve(r); };
      E.openDiff({
        id, title: basename(path), sub: original ? 'Claude Code · proposed edit' : 'Claude Code · new file', badge: 'CC', path: rel || path, original, modified: new_file_contents,
        onClose: () => finish(['DIFF_REJECTED', tab_name]),
        actions: [
          { label: 'Reject', icon: 'x', title: 'Tell Claude no', run: (t) => { finish(['DIFF_REJECTED', tab_name]); E.close(t.id, { force: true }); exec('claude.focus'); } },
          { label: 'Accept', icon: 'check', primary: true, title: 'Accept — Claude Code writes the file (⌘S). You can edit the right side first.', run: (t) => {
            finish(['FILE_SAVED', t.modified.getValue()]); E.close(t.id, { force: true }); exec('claude.focus');
          } }],
      });
      diffCalls.set(tab_name, { tabId: id, finish });
    });
  },
  async openFile({ filePath, startText, endText }) {
    const rel = relOf(filePath);
    if (!rel) return { success: false, error: 'File is outside the workspace' };
    await E.open(rel, { pin: true });
    if (startText) {
      const model = E.getEditor().getModel();
      const a = model.findNextMatch(startText, { lineNumber: 1, column: 1 }, false, true, null, false);
      if (a) {
        let range = a.range;
        if (endText) { const b = model.findNextMatch(endText, a.range.getEndPosition(), false, true, null, false); if (b) range = new monaco.Range(a.range.startLineNumber, a.range.startColumn, b.range.endLineNumber, b.range.endColumn); }
        E.getEditor().setSelection(range); E.getEditor().revealRangeInCenter(range);
      }
    }
    return { success: true, filePath };
  },
  getDiagnostics: ({ uri }) => diagnostics(uri),
  getCurrentSelection: () => selectionPayload() || { success: false, message: 'No active editor' },
  getLatestSelection: () => latest || selectionPayload() || { success: false, message: 'No selection yet' },
  getOpenEditors: () => ({ tabs: E.tabs.filter((t) => t.kind === 'file').map((t) => ({ uri: monaco.Uri.file(absOf(t.path)).toString(), isActive: t.id === E.activeTab()?.id, label: t.title, languageId: E.docs.get(t.path)?.model?.getLanguageId(), isDirty: E.isDirty(t.path) })) }),
  checkDocumentDirty: ({ filePath }) => { const rel = relOf(filePath); return rel && E.docs.has(rel) ? { success: true, filePath, isDirty: E.isDirty(rel), isUntitled: false } : { success: false, message: 'Document not open' }; },
  saveDocument: async ({ filePath }) => { const rel = relOf(filePath); if (!rel || !E.docs.has(rel)) return { success: false, message: 'Document not open' }; await E.save(rel); return { success: true, filePath, saved: true }; },
  close_tab: ({ tab_name }) => { const c = diffCalls.get(tab_name); if (c) E.close(c.tabId, { force: true }); else { const t = E.tabs.find((x) => x.title === tab_name || x.path === relOf(tab_name)); if (t) E.close(t.id); } return 'TAB_CLOSED'; },
  closeAllDiffTabs: () => { const list = E.tabs.filter((t) => t.id.startsWith('claude:')); list.forEach((t) => E.close(t.id, { force: true })); return `CLOSED_${list.length}_DIFF_TABS`; },
};

window.ks.ide.onCall(async (id, tool, args) => {
  try { window.ks.ide.reply(id, true, await handlers[tool](args || {})); }
  catch (e) { window.ks.ide.reply(id, false, e.message || String(e)); }
});
window.ks.ide.onCancel(() => { /* the diff tab stays open; closing it is harmless once the call is gone */ });
window.ks.ide.onStatus((s) => {
  const was = S.ide.connected;
  S.ide = { ...S.ide, ...s };
  emit('ide', S.ide);
  if (s.connected && !was) { toast('Claude Code connected to Kestrel'); sendSelection(); }
});

export function mention(path) {
  const ed = E.getEditor();
  const f = path || E.activeFile();
  if (!f) return;
  const s = !path || path === E.activeFile() ? ed.getSelection() : null;
  if (view() === 'gui') { exec('layout.chat', true, 'claude'); if (path && path !== E.activeFile()) GUI.addFile(path); else GUI.focus(); return; }
  const params = { filePath: absOf(f) };
  if (s && !s.isEmpty()) { params.lineStart = s.startLineNumber - 1; params.lineEnd = s.endLineNumber - 1; }
  if (!S.ide.connected) {
    // not connected yet: start Claude and type the mention instead
    const ref = '@' + f + (params.lineStart != null ? `#L${params.lineStart + 1}-${params.lineEnd + 1}` : '') + ' ';
    start().then(() => setTimeout(() => term?.write(ref), 1500));
    return;
  }
  window.ks.ide.notify('at_mentioned', params);
  exec('layout.chat', true, 'claude'); focus();
}

command('claude.start', 'Claude Code: Launch', () => start());
command('claude.focus', 'Claude Code: Focus', () => { exec('layout.chat', true, 'claude'); focus(); });
command('claude.mention', 'Claude Code: Send Selection / File', (p) => mention(p));
command('claude.restart', 'Claude Code: Restart', () => { stop(); start(); });
command('claude.view', 'Claude Code: Switch Panel / Terminal', (v) => setView(v || (view() === 'gui' ? 'terminal' : 'gui')));
command('claude.terminal', 'Claude Code: Open in Terminal (CLI)', () => { setView('terminal'); start(true); });
command('claude.model', 'Claude Code: Choose Model and Effort…', (anchor) => { setView('gui'); exec('layout.chat', true, 'claude'); requestAnimationFrame(() => GUI.openModelMenu(anchor)); });
/** What the status bar shows while the Claude Code panel is in front (null: show the Chat model). */
export function statusModel() { return view() === 'gui' ? GUI.statusModel() : null; }
command('claude.new', 'Claude Code: New Session', () => { setView('gui'); GUI.newSession(); GUI.focus(); });
