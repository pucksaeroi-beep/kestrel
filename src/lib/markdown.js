// Small, safe Markdown for AI replies. parse() builds a plain block list (unit-tested);
// render() turns it into DOM nodes via textContent only — model output never becomes HTML.

/** Fence info like "ts src/app.ts", "ts:src/app.ts" or "src/app.ts" → { lang, file } */
export function fenceInfo(info = '') {
  const parts = info.trim().split(/[\s:]+/).filter(Boolean);
  let lang = '', file = '';
  for (const p of parts) {
    const kv = /^(?:path|file)=(.+)$/.exec(p);
    if (kv) { file = kv[1].replace(/^["']|["']$/g, ''); continue; }
    if (!lang && !p.includes('/') && !/\.\w+$/.test(p)) lang = p.toLowerCase();
    else if (!file && (p.includes('/') || /\.\w+$/.test(p))) file = p;
  }
  if (!lang && file) lang = file.split('.').pop().toLowerCase();
  return { lang, file };
}

export function parse(src) {
  const lines = String(src).replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let para = [];
  const flush = () => { if (para.length) { blocks.push({ type: 'p', text: para.join('\n') }); para = []; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^(\s*)(```+|~~~+)(.*)$/.exec(line);
    if (fence) {
      flush();
      const mark = fence[2], code = [];
      let closed = false;
      for (i++; i < lines.length; i++) {
        if (lines[i].trim().startsWith(mark) && lines[i].trim().replace(/[`~]/g, '') === '') { closed = true; break; }
        code.push(lines[i]);
      }
      blocks.push({ type: 'code', ...fenceInfo(fence[3]), code: code.join('\n'), closed });
      continue;
    }
    const hd = /^(#{1,6})\s+(.*)$/.exec(line);
    if (hd) { flush(); blocks.push({ type: 'h', level: hd[1].length, text: hd[2] }); continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); blocks.push({ type: 'hr' }); continue; }
    if (/^\s*>/.test(line)) {
      flush();
      const q = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''));
      i--; blocks.push({ type: 'quote', text: q.join('\n') }); continue;
    }
    const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      flush();
      const ordered = /\d/.test(li[2]);
      const items = [];
      while (i < lines.length) {
        const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
        if (m) items.push({ indent: m[1].length, text: m[3] });
        else if (/^\s{2,}\S/.test(lines[i]) && items.length) items[items.length - 1].text += '\n' + lines[i].trim();
        else break;
        i++;
      }
      i--; blocks.push({ type: 'list', ordered, items }); continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(lines[i + 1] || '')) {
      flush();
      const row = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = row(line); const rows = [];
      for (i += 2; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]); i++) rows.push(row(lines[i]));
      i--; blocks.push({ type: 'table', head, rows }); continue;
    }
    if (!line.trim()) { flush(); continue; }
    para.push(line);
  }
  flush();
  return blocks;
}

/** Inline spans: [{t:'text'|'code'|'b'|'i'|'a', v, href}] */
export function inline(text) {
  const out = [];
  const re = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*|_([^_\s][^_]*)_(?![a-zA-Z0-9])|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s)<]+[^\s.,;:!?)<'"])/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ t: 'text', v: text.slice(last, m.index) });
    if (m[2] != null) out.push({ t: 'code', v: m[2].trim() === '' ? m[2] : m[2].replace(/^ (.*) $/, '$1') });
    else if (m[3] != null || m[4] != null) out.push({ t: 'b', v: m[3] ?? m[4] });
    else if (m[5] != null || m[6] != null) out.push({ t: 'i', v: m[5] ?? m[6] });
    else if (m[7] != null) out.push({ t: 'a', v: m[7], href: m[8] });
    else if (m[9] != null) out.push({ t: 'a', v: m[9], href: m[9] });
    last = re.lastIndex;
  }
  if (last < text.length) out.push({ t: 'text', v: text.slice(last) });
  return out;
}

// ---------------- DOM ----------------
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

function renderInline(parent, text, opts) {
  for (const s of inline(text)) {
    if (s.t === 'text') parent.append(document.createTextNode(s.v));
    else if (s.t === 'code') { const c = el('code', 'md-ic', s.v); if (opts.onInlineCode) opts.onInlineCode(c, s.v); parent.append(c); }
    else if (s.t === 'b') { const b = el('strong'); renderInline(b, s.v, opts); parent.append(b); }
    else if (s.t === 'i') { const b = el('em'); renderInline(b, s.v, opts); parent.append(b); }
    else if (s.t === 'a') { const a = el('a', 'md-a', s.v); a.href = '#'; a.title = s.href; a.addEventListener('click', (e) => { e.preventDefault(); opts.onLink?.(s.href); }); parent.append(a); }
  }
}

/** opts: { codeBlock(block) → Element, onLink(href), onInlineCode(el, text) } */
export function render(src, opts = {}) {
  const frag = document.createDocumentFragment();
  for (const b of parse(src)) {
    if (b.type === 'p') { const p = el('p'); renderInline(p, b.text, opts); frag.append(p); }
    else if (b.type === 'h') { const h = el('h' + Math.min(6, b.level + 1), 'md-h'); renderInline(h, b.text, opts); frag.append(h); }
    else if (b.type === 'hr') frag.append(el('hr'));
    else if (b.type === 'quote') { const q = el('blockquote'); q.append(render(b.text, opts)); frag.append(q); }
    else if (b.type === 'list') {
      const l = el(b.ordered ? 'ol' : 'ul');
      for (const it of b.items) { const li = el('li'); if (it.indent >= 2) li.className = 'md-sub'; renderInline(li, it.text, opts); l.append(li); }
      frag.append(l);
    } else if (b.type === 'table') {
      const wrap = el('div', 'md-table'); const t = el('table'); const tr = el('tr');
      for (const c of b.head) { const th = el('th'); renderInline(th, c, opts); tr.append(th); }
      t.append(tr);
      for (const r of b.rows) { const row = el('tr'); for (const c of r) { const td = el('td'); renderInline(td, c, opts); row.append(td); } t.append(row); }
      wrap.append(t); frag.append(wrap);
    } else if (b.type === 'code') frag.append(opts.codeBlock ? opts.codeBlock(b) : Object.assign(el('pre'), { textContent: b.code }));
  }
  return frag;
}
