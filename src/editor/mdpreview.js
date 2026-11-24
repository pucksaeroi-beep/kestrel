// Markdown preview: GitHub-flavoured rendering (marked + DOMPurify), live while you type,
// with local images, syntax-coloured code blocks, working links and scroll sync with the editor.
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { monaco } from './monaco.js';
import { h, icon, clear } from '../ui/h.js';

marked.setOptions({ gfm: true, breaks: false });
// keep the browser from fetching relative image paths against ks://app/ — decorate() loads them from the workspace
DOMPurify.addHook('afterSanitizeAttributes', (n) => {
  if (n.tagName === 'IMG' && n.hasAttribute('src') && !/^(https:|data:image\/)/i.test(n.getAttribute('src'))) { n.setAttribute('data-src', n.getAttribute('src')); n.removeAttribute('src'); }
  if (n.tagName === 'INPUT') n.setAttribute('disabled', '');
});

const ALIAS = { js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', tsx: 'typescript', sh: 'shell', bash: 'shell', zsh: 'shell', console: 'shell',
  py: 'python', rb: 'ruby', yml: 'yaml', md: 'markdown', rs: 'rust', kt: 'kotlin', cs: 'csharp', 'c++': 'cpp', jsonc: 'json', json5: 'json', html: 'html', xml: 'xml', vue: 'html', svelte: 'html' };
const known = () => new Set(monaco.languages.getLanguages().map((l) => l.id));

export const isMarkdown = (p) => /\.(md|markdown|mdx|mdown|mkd)$/i.test(p || '');

/** Split the source into top-level blocks so each rendered block knows its source line (for scroll sync). */
export function toHtml(src) {
  const tokens = marked.lexer(String(src));
  let line = 0, out = '';
  for (const t of tokens) {
    const start = line;
    line += (t.raw.match(/\n/g) || []).length;
    if (t.type === 'space') continue;
    const one = [t]; one.links = tokens.links;
    out += `<div class="mdp-blk" data-line="${start}">${marked.parser(one)}</div>`;
  }
  return DOMPurify.sanitize(out, { ADD_ATTR: ['align'], FORBID_TAGS: ['style', 'form', 'button', 'textarea', 'select', 'iframe'], FORBID_ATTR: ['style'] });
}

