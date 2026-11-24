// Editor area: tabs, documents (Monaco models), one shared code editor, a diff editor and an image viewer.
import { monaco } from './monaco.js';
import { S, set, on, emit, command, exec, basename, dirname } from '../state.js';
import { h, icon, clear, toast, confirm, debounce, popupMenu } from '../ui/h.js';
import { languageOf, badgeOf, isImage } from '../lib/lang.js';
import { createPreview, isMarkdown } from './mdpreview.js';

export const docs = new Map();   // path → { path, model, saved (alt version id), mtime, view }
export let tabs = [];            // [{ id, kind:'file'|'diff'|'media', path, title, preview, ... }]
export let active = null;        // tab id
let editor, diffEditor, root, tabbar, crumbs, codeHost, diffHost, diffBar, mediaHost, emptyHost, mdHost, md;

const uri = (p) => monaco.Uri.file(S.ws.root + '/' + p);
export const activeTab = () => tabs.find((t) => t.id === active) || null;
export const activeFile = () => { const t = activeTab(); return t?.kind === 'file' ? t.path : null; };
export const getEditor = () => editor;
export const getDiffEditor = () => diffEditor;
export const isDirty = (p) => { const d = docs.get(p); return !!d && d.model.getAlternativeVersionId() !== d.saved; };

function options() {
  return {
    fontSize: set('fontSize'), fontFamily: set('fontFamily') || "'JetBrains Mono', 'SF Mono', Menlo, Monaco, monospace", fontLigatures: set('ligatures'),
    lineHeight: set('lineHeight') || Math.round(set('fontSize') * 1.6), tabSize: set('tabSize'), wordWrap: set('wordWrap'),
    minimap: { enabled: set('minimap'), renderCharacters: false, scale: 1, showSlider: 'mouseover' },
    renderWhitespace: set('renderWhitespace'), cursorBlinking: set('cursorBlink'), cursorSmoothCaretAnimation: 'on', smoothScrolling: true,
    stickyScroll: { enabled: set('stickyScroll') }, bracketPairColorization: { enabled: true }, guides: { bracketPairs: 'active', indentation: true },
    padding: { top: 10 }, scrollBeyondLastLine: true, automaticLayout: false, fixedOverflowWidgets: true, inlineSuggest: { enabled: true, mode: 'subwordSmart' },
    renderLineHighlight: 'all', roundedSelection: true, scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
    suggest: { preview: true, showStatusBar: true }, quickSuggestions: { other: true, comments: false, strings: false }, linkedEditing: true,
    'semanticHighlighting.enabled': true, overviewRulerBorder: false, hideCursorInOverviewRuler: true, mouseWheelZoom: true, colorDecorators: true,
  };
}

