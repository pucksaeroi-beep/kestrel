// Kestrel renderer entry: layout, welcome screen, status bar, menus, key bindings and boot.
import './styles/app.css';
import { S, set, saveSettings, on, emit, command, exec, commands } from './state.js';
import { h, icon, clear, toast, debounce, popupMenu, fmtRelative } from './ui/h.js';
import { monaco } from './editor/monaco.js';
import * as E from './editor/editors.js';
import * as Explorer from './views/explorer.js';
import { mountSearch, mountScm } from './views/search.js';
import * as Term from './views/terminal.js';
import { quickOpen, commandPalette, ensureFiles } from './views/palette.js';
import './views/settings.js';
import * as Chat from './ai/chat.js';
import * as Claude from './ai/claude.js';
import { setupAutocomplete } from './ai/inline.js';
import { loadProviders, shortModel, providerName, chatTarget } from './ai/ai.js';

const $app = document.getElementById('app');
let ui = {};

// ---------------- layout ----------------
function buildShell() {
  clear($app);
  const views = [['explorer', 'explorer', 'Explorer (⇧⌘E)'], ['search', 'search', 'Search (⇧⌘F)'], ['scm', 'scm', 'Source Control (⌃⇧G)']];
  ui.activity = h('div', { class: 'activity' },
    views.map(([id, ic, tip]) => h('button', { class: 'act', dataset: { view: id }, title: tip, onclick: () => (S.layout.view === id && S.layout.sidebar ? exec('layout.sidebar', false) : exec('view.show', id)) }, icon(ic), id === 'scm' ? h('span', { class: 'act-badge' }) : null)),
    h('div', { class: 'grow' }),
    h('button', { class: 'act', title: 'Claude Code (⌘Esc)', onclick: () => exec('claude.start') }, icon('claude')),
    h('button', { class: 'act', title: 'Settings (⌘,)', onclick: () => exec('settings.open') }, icon('settings')));
  ui.views = {};
  ui.sidebar = h('div', { class: 'sidebar' });
  for (const [id] of views) { ui.views[id] = h('div', { class: 'view', dataset: { view: id } }); ui.sidebar.append(ui.views[id]); }
  ui.editorArea = h('div', { class: 'editor-area' });
  ui.panel = h('div', { class: 'panel' });
  ui.center = h('div', { class: 'center' }, ui.editorArea, h('div', { class: 'resizer h', dataset: { r: 'panel' } }), ui.panel);
  ui.right = h('div', { class: 'right' });
  ui.titlebar = h('div', { class: 'titlebar' },
    h('div', { class: 'tb-left' }, h('button', { class: 'ibtn', title: 'Toggle Sidebar (⌘B)', onclick: () => exec('layout.sidebar') }, icon('layoutLeft'))),
    h('button', { class: 'tb-search', onclick: () => quickOpen() }, icon('search'), h('span', { class: 'tb-ws' }, S.ws.name), h('span', { class: 'muted' }, '— search files, run > commands'), h('span', { class: 'kbd' }, '⌘P')),
    h('div', { class: 'tb-right' },
      h('button', { class: 'ibtn', title: 'Toggle Panel (⌘J)', onclick: () => exec('terminal.toggle') }, icon('layoutBottom')),
      h('button', { class: 'ibtn', title: 'Toggle AI Pane (⌥⌘B)', onclick: () => exec('layout.chat') }, icon('layoutRight'))));
  ui.status = h('div', { class: 'statusbar' });
  $app.append(ui.titlebar, h('div', { class: 'main' }, ui.activity, ui.sidebar, h('div', { class: 'resizer v', dataset: { r: 'sidebar' } }), ui.center, h('div', { class: 'resizer v', dataset: { r: 'right' } }), ui.right), ui.status);

  // right pane: AI chat | Claude Code
  ui.rightTabs = h('div', { class: 'rp-tabs' });
  ui.chatHost = h('div', { class: 'rp-body', dataset: { pane: 'chat' } });
  ui.claudeHost = h('div', { class: 'rp-body', dataset: { pane: 'claude' } });
  ui.right.append(h('div', { class: 'rp-head' }, ui.rightTabs, h('div', { class: 'rp-actions' },
    h('button', { class: 'ibtn', title: 'New Chat (⌥⌘N)', onclick: () => exec('chat.new') }, icon('plus')),
    h('button', { class: 'ibtn', title: 'Chat History', onclick: (e) => Chat.historyMenu(e.currentTarget) }, icon('history')),
    h('button', { class: 'ibtn', title: 'Close (⌥⌘B)', onclick: () => exec('layout.chat', false) }, icon('close')))), ui.chatHost, ui.claudeHost);

  E.mount(ui.editorArea);
  Explorer.mount(ui.views.explorer);
  mountSearch(ui.views.search);
  mountScm(ui.views.scm);
  Term.mountPanel(ui.panel);
  Chat.mount(ui.chatHost);
  Claude.mount(ui.claudeHost);
  setupResizers();
  applyLayout();
  renderStatus();
}

