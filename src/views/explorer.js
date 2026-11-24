// File tree with lazy-loaded folders, inline create/rename, drag-to-move and git colouring.
import { S, on, emit, command, exec, basename, dirname } from '../state.js';
import { h, icon, clear, toast, confirm, popupMenu } from '../ui/h.js';
import { badgeOf } from '../lib/lang.js';
import * as E from '../editor/editors.js';

const expanded = new Set(['']);
const cache = new Map(); // dir → entries
let host, list, selected = null, editing = null;

export function mount(el) {
  host = el;
  list = h('div', { class: 'tree', tabindex: '0', onkeydown: keys });
  el.append(
    h('div', { class: 'side-head' },
      h('span', { class: 'side-title' }, S.ws?.name || 'Explorer'),
      h('div', { class: 'side-actions' },
        h('button', { class: 'ibtn', title: 'New File', onclick: () => startCreate(false) }, icon('newFile')),
        h('button', { class: 'ibtn', title: 'New Folder', onclick: () => startCreate(true) }, icon('newFolder')),
        h('button', { class: 'ibtn', title: 'Refresh', onclick: () => refresh(true) }, icon('refresh')),
        h('button', { class: 'ibtn', title: 'Collapse All', onclick: () => { expanded.clear(); expanded.add(''); render(); } }, icon('collapse')))),
    list);
  list.addEventListener('contextmenu', (e) => { if (e.target === list) { e.preventDefault(); menu(null, e); } });
  list.addEventListener('dragover', (e) => { if (e.target === list) e.preventDefault(); });
  list.addEventListener('drop', (e) => { if (e.target === list) drop(e, ''); });
  on('active', (t) => { if (t?.path && t.kind !== 'diff') { selected = t.path; revealPath(t.path, false); } });
  on('git', render);
  refresh(true);
}

export async function refresh(all = false, dirs) {
  if (!S.ws) return;
  const targets = all ? [...expanded] : dirs || [...expanded];
  await Promise.all(targets.map(async (d) => {
    try { cache.set(d, await window.ks.fs.list(d)); } catch { cache.delete(d); expanded.delete(d); }
  }));
  render();
}

/** fs:changed paths → reload only the affected folders */
export function changed(paths) {
  const dirs = new Set();
  for (const p of paths) { const d = dirname(p); if (expanded.has(d)) dirs.add(d); if (!p) dirs.add(''); }
  if (!paths.length) return refresh(true);
  if (dirs.size) refresh(false, [...dirs]);
}

async function toggle(dir, force) {
  const open = force ?? !expanded.has(dir);
  if (open) { expanded.add(dir); if (!cache.has(dir)) cache.set(dir, await window.ks.fs.list(dir).catch(() => [])); }
  else expanded.delete(dir);
  render();
}

async function revealPath(p, scroll = true) {
  const parts = p.split('/');
  for (let i = 1; i < parts.length; i++) { const d = parts.slice(0, i).join('/'); if (!expanded.has(d)) await toggle(d, true); }
  selected = p; render();
  requestAnimationFrame(() => list.querySelector('.row.sel')?.scrollIntoView({ block: scroll ? 'center' : 'nearest' }));
}

function visible() {
  const out = [];
  const walk = (dir, depth) => {
    for (const e of cache.get(dir) || []) {
      out.push({ ...e, depth });
      if (editing?.parent === e.path && e.dir && expanded.has(e.path)) out.push({ editRow: true, depth: depth + 1 });
      if (e.dir && expanded.has(e.path)) walk(e.path, depth + 1);
    }
  };
  if (editing?.parent === '') out.push({ editRow: true, depth: 0 });
  walk('', 0);
  return out;
}

function gitOf(p, dir) {
  const files = S.git?.files;
  if (!files) return null;
  if (!dir) return files[p] || null;
  const pre = p + '/';
  let st = null;
  for (const f in files) if (f.startsWith(pre)) { if (files[f] === 'C') return 'C'; st = st === 'U' || st === 'A' ? st : 'M'; }
  return st;
}

