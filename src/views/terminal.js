// Terminals (xterm.js + node-pty in the main process). Used by the bottom panel and the Claude Code pane.
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { S, set, on, emit, command, exec } from '../state.js';
import { h, icon, clear, popupMenu } from '../ui/h.js';
import { themeName } from '../editor/editors.js';

const all = new Map(); // ptyId → term record
window.ks.pty.onData((id, d) => all.get(id)?.term.write(d));
window.ks.pty.onExit((id, code) => { const t = all.get(id); if (t) { t.exited = true; t.term.write(`\r\n\x1b[2m[process exited with code ${code}]\x1b[0m\r\n`); t.onExit?.(code); } });

export function xtermTheme() {
  const dark = themeName() === 'kestrel-dark';
  return dark ? {
    background: '#0f1116', foreground: '#dfe3ea', cursor: '#ff8a50', cursorAccent: '#0f1116', selectionBackground: '#ff7a4544',
    black: '#1b1e26', red: '#ff6b6b', green: '#5fd19a', yellow: '#ffcb6b', blue: '#7cb4ff', magenta: '#c79bff', cyan: '#5fd3e0', white: '#dfe3ea',
    brightBlack: '#5f6b7d', brightRed: '#ff8a8a', brightGreen: '#7fe0b0', brightYellow: '#ffd98f', brightBlue: '#9cc8ff', brightMagenta: '#d9b8ff', brightCyan: '#86e3ec', brightWhite: '#ffffff',
  } : {
    background: '#fbfbfc', foreground: '#1f2430', cursor: '#f05a1a', cursorAccent: '#ffffff', selectionBackground: '#ff7a4533',
    black: '#1f2430', red: '#d23c3c', green: '#1f8a4c', yellow: '#a5690a', blue: '#1f63c9', magenta: '#8a3fd1', cyan: '#0e7f8c', white: '#c9ced8',
    brightBlack: '#6b7280', brightRed: '#e5484d', brightGreen: '#2fb36a', brightYellow: '#c2860c', brightBlue: '#3b82f6', brightMagenta: '#a25ce0', brightCyan: '#15a3b3', brightWhite: '#ffffff',
  };
}