function applyLayout() {
  const L = S.layout;
  document.body.classList.toggle('no-sidebar', !L.sidebar);
  document.body.classList.toggle('no-panel', !L.panel);
  document.body.classList.toggle('no-right', !L.chat);
  document.documentElement.style.setProperty('--sidebar-w', (L.sidebarW || 260) + 'px');
  document.documentElement.style.setProperty('--right-w', (L.rightW || 420) + 'px');
  document.documentElement.style.setProperty('--panel-h', (L.panelH || 260) + 'px');
  for (const b of ui.activity.querySelectorAll('.act[data-view]')) b.classList.toggle('on', L.sidebar && b.dataset.view === L.view);
  for (const v of Object.values(ui.views)) v.style.display = v.dataset.view === L.view ? '' : 'none';
  const pane = L.pane || 'chat';
  ui.chatHost.style.display = pane === 'chat' ? '' : 'none';
  ui.claudeHost.style.display = pane === 'claude' ? '' : 'none';
  clear(ui.rightTabs);
  ui.rightTabs.append(
    h('button', { class: 'rp-tab' + (pane === 'chat' ? ' on' : ''), onclick: () => exec('layout.chat', true, 'chat') }, icon('sparkle'), 'Chat'),
    h('button', { class: 'rp-tab' + (pane === 'claude' ? ' on' : ''), onclick: () => { exec('layout.chat', true, 'claude'); Claude.focus(); } }, icon('claude'), 'Claude Code', S.ide.connected ? h('span', { class: 'live-dot' }) : null));
  ui.right.querySelector('.rp-actions').style.visibility = pane === 'chat' ? '' : 'hidden';
  E.saveSessionLater();
}

function setupResizers() {
  for (const r of document.querySelectorAll('.resizer')) {
    r.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const kind = r.dataset.r, L = S.layout;
      const start = { x: e.clientX, y: e.clientY, sw: L.sidebarW || 260, rw: L.rightW || 420, ph: L.panelH || 260 };
      document.body.classList.add('resizing', kind === 'panel' ? 'rs-h' : 'rs-v');
      const move = (ev) => {
        if (kind === 'sidebar') L.sidebarW = Math.max(170, Math.min(560, start.sw + ev.clientX - start.x));
        if (kind === 'right') L.rightW = Math.max(300, Math.min(900, start.rw - (ev.clientX - start.x)));
        if (kind === 'panel') L.panelH = Math.max(100, Math.min(innerHeight - 200, start.ph - (ev.clientY - start.y)));
        applyLayout();
      };
      const up = () => { document.body.classList.remove('resizing', 'rs-h', 'rs-v'); removeEventListener('mousemove', move); removeEventListener('mouseup', up); };
      addEventListener('mousemove', move); addEventListener('mouseup', up);
    });
  }
}

