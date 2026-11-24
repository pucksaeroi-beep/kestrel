// Find in files + the Source Control list (changed files vs HEAD).
import { S, on, command, exec, basename, dirname } from '../state.js';
import { h, icon, clear, toast, debounce } from '../ui/h.js';
import { badgeOf } from '../lib/lang.js';
import * as E from '../editor/editors.js';

// ---------------- search ----------------
let sHost, qInput, incInput, resultsEl, opts = { regex: false, caseSensitive: false, wholeWord: false }, collapsed = new Set(), seq = 0;

export function mountSearch(el) {
  sHost = el;
  qInput = h('input', { class: 'input search-q', placeholder: 'Search', spellcheck: 'false', oninput: debounce(run, 250), onkeydown: (e) => { if (e.key === 'Enter') run(); } });
  incInput = h('input', { class: 'input sm', placeholder: 'files to include, e.g. src/**, *.ts', spellcheck: 'false', oninput: debounce(run, 300) });
  const tog = (k, label, title) => h('button', { class: 'tog' + (opts[k] ? ' on' : ''), title, onclick: (e) => { opts[k] = !opts[k]; e.currentTarget.classList.toggle('on', opts[k]); run(); } }, label);
  resultsEl = h('div', { class: 'results' });
  el.append(
    h('div', { class: 'side-head' }, h('span', { class: 'side-title' }, 'Search')),
    h('div', { class: 'search-box' },
      h('div', { class: 'search-row' }, qInput, h('div', { class: 'togs' }, tog('caseSensitive', 'Aa', 'Match Case'), tog('wholeWord', 'ab', 'Match Whole Word'), tog('regex', '.*', 'Use Regular Expression'))),
      incInput),
    resultsEl);
}

async function run() {
  const q = qInput.value;
  const my = ++seq;
  clear(resultsEl);
  if (!q) return;
  resultsEl.append(h('div', { class: 'muted pad' }, 'Searching…'));
  let r;
  try { r = await window.ks.fs.search(q, { ...opts, include: incInput.value }); } catch (e) { clear(resultsEl); resultsEl.append(h('div', { class: 'pad err' }, e.message)); return; }
  if (my !== seq) return;
  clear(resultsEl);
  resultsEl.append(h('div', { class: 'muted pad sm' }, r.total ? `${r.total}${r.capped ? '+' : ''} results in ${r.results.length} files` : 'No results'));
  for (const f of r.results) {
    const [lbl, col] = badgeOf(f.file);
    const open = !collapsed.has(f.file);
    const group = h('div', { class: 'rgroup' });
    group.append(h('div', { class: 'rfile', onclick: () => { open ? collapsed.add(f.file) : collapsed.delete(f.file); run(); } },
      icon(open ? 'chevronDown' : 'chevronRight', 'twisty'), h('span', { class: 'fbadge', style: { color: col } }, lbl),
      h('span', { class: 'name' }, basename(f.file)), h('span', { class: 'muted sm ell' }, dirname(f.file)), h('span', { class: 'count' }, f.matches.length)));
    if (open) for (const m of f.matches) {
      const start = Math.max(0, m.col - 1 - 30);
      const pre = (start ? '…' : '') + m.text.slice(start, m.col - 1).trimStart();
      group.append(h('div', { class: 'rline', title: `${f.file}:${m.line}`, onclick: () => E.open(f.file, { line: m.line, col: m.col, len: m.len, preview: true }) },
        h('span', { class: 'ln' }, m.line), h('span', { class: 'rtext' }, pre, h('mark', {}, m.text.substr(m.col - 1, m.len)), m.text.slice(m.col - 1 + m.len, m.col - 1 + m.len + 120))));
    }
    resultsEl.append(group);
  }
}

command('search.focus', 'Search: Find in Files', (text) => {
  exec('view.show', 'search');
  const sel = text ?? (() => { const ed = E.getEditor(); const s = ed?.getSelection(); return s && !s.isEmpty() && s.startLineNumber === s.endLineNumber ? ed.getModel().getValueInRange(s) : ''; })();
  if (sel) qInput.value = sel;
  requestAnimationFrame(() => { qInput.focus(); qInput.select(); });
  if (sel) run();
});
command('search.inFolder', 'Search: Find in Folder', (p) => { exec('view.show', 'search'); incInput.value = p + '/**'; qInput.focus(); run(); });

// ---------------- source control ----------------
let gHost;
export function mountScm(el) {
  gHost = el;
  on('git', renderScm);
  renderScm();
}

function renderScm() {
  if (!gHost) return;
  clear(gHost);
  gHost.append(h('div', { class: 'side-head' }, h('span', { class: 'side-title' }, 'Source Control'),
    h('div', { class: 'side-actions' }, h('button', { class: 'ibtn', title: 'Refresh', onclick: () => exec('git.refresh') }, icon('refresh')))));
  if (!S.git) { gHost.append(h('div', { class: 'pad muted' }, 'This folder is not a git repository.')); return; }
  const files = Object.entries(S.git.files).sort((a, b) => a[0].localeCompare(b[0]));
  gHost.append(h('div', { class: 'scm-branch' }, icon('branch'), h('b', {}, S.git.branch || 'HEAD'), h('span', { class: 'muted' }, files.length ? `${files.length} changed` : 'clean')));
  if (!files.length) { gHost.append(h('div', { class: 'pad muted tcenter' }, icon('check', 'big'), h('p', {}, 'No changes'))); return; }
  const listEl = h('div', { class: 'scm-list' });
  for (const [f, st] of files) {
    const [lbl, col] = badgeOf(f);
    listEl.append(h('div', { class: 'row git-' + st, title: f, onclick: () => (st === 'D' || st === 'U' || st === 'A' ? (st === 'D' ? diffFile(f) : E.open(f)) : diffFile(f)) },
      h('span', { class: 'fbadge', style: { color: col } }, lbl), h('span', { class: 'name' }, basename(f)), h('span', { class: 'muted sm ell' }, dirname(f)), h('span', { class: 'gbadge' }, st)));
  }
  gHost.append(listEl, h('div', { class: 'pad muted sm' }, 'Tip: ask Claude Code to write the commit, or open the folder in your git client.'));
}

async function diffFile(f) {
  const [head, cur] = await Promise.all([window.ks.git.head(f), window.ks.fs.read(f).then((r) => r.text ?? '').catch(() => '')]);
  E.openDiff({ id: 'git:' + f, title: basename(f), sub: 'HEAD ↔ Working Tree', badge: 'Git', path: f, original: head ?? '', modified: cur,
    actions: [{ label: 'Open File', run: (t) => { E.close(t.id); E.open(f, { pin: true }); } }] });
}
command('git.diffFile', 'Git: Compare with HEAD', (f = E.activeFile()) => f && diffFile(f));
