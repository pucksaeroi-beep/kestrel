// Tiny DOM helpers. User data always goes in through textContent, never innerHTML.
import { ICONS } from './icons.js';

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') for (const [sk, sv] of Object.entries(v)) { if (sk.startsWith('--')) el.style.setProperty(sk, sv); else el.style[sk] = sv; }
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

/** Static SVG icon (trusted strings from icons.js only). */
export function icon(name, cls = '') {
  const s = document.createElement('span');
  s.className = 'ic ' + cls;
  s.innerHTML = ICONS[name] || '';
  return s;
}

export const $ = (sel, root = document) => root.querySelector(sel);
/** append() that skips null/false (DOM append would print "null"). */
export const add = (el, ...kids) => { el.append(...kids.flat(Infinity).filter((k) => k != null && k !== false)); return el; };
export const clear = (el) => { while (el.firstChild) el.firstChild.remove(); return el; };
export const uid = (p = '') => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export function debounce(fn, ms) {
  let t;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.flush = (...a) => { clearTimeout(t); fn(...a); };
  d.cancel = () => clearTimeout(t);
  return d;
}

export function fmtRelative(ts) {
  const sec = Math.round((Date.now() - ts) / 1000);
  if (sec < 45) return 'just now';
  const units = [[60, 'minute'], [3600, 'hour'], [86400, 'day'], [604800, 'week'], [2629800, 'month'], [31557600, 'year']];
  let u = units[0];
  for (const x of units) if (sec >= x[0]) u = x;
  const n = Math.max(1, Math.round(sec / u[0]));
  return `${n} ${u[1]}${n > 1 ? 's' : ''} ago`;
}
export function fmtDate(ts, withTime = true) {
  const d = new Date(ts);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) + (withTime ? ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '');
}

// ---------------- toast ----------------
export function toast(msg, kind = '', ms) {
  let host = $('#toasts');
  if (!host) { host = h('div', { id: 'toasts' }); document.body.append(host); }
  const close = () => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); };
  const t = h('div', { class: 'toast ' + kind }, icon(kind === 'error' ? 'alert' : 'check'), h('div', { class: 'toast-msg' }, msg),
    kind === 'error' ? h('button', { class: 'toast-x', onclick: close }, icon('x')) : null);
  host.append(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(close, ms ?? (kind === 'error' ? 9000 : 2600));
}

// ---------------- popup menu ----------------
let openMenu = null;
export function closeMenu() { openMenu?.remove(); openMenu = null; }

/**
 * items: [{label, icon, kbd, danger, checked, onClick, submenu:[...]} | '-' | {header}]
 * at: MouseEvent | {x,y} | Element (menu opens under it)
 */
export function popupMenu(items, at, opts = {}) {
  closeMenu();
  const m = h('div', { class: 'menu ' + (opts.class || ''), role: 'menu' });
  for (const it of items) {
    if (!it) continue;
    if (it === '-') { m.append(h('div', { class: 'menu-sep' })); continue; }
    if (it.header) { m.append(h('div', { class: 'menu-header' }, it.header)); continue; }
    if (it.el) { m.append(it.el); continue; }
    const row = h('button', { class: 'menu-item' + (it.danger ? ' danger' : '') + (it.checked ? ' checked' : ''), disabled: it.disabled },
      it.icon ? icon(it.icon) : h('span', { class: 'ic' }),
      h('span', { class: 'menu-label', style: it.style }, it.label),
      it.kbd ? h('span', { class: 'kbd' }, it.kbd) : null,
      it.checked ? icon('check', 'menu-check') : null);
    row.addEventListener('click', (e) => { e.stopPropagation(); if (!it.keepOpen) closeMenu(); it.onClick?.(e); });
    m.append(row);
  }
  document.body.append(m);
  place(m, at);
  openMenu = m;
  setTimeout(() => {
    const off = (e) => { if (!m.contains(e.target)) { closeMenu(); document.removeEventListener('mousedown', off, true); } };
    document.addEventListener('mousedown', off, true);
  });
  return m;
}

export function place(el, at) {
  let x, y;
  if (at instanceof Element) { const r = at.getBoundingClientRect(); x = r.left; y = r.bottom + 4; }
  else if (at && 'clientX' in at) { x = at.clientX; y = at.clientY; }
  else { x = at?.x ?? 100; y = at?.y ?? 100; }
  el.style.left = '0px'; el.style.top = '0px';
  const r = el.getBoundingClientRect();
  x = Math.max(8, Math.min(x, innerWidth - r.width - 8));
  if (y + r.height > innerHeight - 8) y = Math.max(8, (at instanceof Element ? at.getBoundingClientRect().top - r.height - 4 : y - r.height));
  el.style.left = x + 'px'; el.style.top = y + 'px';
}

// ---------------- popover (anchored panel) ----------------
export function popover(content, anchor, opts = {}) {
  closeMenu();
  const p = h('div', { class: 'menu popover ' + (opts.class || '') }, content);
  document.body.append(p);
  place(p, anchor);
  openMenu = p;
  setTimeout(() => {
    const off = (e) => { if (!p.contains(e.target)) { closeMenu(); document.removeEventListener('mousedown', off, true); } };
    document.addEventListener('mousedown', off, true);
  });
  return p;
}

// ---------------- modal dialogs ----------------
export function modal(title, body, actions = [], opts = {}) {
  return new Promise((resolve) => {
    const back = h('div', { class: 'modal-back' });
    const close = (v) => { back.classList.remove('show'); setTimeout(() => back.remove(), 180); document.removeEventListener('keydown', key, true); resolve(v); };
    const key = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(undefined); }
      if (e.key === 'Enter' && !e.shiftKey && e.target.tagName !== 'TEXTAREA') {
        const primary = actions.find((a) => a.primary);
        if (primary) { e.preventDefault(); primary.onClick ? primary.onClick(close) : close(primary.value); }
      }
    };
    const dlg = h('div', { class: 'modal ' + (opts.class || '') },
      title ? h('h3', {}, title) : null,
      h('div', { class: 'modal-body' }, body),
      actions.length ? h('div', { class: 'modal-actions' }, actions.map((a) =>
        h('button', { class: 'btn ' + (a.primary ? 'primary' : '') + (a.danger ? ' danger' : ''),
          onclick: () => (a.onClick ? a.onClick(close) : close(a.value)) }, a.label))) : null);
    back.append(dlg);
    back.addEventListener('mousedown', (e) => { if (e.target === back && !opts.sticky) close(undefined); });
    document.body.append(back);
    document.addEventListener('keydown', key, true);
    requestAnimationFrame(() => { back.classList.add('show'); dlg.querySelector('input,textarea,select')?.focus(); });
  });
}

export async function prompt(title, value = '', opts = {}) {
  const input = h('input', { class: 'input', value, placeholder: opts.placeholder || '', type: opts.type || 'text' });
  const r = await modal(title, [opts.message ? h('p', { class: 'muted' }, opts.message) : null, input], [
    { label: 'Cancel', value: undefined },
    { label: opts.ok || 'OK', primary: true, onClick: (close) => close(input.value) },
  ]);
  return r;
}

export async function confirm(title, message, okLabel = 'OK', danger = false) {
  return !!(await modal(title, typeof message === 'string' ? h('p', {}, message) : message, [
    { label: 'Cancel', value: false }, { label: okLabel, primary: true, danger, value: true }]));
}