function render() {
  if (!list) return;
  clear(list);
  if (!S.ws) return;
  for (const e of visible()) {
    if (e.editRow) { list.append(editRow(e.depth)); continue; }
    if (editing?.rename === e.path) { list.append(editRow(e.depth, e)); continue; }
    const g = gitOf(e.path, e.dir);
    const [lbl, col] = e.dir ? ['', ''] : badgeOf(e.path);
    const row = h('div', {
      class: 'row' + (selected === e.path ? ' sel' : '') + (e.dim ? ' dim' : '') + (g ? ' git-' + g : '') + (E.activeFile() === e.path ? ' open' : ''),
      style: { paddingLeft: 10 + e.depth * 14 + 'px' }, draggable: 'true', title: e.path,
      onclick: () => { selected = e.path; if (e.dir) toggle(e.path); else E.open(e.path, { focus: false }); render(); },
      ondblclick: () => { if (!e.dir) E.open(e.path, { pin: true }); },
      oncontextmenu: (ev) => { ev.preventDefault(); selected = e.path; render(); menu(e, ev); },
      ondragstart: (ev) => { ev.dataTransfer.setData('text/kestrel-path', e.path); ev.dataTransfer.effectAllowed = 'move'; },
      ondragover: (ev) => { if (e.dir) { ev.preventDefault(); ev.currentTarget.classList.add('drop'); } },
      ondragleave: (ev) => ev.currentTarget.classList.remove('drop'),
      ondrop: (ev) => { ev.currentTarget.classList.remove('drop'); if (e.dir) drop(ev, e.path); },
    },
    e.dir ? icon(expanded.has(e.path) ? 'chevronDown' : 'chevronRight', 'twisty') : h('span', { class: 'twisty' }),
    e.dir ? icon(expanded.has(e.path) ? 'folderOpen' : 'explorer', 'folder-ic') : h('span', { class: 'fbadge', style: { color: col } }, lbl),
    h('span', { class: 'name' }, e.name),
    g ? h('span', { class: 'gbadge' }, g === 'U' ? 'U' : g) : null);
    list.append(row);
  }
}

function editRow(depth, entry) {
  const input = h('input', { class: 'tree-input', value: entry ? entry.name : '', spellcheck: 'false' });
  const done = async (commit) => {
    const ed = editing; editing = null;
    const name = input.value.trim();
    if (commit && name && !name.includes('..')) {
      try {
        if (ed.rename) {
          if (name !== basename(ed.rename)) {
            const to = (dirname(ed.rename) ? dirname(ed.rename) + '/' : '') + name;
            await window.ks.fs.rename(ed.rename, to); await E.renamed(ed.rename, to); selected = to;
          }
        } else {
          const p = (ed.parent ? ed.parent + '/' : '') + name;
          await window.ks.fs.create(p, ed.dir); selected = p;
          if (!ed.dir) E.open(p, { pin: true });
        }
      } catch (e) { toast(e.message, 'error'); }
    }
    await refresh(true);
    S.files = null;
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); done(true); } if (e.key === 'Escape') { e.preventDefault(); done(false); } e.stopPropagation(); });
  input.addEventListener('blur', () => editing && done(true));
  requestAnimationFrame(() => { input.focus(); const dot = input.value.lastIndexOf('.'); input.setSelectionRange(0, dot > 0 && !entry?.dir ? dot : input.value.length); });
  return h('div', { class: 'row editing', style: { paddingLeft: 10 + depth * 14 + 'px' } }, h('span', { class: 'twisty' }), editing?.dir || entry?.dir ? icon('explorer', 'folder-ic') : h('span', { class: 'fbadge' }, '•'), input);
}

function targetDir() {
  if (!selected) return '';
  const e = [...cache.values()].flat().find((x) => x.path === selected);
  return e?.dir ? selected : dirname(selected);
}
async function startCreate(dir, parent = targetDir()) {
  if (parent) await toggle(parent, true);
  editing = { parent, dir }; render();
}
function startRename(p) { editing = { rename: p }; render(); }

async function remove(p) {
  if (!(await confirm(`Move "${basename(p)}" to the Trash?`, 'You can restore it from the Trash in Finder.', 'Move to Trash', true))) return;
  try { await window.ks.fs.trash(p); E.deleted(p); S.files = null; refresh(true); } catch (e) { toast(e.message, 'error'); }
}