// ---------------- status bar ----------------
function renderStatus() {
  if (!ui.status) return;
  clear(ui.status);
  const ed = E.getEditor(), t = E.activeTab();
  const markers = monaco.editor.getModelMarkers({}).filter((m) => m.resource.scheme === 'file');
  const errs = markers.filter((m) => m.severity === 8).length, warns = markers.filter((m) => m.severity === 4).length;
  const { provider, model } = chatTarget();
  const left = h('div', { class: 'sb-left' },
    S.git ? h('button', { class: 'sb-item', title: 'Source Control', onclick: () => exec('view.show', 'scm') }, icon('branch'), S.git.branch || 'HEAD', Object.keys(S.git.files).length ? h('span', { class: 'sb-dim' }, ` · ${Object.keys(S.git.files).length}`) : null) : null,
    h('button', { class: 'sb-item', title: 'Problems in open files', onclick: () => E.getEditor().getAction('editor.action.marker.next')?.run() }, icon('x', 'sb-err'), String(errs), icon('alert', 'sb-warn'), String(warns)),
    h('button', { class: 'sb-item' + (S.ide.connected ? ' claude-on' : ''), title: S.ide.connected ? 'Claude Code is connected' : 'Launch Claude Code (⌘Esc)', onclick: () => exec('claude.start') }, icon('claude'), S.ide.connected ? 'Claude Code' : 'Claude Code · off'));
  const right = h('div', { class: 'sb-right' });
  if (t?.kind === 'file' && ed.getModel()) {
    const p = ed.getPosition(), s = ed.getSelection();
    const selLen = s && !s.isEmpty() ? ed.getModel().getValueLengthInRange(s) : 0;
    right.append(
      h('button', { class: 'sb-item', onclick: () => exec('editor.gotoLine') }, `Ln ${p.lineNumber}, Col ${p.column}`, selLen ? ` (${selLen} selected)` : ''),
      h('span', { class: 'sb-item' }, `Spaces: ${ed.getModel().getOptions().tabSize}`),
      h('span', { class: 'sb-item' }, 'UTF-8'),
      h('span', { class: 'sb-item' }, ed.getModel().getLanguageId()));
  }
  right.append(
    h('button', { class: 'sb-item' + (set('autocomplete') ? ' on' : ''), title: 'AI autocomplete', onclick: () => exec('ai.toggleAutocomplete') }, icon('wand'), set('autocomplete') ? 'Tab' : 'Tab off'),
    h('button', { class: 'sb-item ai', title: `${providerName(provider)} · ${model}`, onclick: () => exec('chat.model') }, icon('sparkle'), shortModel(model)));
  ui.status.append(left, right);
}

// ---------------- git ----------------
const refreshGit = debounce(async () => {
  if (!S.ws) return;
  S.git = await window.ks.git.status().catch(() => null);
  emit('git');
  const badge = ui.activity?.querySelector('.act-badge');
  if (badge) { const n = S.git ? Object.keys(S.git.files).length : 0; badge.textContent = n ? (n > 99 ? '99+' : n) : ''; badge.style.display = n ? '' : 'none'; }
  renderStatus();
}, 300);

// ---------------- welcome ----------------
function welcome() {
  clear($app);
  document.body.className = 'welcome-mode';
  const recent = S.recent.slice(0, 8);
  $app.append(h('div', { class: 'welcome' },
    h('div', { class: 'wl-drag' }),
    h('div', { class: 'wl-card' },
      h('img', { class: 'wl-logo', src: './logo.svg', alt: '' }),
      h('h1', {}, 'Kestrel'),
      h('p', { class: 'muted' }, 'Fast like Cursor. Open like VS Code. Your keys, any model — and Claude Code built in.'),
      h('div', { class: 'wl-actions' },
        h('button', { class: 'btn primary lg', onclick: openFolder }, icon('folderOpen'), 'Open Folder…', h('span', { class: 'kbd' }, '⌘O')),
        h('button', { class: 'btn lg', onclick: () => exec('settings.open', 'models') }, icon('key'), 'Add API Keys')),
      recent.length ? h('div', { class: 'wl-recent' }, h('div', { class: 'wl-sec' }, 'Recent'),
        recent.map((r) => h('button', { class: 'wl-item', onclick: () => openPath(r), oncontextmenu: (e) => { e.preventDefault(); popupMenu([{ label: 'Remove from Recent', icon: 'trash', onClick: async () => { await window.ks.ws.forget(r); S.recent = S.recent.filter((x) => x !== r); welcome(); } }], e); } },
          icon('explorer'), h('b', {}, r.split('/').pop()), h('span', { class: 'muted ell' }, r.replace(S.home, '~'))))) : null,
      h('div', { class: 'wl-foot muted sm' }, h('span', {}, 'Drop a folder here to open it'), h('span', {}, `v${S.version}`)))));
}

async function openFolder() { try { const info = await window.ks.ws.pick(); if (info) enter(info); } catch (e) { toast(e.message, 'error'); } }
async function openPath(p) {
  if (S.ws && !(await leaveWorkspace())) return;
  try { enter(await window.ks.ws.open(p)); } catch (e) { toast(e.message, 'error'); }
}
async function leaveWorkspace() {
  if (!(await E.closeAll())) return false;
  Term.killAll(); Claude.stop(); E.reset();
  S.ws = null; S.files = null; S.git = null;
  return true;
}