const slug = (s) => s.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-');
const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
function resolveRel(base, href) {
  const parts = (dirOf(base) ? dirOf(base).split('/') : []);
  for (const seg of href.replace(/^\.\//, '').split('/')) {
    if (seg === '..') parts.pop(); else if (seg && seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

export function createPreview(host, { onOpen, onModeChange, onScrollTo }) {
  const title = h('span', { class: 'mdp-title ell' });
  const modeBtn = h('button', { class: 'ibtn', onclick: () => onModeChange(mode === 'only' ? 'side' : 'only') });
  const bar = h('div', { class: 'mdp-bar' }, icon('eye'), title, h('span', { class: 'grow' }), modeBtn,
    h('button', { class: 'ibtn', title: 'Close Preview (⇧⌘V)', onclick: () => onModeChange(null) }, icon('close')));
  const body = h('div', { class: 'mdp-body md-doc' });
  const scroller = h('div', { class: 'mdp-scroll' }, body);
  host.append(bar, scroller);

  let path = null, mode = null, imgCache = new Map(), lock = 0;

  body.addEventListener('click', (e) => {
    const a = e.target.closest('a');
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute('href') || '';
    if (/^(https?:|mailto:)/i.test(href)) return window.ks.shell.external(href);
    if (href.startsWith('#')) return scrollToAnchor(decodeURIComponent(href.slice(1)));
    const [file, anchor] = href.split('#');
    if (!file) return;
    onOpen(resolveRel(path, decodeURIComponent(file)), anchor);
  });

  function scrollToAnchor(id) {
    const el = body.querySelector(`[id="${CSS.escape(id)}"]`);
    if (el) scroller.scrollTo({ top: el.offsetTop - 12, behavior: 'smooth' });
  }

  async function loadImage(img, src) {
    const rel = resolveRel(path, decodeURIComponent(src.split(/[?#]/)[0]));
    if (!imgCache.has(rel)) {
      imgCache.set(rel, window.ks.fs.read(rel).then((r) => {
        if (r.data) return `data:image/${r.ext === 'jpg' ? 'jpeg' : r.ext === 'ico' ? 'x-icon' : r.ext};base64,${r.data}`;
        if (r.text != null && /\.svg$/i.test(rel)) return 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(r.text)));
        return null;
      }).catch(() => null));
    }
    const url = await imgCache.get(rel);
    if (url) img.src = url; else img.classList.add('broken');
  }

  function decorate() {
    for (const hd of body.querySelectorAll('h1,h2,h3,h4,h5,h6')) if (!hd.id) hd.id = slug(hd.textContent);
    for (const img of body.querySelectorAll('img[data-src]')) {
      const src = img.getAttribute('data-src');
      if (src && !/^[a-z]+:/i.test(src)) loadImage(img, src); else img.classList.add('broken');
    }
    for (const a of body.querySelectorAll('a[href]')) a.title = a.getAttribute('href');
    const langs = known();
    for (const code of body.querySelectorAll('pre > code')) {
      const m = /language-([\w+#-]+)/.exec(code.className);
      let lang = m ? m[1].toLowerCase() : '';
      lang = ALIAS[lang] || lang;
      if (!langs.has(lang)) continue;
      const text = code.textContent;
      monaco.editor.colorize(text, lang, { tabSize: 2 }).then((html) => { if (code.isConnected && code.textContent === text) code.innerHTML = html; }).catch(() => {});
    }
  }

  function update(p, text) {
    if (p !== path) { path = p; imgCache = new Map(); scroller.scrollTop = 0; }
    title.textContent = p.split('/').pop();
    const y = scroller.scrollTop;
    body.innerHTML = toHtml(text);
    decorate();
    scroller.scrollTop = y;
  }

  function setMode(m) {
    mode = m;
    clear(modeBtn);
    modeBtn.append(icon(m === 'only' ? 'split' : 'eye'));
    modeBtn.title = m === 'only' ? 'Show Editor Beside' : 'Preview Only';
  }

  // ---- scroll sync (line based)
  const blocks = () => [...body.querySelectorAll('.mdp-blk')];
  function scrollToLine(line) {
    if (lock === 2) return;
    const bs = blocks();
    if (!bs.length) return;
    let i = bs.findIndex((b) => +b.dataset.line > line) - 1;
    if (i === -2) i = bs.length - 1; else if (i < 0) i = 0;
    const a = bs[i], b = bs[i + 1];
    const la = +a.dataset.line, lb = b ? +b.dataset.line : la + 1;
    const ya = a.offsetTop, yb = b ? b.offsetTop : a.offsetTop + a.offsetHeight;
    const frac = Math.min(1, Math.max(0, (line - la) / Math.max(1, lb - la)));
    lock = 1;
    scroller.scrollTop = ya + (yb - ya) * frac - 8;
    setTimeout(() => { if (lock === 1) lock = 0; }, 80);
  }
  scroller.addEventListener('scroll', () => {
    if (lock === 1 || mode !== 'side') return;
    const top = scroller.scrollTop + 8;
    const bs = blocks();
    let i = bs.findIndex((b) => b.offsetTop > top) - 1;
    if (i === -2) i = bs.length - 1; else if (i < 0) i = 0;
    const a = bs[i], b = bs[i + 1];
    if (!a) return;
    const la = +a.dataset.line, lb = b ? +b.dataset.line : la + 1;
    const frac = Math.min(1, Math.max(0, (top - a.offsetTop) / Math.max(1, (b ? b.offsetTop : a.offsetTop + a.offsetHeight) - a.offsetTop)));
    lock = 2;
    onScrollTo(la + (lb - la) * frac);
    clearTimeout(scroller._t); scroller._t = setTimeout(() => { lock = 0; }, 120);
  });

  return { update, setMode, scrollToLine, scrollToAnchor, get path() { return path; } };
}
