// ⌘P quick open, ⇧⌘P command palette (">"), ":" go to line, "@" symbols — one fuzzy list.
import { S, commands, command, exec, basename, dirname } from '../state.js';
import { h, icon, clear } from '../ui/h.js';
import { rank } from '../lib/fuzzy.js';
import { badgeOf } from '../lib/lang.js';
import * as E from '../editor/editors.js';

const recentFiles = [];
const recentCmds = [];
let openP = null;

export async function ensureFiles() {
  if (!S.files && S.ws) S.files = await window.ks.fs.files().catch(() => []);
  return S.files || [];
}

function highlight(text, hits, offset = 0) {
  const set = new Set(hits.map((i) => i - offset).filter((i) => i >= 0));
  const out = [];
  let buf = '', on = false;
  for (let i = 0; i < text.length; i++) {
    const hit = set.has(i);
    if (hit !== on) { if (buf) out.push(on ? h('mark', {}, buf) : buf); buf = ''; on = hit; }
    buf += text[i];
  }
  if (buf) out.push(on ? h('mark', {}, buf) : buf);
  return out;
}

/** Generic picker. source(query) → [{ label, detail, hits, dhits, badge, kbd, run|value }]. Resolves with the chosen item's value. */
function picker({ placeholder, initial = '', source, onQuery }) {
  openP?.close();
  return new Promise((resolve) => {
    const input = h('input', { class: 'pal-input', placeholder, value: initial, spellcheck: 'false' });
    const listEl = h('div', { class: 'pal-list' });
    const back = h('div', { class: 'pal-back', onmousedown: (e) => { if (e.target === back) close(); } }, h('div', { class: 'pal' }, h('div', { class: 'pal-head' }, icon('search'), input), listEl));
    let items = [], sel = 0, seq = 0;
    const close = (v) => { back.remove(); openP = null; resolve(v); };
    openP = { close };
    const draw = () => {
      clear(listEl);
      if (!items.length) { listEl.append(h('div', { class: 'pal-empty' }, 'No results')); return; }
      items.forEach((it, i) => {
        if (it.section) { listEl.append(h('div', { class: 'pal-sec' }, it.section)); return; }
        listEl.append(h('div', { class: 'pal-item' + (i === sel ? ' sel' : ''), onmousemove: () => { if (sel !== i) { sel = i; draw(); } }, onclick: () => choose(it) },
          it.badge ? h('span', { class: 'fbadge', style: { color: it.badge[1] } }, it.badge[0]) : it.icon ? icon(it.icon) : null,
          h('span', { class: 'pal-label' }, highlight(it.label, it.hits || [])),
          it.detail ? h('span', { class: 'pal-detail' }, highlight(it.detail, it.dhits || [])) : null,
          it.kbd ? h('span', { class: 'kbd' }, it.kbd) : null));
      });
      listEl.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
    };
    const choose = (it) => { if (!it || it.section) return; close(it.value ?? it); it.run?.(); };
    const update = async () => {
      const my = ++seq;
      if (onQuery && onQuery(input.value, close)) return;
      const r = await source(input.value);
      if (my !== seq) return;
      items = r; sel = items.findIndex((x) => !x.section); draw();
    };
    input.addEventListener('input', update);
    input.addEventListener('keydown', (e) => {
      const move = (d) => { let i = sel; do { i = (i + d + items.length) % items.length; } while (items[i]?.section && i !== sel); sel = i; draw(); };
      if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) { e.preventDefault(); move(1); }
      else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) { e.preventDefault(); move(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); choose(items[sel]); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); }
      e.stopPropagation();
    });
    document.body.append(back);
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    update();
  });
}

async function fileItems(q) {
  const files = await ensureFiles();
  if (!q) {
    const rec = recentFiles.filter((f) => files.includes(f)).slice(0, 12);
    const open = E.tabs.filter((t) => t.kind !== 'diff' && !rec.includes(t.path)).map((t) => t.path);
    const list = [...new Set([...rec, ...open])];
    return [list.length ? { section: 'recently opened' } : null, ...list.map((f) => fileItem(f)), { section: 'files' }, ...files.slice(0, 60).filter((f) => !list.includes(f)).map((f) => fileItem(f))].filter(Boolean);
  }
  const [path, line] = q.split(':');
  return rank(path.replace(/\s+/g, ''), files, (f) => f, 80).map((r) => fileItem(r.item, r.hits, line));
}
function fileItem(f, hits = [], line) {
  const base = f.lastIndexOf('/') + 1;
  return { label: basename(f), detail: dirname(f), hits: hits.filter((i) => i >= base).map((i) => i - base), dhits: hits.filter((i) => i < base), badge: badgeOf(f),
    value: f, run: () => { recentFiles.splice(0, recentFiles.length, f, ...recentFiles.filter((x) => x !== f)); E.open(f, { pin: true, line: line ? +line : undefined }); } };
}

function commandItems(q) {
  const all = [...commands.values()].filter((c) => !c.hidden && (!c.when || c.when()));
  const toItem = (c, hits) => ({ label: c.title, hits, kbd: c.kbd, icon: c.icon, value: c.id, run: () => { recentCmds.splice(0, recentCmds.length, c.id, ...recentCmds.filter((x) => x !== c.id)); exec(c.id); } });
  if (!q) {
    const rec = recentCmds.map((id) => commands.get(id)).filter(Boolean).slice(0, 5);
    const rest = all.filter((c) => !rec.includes(c)).sort((a, b) => a.title.localeCompare(b.title));
    return [rec.length ? { section: 'recently used' } : null, ...rec.map((c) => toItem(c)), rec.length ? { section: 'all commands' } : null, ...rest.map((c) => toItem(c))].filter(Boolean);
  }
  return rank(q, all, (c) => c.title, 80).map((r) => toItem(r.item, r.hits));
}

export function quickOpen(initial = '') {
  if (!S.ws) return;
  return picker({
    placeholder: 'Search files by name  ·  > commands  ·  : line  ·  @ symbol', initial,
    source: (q) => (q.startsWith('>') ? commandItems(q.slice(1).trim()) : fileItems(q.trim())),
    onQuery: (q, close) => {
      if (q.startsWith(':') && E.activeFile()) { close(); exec('editor.gotoLine'); return true; }
      if (q.startsWith('@') && E.activeFile()) { close(); exec('editor.gotoSymbol'); return true; }
      return false;
    },
  });
}
export const commandPalette = () => picker({ placeholder: 'Type a command', initial: '', source: (q) => commandItems(q.replace(/^>\s*/, '').trim()) });
export const pickFile = (placeholder = 'Choose a file') => picker({ placeholder, source: async (q) => (await fileItems(q.trim())).map((x) => (x.section ? x : { ...x, run: null })) });

command('palette.files', 'Go to File…', () => quickOpen(), { kbd: '⌘P', hidden: true });
command('palette.commands', 'Show All Commands', () => commandPalette(), { kbd: '⇧⌘P', hidden: true });