export function mount(el) {
  root = el;
  tabbar = h('div', { class: 'tabbar' });
  crumbs = h('div', { class: 'crumbs' });
  codeHost = h('div', { class: 'code-host' });
  diffBar = h('div', { class: 'diff-bar' });
  diffHost = h('div', { class: 'diff-host' }, diffBar, h('div', { class: 'diff-editor' }));
  mediaHost = h('div', { class: 'media-host' });
  emptyHost = h('div', { class: 'empty-host' });
  mdHost = h('div', { class: 'md-host' });
  // monaco-component: Monaco's theme variables (menu colours etc.) are scoped to that class, and its
  // context menu is mounted beside the editor rather than inside .monaco-editor
  el.append(tabbar, crumbs, h('div', { class: 'editor-stack monaco-component' }, codeHost, mdHost, diffHost, mediaHost, emptyHost));
  md = createPreview(mdHost, {
    onOpen: async (p, anchor) => { if (isMarkdown(p)) { const t = await open(p, { pin: true }); if (t) { setPreview(t, activeTab()?.md || 'side', t); if (anchor) setTimeout(() => md.scrollToAnchor(anchor), 50); } } else open(p, { pin: true }); },
    onModeChange: (m) => setPreview(activeTab(), m),
    onScrollTo: (line) => { const top = editor.getTopForLineNumber(Math.floor(line) + 1) + (line % 1) * editor.getOption(monaco.editor.EditorOption.lineHeight); editor.setScrollTop(top - 8); },
  });

  editor = monaco.editor.create(codeHost, { ...options(), model: null, theme: themeName() });
  diffEditor = monaco.editor.createDiffEditor(diffHost.lastChild, { ...options(), theme: themeName(), renderSideBySide: true, originalEditable: false, readOnly: false, enableSplitViewResizing: true, renderOverviewRuler: false, ignoreTrimWhitespace: false, minimap: { enabled: false }, useInlineViewWhenSpaceIsLimited: true, renderSideBySideInlineBreakpoint: 560, renderValidationDecorations: 'off', hideUnchangedRegions: { enabled: true, contextLineCount: 4, minimumLineCount: 6, revealLineCount: 10 }, diffAlgorithm: 'advanced' });
  new ResizeObserver(() => { editor.layout(); const d = diffHost.lastChild; if (d.clientWidth) diffEditor.layout({ width: d.clientWidth, height: d.clientHeight }); }).observe(el);

  editor.onDidChangeCursorSelection(() => { emit('selection'); renderStatusLater(); });
  editor.onDidScrollChange((e) => { if (e.scrollTopChanged && activeTab()?.md === 'side') md.scrollToLine(topLine()); });
  editor.onDidChangeModelContent(() => {
    const t = activeTab();
    if (t?.md) updatePreviewLater();
    if (t?.preview) { t.preview = false; }
    renderTabsLater();
    if (set('autoSave') === 'afterDelay') autoSave();
  });
  editor.onDidBlurEditorText(() => { if (set('autoSave') === 'onFocusChange') exec('file.saveAll'); });
  monaco.editor.onDidChangeMarkers(() => emit('markers'));

  // ⌘-click / F12 into another file opens it as a tab
  const svc = editor._codeEditorService;
  if (svc?.openCodeEditor) {
    const orig = svc.openCodeEditor.bind(svc);
    svc.openCodeEditor = async (input, src, side) => {
      const res = await orig(input, src, side);
      if (res) return res;
      const p = input.resource.path.startsWith(S.ws.root + '/') ? input.resource.path.slice(S.ws.root.length + 1) : null;
      if (!p) return null;
      await open(p, { pin: true, selection: input.options?.selection });
      return editor;
    };
  }

  on('settings', () => {
    editor.updateOptions(options()); diffEditor.updateOptions({ ...options(), minimap: { enabled: false } });
    monaco.editor.setTheme(themeName());
  });
  on('git', renderTabs);
  render();
}

export const themeName = () => {
  const t = set('theme');
  const dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  return dark ? 'kestrel-dark' : 'kestrel-light';
};

// ---------------- documents ----------------
async function loadDoc(path) {
  if (docs.has(path)) return docs.get(path);
  const r = await window.ks.fs.read(path);
  if (r.binary || r.tooLarge) return { path, media: r };
  const existing = monaco.editor.getModel(uri(path));
  const model = existing || monaco.editor.createModel(r.text, languageOf(path), uri(path));
  if (existing) existing.setValue(r.text);
  model.updateOptions({ tabSize: set('tabSize') });
  const d = { path, model, saved: model.getAlternativeVersionId(), mtime: r.mtime, view: null };
  docs.set(path, d);
  return d;
}

/** Open a workspace file. opts: { pin, selection:{startLineNumber,...}, line, focus=true, preview } */
export async function open(path, opts = {}) {
  if (!S.ws) return;
  let t = tabs.find((x) => x.kind !== 'diff' && x.path === path);
  if (!t) {
    let d;
    try { d = await loadDoc(path); } catch (e) { toast(`Can't open ${path}: ${e.message}`, 'error'); return; }
    const preview = opts.pin ? false : (opts.preview ?? true);
    t = { id: 'f:' + path, kind: d.media ? 'media' : 'file', path, title: basename(path), preview, media: d.media };
    const old = preview ? tabs.findIndex((x) => x.preview && x.kind === 'file' && !isDirty(x.path)) : -1;
    const at = tabs.findIndex((x) => x.id === active);
    if (old >= 0) { dropDoc(tabs[old].path); tabs[old] = t; }
    else tabs.splice(at >= 0 ? at + 1 : tabs.length, 0, t);
  } else if (opts.pin) t.preview = false;
  activate(t.id, opts);
  return t;
}