async function enter(info) {
  S.ws = info;
  S.files = null;
  S.recent = [info.root, ...S.recent.filter((r) => r !== info.root)];
  if (info.session?.layout) S.layout = { ...S.layout, ...info.session.layout };
  document.body.className = '';
  buildShell();
  refreshGit();
  ensureFiles();
  if (S.layout.panel) Term.panelShown();
  await E.restore(info.session);
  if (!E.tabs.length) { const readme = (await ensureFiles()).find((f) => /^readme\.md$/i.test(f)); if (readme) E.open(readme, { pin: true, focus: false }); }
}

// ---------------- commands ----------------
command('view.show', 'View: Show', (v) => { S.layout.view = v; S.layout.sidebar = true; applyLayout(); if (v === 'explorer') requestAnimationFrame(() => document.querySelector('.tree')?.focus()); }, { hidden: true });
command('view.explorer', 'View: Show Explorer', () => exec('view.show', 'explorer'));
command('view.search', 'View: Show Search', () => exec('search.focus'));
command('view.scm', 'View: Show Source Control', () => exec('view.show', 'scm'));
command('layout.sidebar', 'View: Toggle Sidebar', (v) => { S.layout.sidebar = v ?? !S.layout.sidebar; applyLayout(); });
command('layout.panel', 'View: Toggle Panel', (v) => { const was = S.layout.panel; S.layout.panel = v ?? !S.layout.panel; applyLayout(); if (S.layout.panel && !was) Term.panelShown(); if (!S.layout.panel) E.getEditor()?.focus(); });
command('layout.chat', 'View: Toggle AI Pane', (v, pane) => { S.layout.chat = v ?? !S.layout.chat; if (pane) S.layout.pane = pane; applyLayout(); if (S.layout.chat && S.layout.pane === 'claude') Claude.focus(); });
command('workspace.open', 'File: Open Folder…', () => openFolder());
command('workspace.close', 'File: Close Folder', async () => { if (await leaveWorkspace()) { await window.ks.ws.close(); welcome(); } });
command('workspace.reveal', 'File: Reveal Active File in Finder', () => { const f = E.activeFile(); window.ks.shell.reveal(f || '.'); });
command('git.refresh', 'Git: Refresh', () => refreshGit());
command('theme.toggle', 'Preferences: Toggle Light/Dark Theme', () => saveSettings({ theme: set('theme') === 'light' ? 'dark' : 'light' }));
command('zoom.in', 'View: Zoom In', () => saveSettings({ fontSize: Math.min(28, set('fontSize') + 1), terminalFontSize: Math.min(24, set('terminalFontSize') + 1) }));
command('zoom.out', 'View: Zoom Out', () => saveSettings({ fontSize: Math.max(9, set('fontSize') - 1), terminalFontSize: Math.max(9, set('terminalFontSize') - 1) }));
command('zoom.reset', 'View: Reset Zoom', () => saveSettings({ fontSize: 13.5, terminalFontSize: 12.5 }));
command('help.keys', 'Help: Keyboard Shortcuts', () => E.closeAll && toast('⌘P files · ⇧⌘P commands · ⌘L chat · ⌘K edit with AI · ⌘Esc Claude Code · ⌃` terminal', '', 6000));

// menu id → command
const MENU = {
  'new-file': 'explorer.newFile', open: 'workspace.open', save: 'file.save', 'save-all': 'file.saveAll', 'close-tab': 'file.close', 'close-folder': 'workspace.close', reveal: 'workspace.reveal',
  find: 'editor.find', replace: 'editor.replace', search: 'search.focus', palette: 'palette.commands', 'quick-open': 'palette.files', explorer: 'view.explorer', scm: 'view.scm',
  'toggle-sidebar': 'layout.sidebar', 'toggle-terminal': 'terminal.toggle', 'toggle-panel': 'terminal.toggle', 'toggle-chat': 'layout.chat',
  'zoom-in': 'zoom.in', 'zoom-out': 'zoom.out', 'zoom-reset': 'zoom.reset', 'goto-line': 'editor.gotoLine', 'goto-symbol': 'editor.gotoSymbol', 'goto-def': 'editor.gotoDef',
  'next-tab': 'tab.next', 'prev-tab': 'tab.prev', chat: 'chat.focus', 'chat-add': 'chat.addSelection', 'inline-edit': 'ai.inlineEdit', 'chat-new': 'chat.new',
  'toggle-autocomplete': 'ai.toggleAutocomplete', claude: 'claude.start', 'claude-mention': 'claude.mention', settings: 'settings.open', 'settings-models': 'settings.models',
};
const NEEDS_WS = new Set(['explorer.newFile', 'file.save', 'file.saveAll', 'file.close', 'search.focus', 'palette.files', 'view.explorer', 'view.scm', 'layout.sidebar', 'terminal.toggle', 'layout.chat', 'chat.focus', 'chat.addSelection', 'ai.inlineEdit', 'chat.new', 'claude.start', 'claude.mention', 'workspace.close', 'workspace.reveal', 'editor.gotoLine', 'editor.gotoSymbol', 'tab.next', 'tab.prev']);

