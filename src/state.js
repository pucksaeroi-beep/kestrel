// Shared application state and a tiny event bus.
export const S = {
  ws: null,              // { root, name, session }
  settings: {},
  home: '',
  version: '',
  recent: [],
  providers: [],         // from main: [{ id, name, hasKey, models, ... }]
  git: null,             // { branch, files: { path: 'M'|'A'|'D'|'U'|'C' } }
  files: null,           // cached file list for quick-open
  ide: { port: 0, connected: false },
  layout: { sidebar: true, panel: false, chat: true, view: 'explorer' },
};

const DEFAULTS = {
  theme: 'dark', fontSize: 13.5, fontFamily: '', tabSize: 2, wordWrap: 'off', minimap: true, lineHeight: 0, ligatures: true,
  autoSave: 'off', formatOnSave: false, renderWhitespace: 'selection', cursorBlink: 'smooth', stickyScroll: true,
  chatProvider: 'anthropic', chatModel: 'claude-opus-5-5', effort: 'medium',
  editProvider: '', editModel: '',                   // ⌘K — empty means "same as chat"
  autocomplete: false, completeProvider: 'anthropic', completeModel: 'claude-haiku-5-5',
  terminalFontSize: 12.5, claudeCommand: 'claude', systemPrompt: '',
};
export const set = (k) => (S.settings[k] ?? DEFAULTS[k]);

export async function saveSettings(patch) {
  S.settings = await window.ks.settings.set(patch);
  emit('settings', patch);
}

const subs = new Map();
export function on(evt, fn) { if (!subs.has(evt)) subs.set(evt, new Set()); subs.get(evt).add(fn); return () => subs.get(evt).delete(fn); }
export function emit(evt, ...a) { for (const fn of subs.get(evt) || []) { try { fn(...a); } catch (e) { console.error(evt, e); } } }

// Commands: registered by views, run from menus, the palette and key bindings.
export const commands = new Map();
export function command(id, title, run, opts = {}) { commands.set(id, { id, title, run, ...opts }); }
export function exec(id, ...a) { const c = commands.get(id); if (!c) { console.warn('unknown command', id); return; } return c.run(...a); }

export const basename = (p) => p.split('/').pop();
export const dirname = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