/** Create a terminal inside `el`. Returns { id, term, fit(), focus(), dispose(), write(text) }. */
export async function createTerminal(el, { cwd, command: cmd, onExit, onTitle } = {}) {
  const term = new Terminal({
    fontFamily: "'JetBrains Mono', 'SF Mono', Menlo, monospace", fontSize: set('terminalFontSize'), lineHeight: 1.25, cursorBlink: true, cursorStyle: 'bar',
    allowProposedApi: true, macOptionIsMeta: true, scrollback: 10000, theme: xtermTheme(), drawBoldTextInBrightColors: false, minimumContrastRatio: 1.1,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon((_e, url) => window.ks.shell.external(url)));
  term.open(el);
  try { fit.fit(); } catch { /* hidden */ }
  const id = await window.ks.pty.create({ cols: term.cols, rows: term.rows, cwd, command: cmd });
  const rec = { id, term, onExit, exited: false };
  all.set(id, rec);
  term.onData((d) => window.ks.pty.write(id, d));
  term.onResize(({ cols, rows }) => window.ks.pty.resize(id, cols, rows));
  term.onTitleChange((t) => onTitle?.(t));
  // ⌘K clears like Terminal.app; ⌘← / ⌘→ jump to line start/end; ⇧↵ inserts a newline (Claude Code multi-line prompts)
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    if (e.metaKey && e.key === 'k') { term.clear(); return false; }
    if (e.metaKey && e.key === 'ArrowLeft') { window.ks.pty.write(id, '\x01'); return false; }
    if (e.metaKey && e.key === 'ArrowRight') { window.ks.pty.write(id, '\x05'); return false; }
    if (e.metaKey && e.key === 'Backspace') { window.ks.pty.write(id, '\x15'); return false; }
    if (e.altKey && e.key === 'ArrowLeft') { window.ks.pty.write(id, '\x1bb'); return false; }
    if (e.altKey && e.key === 'ArrowRight') { window.ks.pty.write(id, '\x1bf'); return false; }
    if (e.shiftKey && e.key === 'Enter') { window.ks.pty.write(id, '\x1b\r'); return false; }
    if (e.metaKey) return false; // let app shortcuts through
    return true;
  });
  // drop files from the explorer → paste their (quoted) paths
  el.addEventListener('dragover', (e) => e.preventDefault());
  el.addEventListener('drop', async (e) => {
    e.preventDefault();
    const p = e.dataTransfer.getData('text/kestrel-path');
    if (p) window.ks.pty.write(id, quote(p) + ' ');
    term.focus();
  });
  const ro = new ResizeObserver(() => { if (el.offsetParent) try { fit.fit(); } catch { /* ignore */ } });
  ro.observe(el);
  const off = on('settings', () => { term.options.theme = xtermTheme(); term.options.fontSize = set('terminalFontSize'); try { fit.fit(); } catch { /* ignore */ } });
  return {
    id, term,
    fit: () => { try { fit.fit(); } catch { /* ignore */ } },
    focus: () => term.focus(),
    write: (t) => window.ks.pty.write(id, t),
    get exited() { return rec.exited; },
    dispose: () => { ro.disconnect(); off(); window.ks.pty.kill(id); all.delete(id); term.dispose(); },
  };
}
const quote = (p) => (/^[\w./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`);

// ---------------- bottom panel ----------------
let panel, strip, body, terms = [], cur = null;

export function mountPanel(el) {
  panel = el;
  strip = h('div', { class: 'panel-tabs' });
  body = h('div', { class: 'panel-body' });
  el.append(h('div', { class: 'panel-head' }, strip, h('div', { class: 'panel-actions' },
    h('button', { class: 'ibtn', title: 'New Terminal', onclick: () => newTerminal() }, icon('plus')),
    h('button', { class: 'ibtn', title: 'Kill Terminal', onclick: () => cur && killTerminal(cur) }, icon('trash')),
    h('button', { class: 'ibtn', title: 'Hide Panel (⌘J)', onclick: () => exec('layout.panel', false) }, icon('chevronDown')))), body);
}

function renderStrip() {
  clear(strip);
  for (const t of terms) {
    strip.append(h('div', { class: 'ptab' + (t === cur ? ' active' : ''), onclick: () => select(t), oncontextmenu: (e) => { e.preventDefault(); popupMenu([{ label: 'Kill Terminal', danger: true, onClick: () => killTerminal(t) }], e); } },
      icon(t.claude ? 'claude' : 'terminal'), h('span', {}, t.title), h('button', { class: 'tab-x', onclick: (e) => { e.stopPropagation(); killTerminal(t); } }, icon('close'))));
  }
}
function select(t) {
  cur = t;
  for (const x of terms) x.el.style.display = x === t ? '' : 'none';
  renderStrip();
  requestAnimationFrame(() => { t.handle?.fit(); t.handle?.focus(); });
}

export async function newTerminal({ cwd, command: cmd, title } = {}) {
  if (!S.ws) return;
  exec('layout.panel', true);
  const el = h('div', { class: 'term-host' });
  body.append(el);
  const t = { el, title: title || 'zsh', claude: /claude/.test(cmd || '') };
  terms.push(t);
  select(t);
  t.handle = await createTerminal(el, { cwd, command: cmd, onTitle: (s) => { if (!title) { t.title = s.split(/[:/]/).pop().trim() || 'zsh'; renderStrip(); } } });
  t.handle.focus();
  return t;
}
function killTerminal(t) {
  t.handle?.dispose(); t.el.remove();
  terms = terms.filter((x) => x !== t);
  if (cur === t) { cur = terms[terms.length - 1] || null; if (cur) select(cur); else exec('layout.panel', false); }
  renderStrip();
}
export function killAll() { for (const t of [...terms]) killTerminal(t); }
export function panelShown() { if (!terms.length) newTerminal(); else requestAnimationFrame(() => { cur?.handle?.fit(); cur?.handle?.focus(); }); }

command('terminal.new', 'Terminal: New Terminal', (o) => newTerminal(o));
command('terminal.toggle', 'View: Toggle Terminal', () => {
  if (S.layout.panel && cur && document.activeElement?.closest('.panel')) exec('layout.panel', false);
  else { exec('layout.panel', true); panelShown(); }
});
command('terminal.runSelection', 'Terminal: Run Selected Text', async () => {
  const { getEditor } = await import('../editor/editors.js');
  const ed = getEditor(); const s = ed.getSelection();
  const text = s && !s.isEmpty() ? ed.getModel().getValueInRange(s) : ed.getModel()?.getLineContent(ed.getPosition().lineNumber);
  if (!text) return;
  if (!cur) await newTerminal(); else exec('layout.panel', true);
  cur.handle.write(text.replace(/\n/g, '\r') + '\r');
});