window.ks.app.onMenu((cmd, arg) => {
  if (cmd === 'open-path') return openPath(arg);
  if (cmd === 'undo' || cmd === 'redo') return undoRedo(cmd);
  const id = MENU[cmd];
  if (!id) return;
  if (!S.ws && NEEDS_WS.has(id)) return;
  // ⌘F/⌘W etc. typed inside an input should behave natively
  if ((id === 'editor.find') && document.activeElement?.closest('.chat-input, .pal, .settings, .xterm')) return;
  exec(id);
});

function undoRedo(cmd) {
  const a = document.activeElement;
  if (a && (a.tagName === 'INPUT' || (a.tagName === 'TEXTAREA' && !a.closest('.monaco-editor')))) { document.execCommand(cmd); return; }
  const t = E.activeTab();
  const ed = t?.kind === 'diff' ? E.getDiffEditor().getModifiedEditor() : E.getEditor();
  ed?.trigger('menu', cmd, null);
  ed?.focus();
}

// Monaco eats some keys; route app-level ones through.
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.querySelector('.pal-back, .modal-back')) return;
  if (e.metaKey && e.altKey && e.code === 'KeyZ') { e.preventDefault(); exec('view.wordWrap'); }
}, true);

// ---------------- boot ----------------
async function boot() {
  const st = await window.ks.app.state();
  Object.assign(S, { settings: st.settings, recent: st.recent, home: st.home, version: st.version, ide: st.ide });
  await loadProviders().catch(() => {});
  monaco.editor.setTheme(E.themeName());
  setupAutocomplete();
  on('settings', () => { document.documentElement.dataset.theme = E.themeName() === 'kestrel-dark' ? 'dark' : 'light'; renderStatus(); });
  document.documentElement.dataset.theme = E.themeName() === 'kestrel-dark' ? 'dark' : 'light';
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => emit('settings', {}));
  on('active', renderStatus); on('status', renderStatus); on('markers', debounce(renderStatus, 200)); on('providers', renderStatus);
  on('ide', () => { renderStatus(); if (ui.rightTabs) applyLayout(); });
  on('saved', () => refreshGit());

  window.ks.fs.onChanged((list) => {
    if (!S.ws) return;
    if (list.some((f) => !f || !f.startsWith('.git/'))) { E.onFsChanged(list.filter((f) => !f.startsWith('.git/'))); Explorer.changed(list.filter((f) => !f.startsWith('.git/'))); }
    if (list.some((f) => !f.startsWith('.git/') || /^\.git\/(HEAD|index)$/.test(f))) refreshGit();
    if (list.some((f) => f && !f.startsWith('.git/'))) S.files = null;
  });
  window.ks.app.onFocus(() => { if (S.ws) { refreshGit(); E.onFsChanged([]); } });
  window.ks.app.onBeforeClose(async () => {
    const dirty = E.dirtyPaths();
    if (dirty.length && (await E.confirmSave(dirty)) === 'cancel') return;
    window.ks.app.closeNow();
  });
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer.files?.[0];
    const p = f && window.ks.pathOf(f);
    if (p && !e.target.closest?.('.xterm, .tree')) openPath(p);
  });

  if (st.workspace) await enter(st.workspace); else welcome();
  window.__ks = { S, E, exec, commands, monaco, loadProviders, saveSettings }; // handy in DevTools and for scripted screenshots
}
boot().catch((e) => { console.error(e); document.body.textContent = 'Kestrel failed to start: ' + e.message; });