function dropDoc(path) {
  if (tabs.some((t) => t.path === path && t.kind !== 'diff' && t.id !== 'f:' + path)) return;
  const d = docs.get(path);
  if (d?.model && !isDirty(path)) { d.model.dispose(); docs.delete(path); }
}

export function activate(id, opts = {}) {
  const prev = activeTab();
  if (prev?.kind === 'file' && editor.getModel()) docs.get(prev.path) && (docs.get(prev.path).view = editor.saveViewState());
  active = id;
  const t = activeTab();
  render();
  if (t?.kind === 'file') {
    const d = docs.get(t.path);
    if (editor.getModel() !== d.model) editor.setModel(d.model);
    if (d.view && !opts.selection && !opts.line) editor.restoreViewState(d.view);
    if (opts.selection) { editor.setSelection(opts.selection); editor.revealRangeInCenterIfOutsideViewport(opts.selection, 0); }
    else if (opts.line) { const pos = { lineNumber: opts.line, column: opts.col || 1 }; editor.setPosition(pos); editor.revealPositionInCenter(pos, 0); if (opts.len) editor.setSelection(new monaco.Selection(opts.line, opts.col, opts.line, opts.col + opts.len)); }
    if (opts.focus !== false) requestAnimationFrame(() => editor.focus());
  } else if (t?.kind === 'diff') {
    diffEditor.setModel({ original: t.original, modified: t.modified });
    const host = diffHost.lastChild;
    requestAnimationFrame(() => { diffEditor.layout({ width: host.clientWidth, height: host.clientHeight }); if (opts.focus !== false) diffEditor.getModifiedEditor().focus(); });
  }
  emit('active', t);
  saveSessionLater();
}

export async function save(path = activeFile(), { quiet } = {}) {
  const d = path && docs.get(path);
  if (!d?.model) return false;
  if (set('formatOnSave') && editor.getModel() === d.model) {
    try { await editor.getAction('editor.action.formatDocument')?.run(); } catch { /* no formatter */ }
  }
  try {
    d.mtime = await window.ks.fs.write(path, d.model.getValue());
    d.saved = d.model.getAlternativeVersionId();
    renderTabs();
    emit('saved', path);
    return true;
  } catch (e) { if (!quiet) toast(`Save failed: ${e.message}`, 'error'); return false; }
}
const autoSave = debounce(() => { for (const p of docs.keys()) if (isDirty(p)) save(p, { quiet: true }); }, 1000);

export async function close(id = active, { force } = {}) {
  const t = tabs.find((x) => x.id === id);
  if (!t) return true;
  if (t.kind === 'file' && isDirty(t.path) && !force) {
    const r = await confirmSave([t.path]);
    if (r === 'cancel') return false;
  }
  if (t.kind === 'diff') t.onClose?.();
  const i = tabs.indexOf(t);
  tabs.splice(i, 1);
  if (t.kind === 'file') { const d = docs.get(t.path); if (d) { if (isDirty(t.path)) d.model.setValue(d.model.getValue()); d.model.dispose(); docs.delete(t.path); } }
  if (t.kind === 'diff') { if (diffEditor.getModel()?.modified === t.modified) diffEditor.setModel(null); t.original?.dispose(); t.modified?.dispose(); }
  if (active === id) {
    const next = tabs[i] || tabs[i - 1];
    active = null;
    if (next) activate(next.id); else { editor.setModel(null); render(); emit('active', null); saveSessionLater(); }
  } else render();
  return true;
}

/** Ask what to do with unsaved files. Returns 'saved' | 'discard' | 'cancel'. */
export async function confirmSave(paths) {
  const { modal } = await import('../ui/h.js');
  const r = await modal(paths.length === 1 ? `Save changes to ${basename(paths[0])}?` : `Save changes to ${paths.length} files?`,
    h('p', { class: 'muted' }, 'Your changes will be lost if you don’t save them.'),
    [{ label: 'Don’t Save', value: 'discard' }, { label: 'Cancel', value: 'cancel' }, { label: 'Save', primary: true, value: 'save' }]);
  if (!r || r === 'cancel') return 'cancel';
  if (r === 'save') for (const p of paths) await save(p);
  return r === 'save' ? 'saved' : 'discard';
}
export const dirtyPaths = () => [...docs.keys()].filter(isDirty);