async function drop(ev, dir) {
  ev.preventDefault();
  const from = ev.dataTransfer.getData('text/kestrel-path');
  if (!from || from === dir || dir.startsWith(from + '/') || dirname(from) === dir) return;
  const to = (dir ? dir + '/' : '') + basename(from);
  try { await window.ks.fs.rename(from, to); await E.renamed(from, to); S.files = null; refresh(true); } catch (e) { toast(e.message, 'error'); }
}

function menu(e, ev) {
  const p = e?.path;
  popupMenu([
    { label: 'New File…', icon: 'newFile', onClick: () => startCreate(false, e ? (e.dir ? p : dirname(p)) : '') },
    { label: 'New Folder…', icon: 'newFolder', onClick: () => startCreate(true, e ? (e.dir ? p : dirname(p)) : '') },
    e ? '-' : null,
    e && !e.dir ? { label: 'Open to the Side', onClick: () => E.open(p, { pin: true }) } : null,
    e && !e.dir && /\.(md|markdown|mdx)$/i.test(p) ? { label: 'Open Preview', icon: 'eye', onClick: async () => { await E.open(p, { pin: true }); E.setPreview(undefined, 'only'); } } : null,
    e && !e.dir ? { label: 'Add to Chat', icon: 'chat', onClick: () => exec('chat.addFile', p) } : null,
    e ? { label: 'Mention in Claude Code', icon: 'claude', onClick: () => exec('claude.mention', p) } : null,
    e && !e.dir && S.git?.files?.[p] ? { label: 'Compare with HEAD', icon: 'split2', onClick: () => exec('git.diffFile', p) } : null,
    e && e.dir ? { label: 'Open in Terminal', icon: 'terminal', onClick: () => exec('terminal.new', { cwd: p }) } : null,
    e && e.dir ? { label: 'Find in Folder…', icon: 'search', onClick: () => exec('search.inFolder', p) } : null,
    '-',
    { label: 'Reveal in Finder', icon: 'folder', onClick: () => window.ks.shell.reveal(p || '.') },
    e ? { label: 'Copy Path', icon: 'copy', onClick: async () => window.ks.clip.copy(await window.ks.fs.abs(p)) } : null,
    e ? { label: 'Copy Relative Path', onClick: () => window.ks.clip.copy(p) } : null,
    e ? '-' : null,
    e ? { label: 'Rename…', icon: 'edit', kbd: '↵', onClick: () => startRename(p) } : null,
    e ? { label: 'Delete', icon: 'trash', kbd: '⌘⌫', danger: true, onClick: () => remove(p) } : null,
  ].filter(Boolean), ev);
}

function keys(e) {
  const rows = visible().filter((r) => !r.editRow);
  const i = rows.findIndex((r) => r.path === selected);
  const cur = rows[i];
  if (e.key === 'ArrowDown') { selected = rows[Math.min(rows.length - 1, i + 1)]?.path; render(); }
  else if (e.key === 'ArrowUp') { selected = rows[Math.max(0, i - 1)]?.path; render(); }
  else if (e.key === 'ArrowRight' && cur?.dir) toggle(cur.path, true);
  else if (e.key === 'ArrowLeft' && cur) { if (cur.dir && expanded.has(cur.path)) toggle(cur.path, false); else { selected = dirname(cur.path) || selected; render(); } }
  else if (e.key === 'Enter' && cur) { e.preventDefault(); startRename(cur.path); return; }
  else if (e.key === ' ' && cur && !cur.dir) E.open(cur.path, { focus: false });
  else if (e.key === 'Backspace' && e.metaKey && cur) remove(cur.path);
  else return;
  e.preventDefault();
  list.querySelector('.row.sel')?.scrollIntoView({ block: 'nearest' });
}

command('explorer.reveal', 'Explorer: Reveal Active File', (p = E.activeFile()) => { if (!p) return; exec('view.show', 'explorer'); revealPath(p); });
command('explorer.newFile', 'File: New File', () => { exec('view.show', 'explorer'); startCreate(false); });
command('explorer.newFolder', 'File: New Folder', () => { exec('view.show', 'explorer'); startCreate(true); });
command('explorer.refresh', 'Explorer: Refresh', () => refresh(true));
export { render, expanded };