// ---------------- diff tabs ----------------
/** Open a diff tab. o: { id, title, path, original, modified, language, actions:[{label, primary, run}], onClose, editable } */
export function openDiff(o) {
  const existing = tabs.find((t) => t.id === o.id);
  if (existing) close(existing.id, { force: true });
  const lang = o.language || (o.path ? languageOf(o.path) : 'plaintext');
  const t = {
    id: o.id, kind: 'diff', path: o.path, title: o.title, sub: o.sub, badge: o.badge,
    original: monaco.editor.createModel(o.original ?? '', lang), modified: monaco.editor.createModel(o.modified ?? '', lang),
    actions: o.actions || [], onClose: o.onClose,
  };
  const at = tabs.findIndex((x) => x.id === active);
  tabs.splice(at >= 0 ? at + 1 : tabs.length, 0, t);
  activate(t.id);
  return t;
}

// ---------------- external changes ----------------
export async function onFsChanged(list) {
  for (const [p, d] of docs) {
    if (!list.length || list.some((f) => f === p)) {
      try {
        const r = await window.ks.fs.read(p);
        if (r.text == null || r.mtime === d.mtime) continue;
        if (r.text === d.model.getValue()) { d.mtime = r.mtime; d.saved = d.model.getAlternativeVersionId(); continue; }
        if (isDirty(p)) { d.mtime = r.mtime; toast(`${basename(p)} changed on disk — your unsaved edits are kept`); continue; }
        d.model.pushEditOperations([], [{ range: d.model.getFullModelRange(), text: r.text }], () => null);
        d.saved = d.model.getAlternativeVersionId(); d.mtime = r.mtime;
      } catch { /* deleted */ }
    }
  }
  renderTabs();
}

export async function renamed(from, to) {
  for (const t of tabs) {
    if (t.path === from || t.path?.startsWith(from + '/')) {
      const np = to + t.path.slice(from.length);
      const d = docs.get(t.path);
      if (d) {
        docs.delete(t.path);
        const model = monaco.editor.createModel(d.model.getValue(), languageOf(np), uri(np));
        const wasActive = editor.getModel() === d.model;
        d.model.dispose(); d.model = model; d.path = np; d.saved = model.getAlternativeVersionId(); docs.set(np, d);
        if (wasActive) editor.setModel(model);
      }
      t.path = np; t.id = 'f:' + np; t.title = basename(np);
      if (active === 'f:' + from) active = t.id;
    }
  }
  render();
}
export function deleted(path) {
  for (const t of [...tabs]) if (t.kind !== 'diff' && (t.path === path || t.path.startsWith(path + '/'))) close(t.id, { force: true });
}

// ---------------- markdown preview ----------------
const topLine = () => { const st = editor.getScrollTop() + 8, lh = editor.getOption(monaco.editor.EditorOption.lineHeight); const ln = editor.getVisibleRanges()[0]?.startLineNumber || 1; const y = editor.getTopForLineNumber(ln); return ln - 1 + Math.max(0, Math.min(1, (st - y) / lh)); };
const updatePreviewLater = debounce(() => { const t = activeTab(); if (t?.md && docs.get(t.path)) md.update(t.path, docs.get(t.path).model.getValue()); }, 120);
/** mode: 'side' (editor + preview), 'only' (preview fills the tab) or null (editor only) */
export function setPreview(t = activeTab(), mode) {
  if (!t || t.kind !== 'file') return;
  t.md = mode || null;
  if (t.id !== active) return;
  render();
  if (t.md) { md.setMode(t.md); md.update(t.path, docs.get(t.path).model.getValue()); if (t.md === 'side') requestAnimationFrame(() => md.scrollToLine(topLine())); }
  else editor.focus();
}

// ---------------- rendering ----------------
let tabsT = 0, statusT = 0;
const renderTabsLater = () => { if (!tabsT) tabsT = requestAnimationFrame(() => { tabsT = 0; renderTabs(); }); };
const renderStatusLater = () => { if (!statusT) statusT = setTimeout(() => { statusT = 0; emit('status'); }, 60); };

export function render() {
  renderTabs();
  const t = activeTab();
  const mdMode = t?.kind === 'file' ? t.md : null;
  codeHost.style.display = t?.kind === 'file' && mdMode !== 'only' ? '' : 'none';
  codeHost.style.right = mdMode === 'side' ? '50%' : '';
  mdHost.style.display = mdMode ? '' : 'none';
  mdHost.style.left = mdMode === 'side' ? '50%' : '0';
  mdHost.classList.toggle('side', mdMode === 'side');
  diffHost.style.display = t?.kind === 'diff' ? '' : 'none';
  mediaHost.style.display = t?.kind === 'media' ? '' : 'none';
  emptyHost.style.display = t ? 'none' : '';
  crumbs.style.display = t && t.kind !== 'diff' ? '' : 'none';
  if (t?.kind === 'media') renderMedia(t);
  if (t?.kind === 'diff') renderDiffBar(t);
  if (!t) renderEmpty();
  renderCrumbs(t);
  if (t?.kind === 'file') requestAnimationFrame(() => editor.layout());
  if (mdMode && md.path !== t.path) { md.setMode(mdMode); md.update(t.path, docs.get(t.path).model.getValue()); }
  else if (mdMode) { md.setMode(mdMode); updatePreviewLater(); }
}

function renderTabs() {
  if (!tabbar) return;
  clear(tabbar);
  const strip = h('div', { class: 'tabs' });
  for (const t of tabs) {
    const dirty = t.kind === 'file' && isDirty(t.path);
    const g = t.path && S.git?.files?.[t.path];
    const [lbl, col] = t.kind === 'diff' ? [t.badge || '±', '#ff9e7a'] : badgeOf(t.path);
    const el = h('div', {
      class: 'tab' + (t.id === active ? ' active' : '') + (t.preview ? ' preview' : '') + (dirty ? ' dirty' : '') + (g ? ' git-' + g : ''),
      title: t.path || t.title, draggable: 'true',
      onmousedown: (e) => { if (e.button === 1) { e.preventDefault(); close(t.id); } else if (e.button === 0 && !e.target.closest('.tab-x')) activate(t.id); },
      ondblclick: () => { t.preview = false; renderTabs(); },
      oncontextmenu: (e) => { e.preventDefault(); tabMenu(t, e); },
      ondragstart: (e) => { e.dataTransfer.setData('text/kestrel-tab', t.id); },
      ondragover: (e) => e.preventDefault(),
      ondrop: (e) => { e.preventDefault(); const from = tabs.findIndex((x) => x.id === e.dataTransfer.getData('text/kestrel-tab')); const to = tabs.indexOf(t); if (from >= 0 && from !== to) { tabs.splice(to, 0, tabs.splice(from, 1)[0]); renderTabs(); saveSessionLater(); } },
    },
    h('span', { class: 'fbadge', style: { color: col } }, lbl),
    h('span', { class: 'tab-title' }, t.title),
    t.sub ? h('span', { class: 'tab-sub' }, t.sub) : null,
    h('button', { class: 'tab-x', title: 'Close (⌘W)', onclick: (e) => { e.stopPropagation(); close(t.id); } }, dirty ? h('span', { class: 'dirty-dot' }) : icon('close')));
    strip.append(el);
  }
  tabbar.append(strip, h('div', { class: 'tab-actions' },
    isMarkdown(activeFile()) ? h('button', { class: 'ibtn' + (activeTab().md ? ' on' : ''), title: activeTab().md ? 'Close Preview (⇧⌘V)' : 'Open Preview to the Side (⇧⌘V)', onclick: () => exec('markdown.preview') }, icon('eye')) : null,
    activeFile() ? h('button', { class: 'ibtn', title: 'Compare with HEAD', onclick: () => exec('git.diffFile', activeFile()) }, icon('split2')) : null,
    h('button', { class: 'ibtn', title: 'Edit with AI (⌘K)', onclick: () => exec('ai.inlineEdit') }, icon('wand')),
    h('button', { class: 'ibtn', title: 'More', onclick: (e) => popupMenu([
      { label: 'Close All', onClick: () => closeAll() }, { label: 'Close Saved', onClick: () => tabs.filter((t) => !(t.kind === 'file' && isDirty(t.path))).forEach((t) => close(t.id)) },
      '-', { label: 'Toggle Word Wrap', kbd: '⌥Z', onClick: () => exec('view.wordWrap') }, { label: 'Toggle Minimap', onClick: () => exec('view.minimap') }], e.currentTarget) }, icon('more'))));
  const a = strip.querySelector('.tab.active');
  if (a) a.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function tabMenu(t, e) {
  const i = tabs.indexOf(t);
  popupMenu([
    { label: 'Close', kbd: '⌘W', onClick: () => close(t.id) },
    { label: 'Close Others', onClick: () => tabs.filter((x) => x !== t).forEach((x) => close(x.id)) },
    { label: 'Close to the Right', onClick: () => tabs.slice(i + 1).forEach((x) => close(x.id)) },
    { label: 'Close All', onClick: () => closeAll() },
    '-',
    t.path ? { label: 'Copy Path', onClick: async () => window.ks.clip.copy(await window.ks.fs.abs(t.path)) } : null,
    t.path ? { label: 'Copy Relative Path', onClick: () => window.ks.clip.copy(t.path) } : null,
    t.path ? { label: 'Reveal in Explorer', onClick: () => exec('explorer.reveal', t.path) } : null,
    t.path ? { label: 'Reveal in Finder', onClick: () => window.ks.shell.reveal(t.path) } : null,
    t.path && t.kind === 'file' ? '-' : null,
    t.kind === 'file' && isMarkdown(t.path) ? { label: t.md ? 'Close Preview' : 'Open Preview', icon: 'eye', onClick: () => { activate(t.id); setPreview(t, t.md ? null : 'side'); } } : null,
    t.path && t.kind === 'file' ? { label: 'Add File to Chat', icon: 'chat', onClick: () => exec('chat.addFile', t.path) } : null,
    t.path && t.kind === 'file' ? { label: 'Mention in Claude Code', icon: 'claude', onClick: () => exec('claude.mention', t.path) } : null,
  ].filter(Boolean), e);
}

export async function closeAll() {
  const dirty = dirtyPaths();
  if (dirty.length && (await confirmSave(dirty)) === 'cancel') return false;
  for (const t of [...tabs]) await close(t.id, { force: true });
  return true;
}

function renderCrumbs(t) {
  clear(crumbs);
  if (!t?.path) return;
  const parts = t.path.split('/');
  parts.forEach((p, i) => {
    if (i) crumbs.append(icon('chevronRight', 'crumb-sep'));
    crumbs.append(h('span', { class: 'crumb' + (i === parts.length - 1 ? ' last' : ''), onclick: () => exec('explorer.reveal', parts.slice(0, i + 1).join('/')) }, p));
  });
  const g = S.git?.files?.[t.path];
  if (g) crumbs.append(h('span', { class: 'crumb-git git-' + g }, { M: 'Modified', A: 'Added', U: 'Untracked', D: 'Deleted', C: 'Conflict' }[g]));
}

function renderDiffBar(t) {
  clear(diffBar);
  diffBar.append(
    h('div', { class: 'diff-title' }, h('span', { class: 'fbadge', style: { color: '#ff9e7a' } }, t.badge || '±'), h('b', {}, t.title), t.sub ? h('span', { class: 'muted' }, t.sub) : null),
    h('div', { class: 'diff-actions' }, t.actions.map((a) => h('button', { class: 'btn sm' + (a.primary ? ' primary' : '') + (a.danger ? ' danger' : ''), title: a.title || '', onclick: () => a.run(t) }, a.icon ? icon(a.icon) : null, a.label))));
}

function renderMedia(t) {
  clear(mediaHost);
  const m = t.media;
  if (m.data) mediaHost.append(h('div', { class: 'media-wrap' }, h('img', { src: `data:image/${m.ext === 'jpg' ? 'jpeg' : m.ext === 'ico' ? 'x-icon' : m.ext};base64,${m.data}` }), h('div', { class: 'muted' }, `${t.path} · ${(m.size / 1024).toFixed(1)} KB`)));
  else mediaHost.append(h('div', { class: 'media-wrap' }, icon('file', 'big'), h('p', {}, m.tooLarge ? 'This file is too large to open in the editor.' : 'This file is binary and can’t be shown.'), h('div', { class: 'muted' }, `${t.path} · ${(m.size / 1024 / 1024).toFixed(2)} MB`),
    h('button', { class: 'btn', onclick: () => window.ks.shell.reveal(t.path) }, 'Reveal in Finder')));
}

function renderEmpty() {
  clear(emptyHost);
  const row = (label, keys) => h('div', { class: 'kb-row' }, h('span', {}, label), h('span', { class: 'kb-keys' }, keys.map((k) => h('kbd', {}, k))));
  emptyHost.append(h('div', { class: 'empty-inner' },
    h('img', { class: 'empty-logo', src: './logo.svg', alt: '' }),
    h('div', { class: 'kb' },
      row('Go to File', ['⌘', 'P']), row('Command Palette', ['⇧', '⌘', 'P']), row('Chat with AI', ['⌘', 'L']), row('Edit with AI', ['⌘', 'K']),
      row('Launch Claude Code', ['⌘', 'Esc']), row('Toggle Terminal', ['⌃', '`']), row('Find in Files', ['⇧', '⌘', 'F']))));
}

// ---------------- session ----------------
const saveSessionLater = debounce(() => {
  if (!S.ws) return;
  window.ks.session.save({ tabs: tabs.filter((t) => t.kind === 'file' || t.kind === 'media').map((t) => t.path), active: activeTab()?.path || null, layout: S.layout });
}, 500);
export { saveSessionLater };

export async function restore(session) {
  for (const p of session?.tabs || []) {
    const r = await open(p, { pin: true, focus: false }).catch(() => null);
    if (!r) continue;
  }
  const a = session?.active && tabs.find((t) => t.path === session.active);
  if (a) activate(a.id, { focus: false });
}

export function reset() { for (const t of [...tabs]) close(t.id, { force: true }); docs.clear(); }

// ---------------- commands ----------------
command('file.save', 'File: Save', () => { const t = activeTab(); if (t?.kind === 'diff') return t.actions.find((a) => a.primary)?.run(t); return save(); });
command('file.saveAll', 'File: Save All', async () => { for (const p of dirtyPaths()) await save(p); });
command('file.close', 'View: Close Editor', () => close());
command('file.closeAll', 'View: Close All Editors', () => closeAll());
command('tab.next', 'View: Next Editor', () => { const i = tabs.findIndex((t) => t.id === active); if (tabs.length) activate(tabs[(i + 1) % tabs.length].id); });
command('tab.prev', 'View: Previous Editor', () => { const i = tabs.findIndex((t) => t.id === active); if (tabs.length) activate(tabs[(i - 1 + tabs.length) % tabs.length].id); });
command('view.wordWrap', 'View: Toggle Word Wrap', async () => { const { saveSettings } = await import('../state.js'); saveSettings({ wordWrap: set('wordWrap') === 'off' ? 'on' : 'off' }); });
command('view.minimap', 'View: Toggle Minimap', async () => { const { saveSettings } = await import('../state.js'); saveSettings({ minimap: !set('minimap') }); });
command('editor.gotoLine', 'Go to Line…', () => { editor.focus(); editor.getAction('editor.action.gotoLine')?.run(); });
command('editor.gotoSymbol', 'Go to Symbol in Editor…', () => { editor.focus(); editor.getAction('editor.action.quickOutline')?.run(); });
command('editor.gotoDef', 'Go to Definition', () => editor.getAction('editor.action.revealDefinition')?.run());
command('editor.format', 'Format Document', () => editor.getAction('editor.action.formatDocument')?.run());
command('editor.find', 'Find', () => { const t = activeTab(); (t?.kind === 'diff' ? diffEditor.getModifiedEditor() : editor).getAction('actions.find')?.run(); });
command('editor.replace', 'Replace', () => editor.getAction('editor.action.startFindReplaceAction')?.run());
command('editor.commandPalette', 'Editor Commands…', () => { editor.focus(); editor.getAction('editor.action.quickCommand')?.run(); });
command('markdown.preview', 'Markdown: Toggle Preview to the Side', () => { const t = activeTab(); if (t?.kind === 'file' && isMarkdown(t.path)) setPreview(t, t.md ? null : 'side'); });
command('markdown.previewOnly', 'Markdown: Open Preview', () => { const t = activeTab(); if (t?.kind === 'file' && isMarkdown(t.path)) setPreview(t, 'only'); });
command('editor.fold', 'Fold All', () => editor.getAction('editor.foldAll')?.run());
command('editor.unfold', 'Unfold All', () => editor.getAction('editor.unfoldAll')?.run());

export { dirname };
