'use strict';
const { app, BrowserWindow, ipcMain, protocol, net, dialog, shell, clipboard, Menu, nativeTheme, session } = require('electron');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { pathToFileURL } = require('url');
const W = require('./workspace.cjs');
const { createAI } = require('./ai.cjs');
const { createIdeBridge } = require('./ide.cjs');
const { createAgent } = require('./agent.cjs');

app.setName('Kestrel');
// Test hooks: a throwaway data dir + a scripted run that takes screenshots. Ignored in normal use.
if (process.env.KS_USER_DATA) app.setPath('userData', process.env.KS_USER_DATA);
const DEV_URL = process.env.VITE_DEV_SERVER_URL;
const DIST = path.join(__dirname, '..', 'dist');
const DATA = app.getPath('userData');
const CONFIG = path.join(DATA, 'config.json');
const VERSION = require('../package.json').version;

protocol.registerSchemesAsPrivileged([{ scheme: 'ks', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

// ---------------- config ----------------
let config = {};
try { config = JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { config = {}; }
config.recent ||= []; config.settings ||= {}; config.providers ||= {}; config.sessions ||= {};
let saveT = null;
function saveConfig(now) {
  clearTimeout(saveT);
  const w = () => { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(CONFIG, JSON.stringify(config, null, 2)); };
  if (now) w(); else saveT = setTimeout(w, 300);
}

// Login-shell PATH so git, node, claude… resolve like they do in Terminal.
let loginPath = process.env.PATH;
execFile(process.env.SHELL || '/bin/zsh', ['-ilc', 'printf "__P__%s__P__" "$PATH"'], { timeout: 5000 }, (_e, out) => {
  const m = /__P__(.*)__P__/.exec(out || ''); if (m) { loginPath = m[1]; W.setPath(loginPath); }
});

// ---------------- workspace ----------------
let ws = null; // createWorkspace(root)
let watcher = null;
function openWorkspace(dir) {
  const real = fs.realpathSync(path.resolve(dir));
  if (!fs.statSync(real).isDirectory()) throw new Error('Not a folder: ' + dir);
  closeWorkspace();
  ws = W.createWorkspace(real);
  config.workspace = real;
  config.recent = [real, ...config.recent.filter((r) => r !== real)].slice(0, 15);
  saveConfig();
  watch(real);
  ide.updateFolders();
  win?.setRepresentedFilename(real);
  win?.setTitle(path.basename(real) + ' — Kestrel');
  return wsInfo();
}
function closeWorkspace() {
  watcher?.close(); watcher = null; ws = null;
  for (const id of [...ptys.keys()]) killPty(id);
  agent.closeAll();
}
function wsInfo() { return ws ? { root: ws.root, name: path.basename(ws.root), session: config.sessions[ws.root] || null } : null; }
function need() { if (!ws) throw new Error('No folder is open'); return ws; }

function watch(root) {
  let t = null; const changed = new Set();
  const flush = () => { const list = [...changed]; changed.clear(); win?.webContents.send('fs:changed', list); };
  try {
    watcher = fs.watch(root, { recursive: true }, (_ev, f) => {
      const s = f ? String(f) : '';
      if (/(^|\/)(node_modules|\.next|\.turbo|\.cache|target|\.venv|__pycache__)(\/|$)/.test(s)) return;
      if (s.startsWith('.git/') && !/^\.git\/(HEAD|index)$/.test(s)) return;
      changed.add(s);
      clearTimeout(t); t = setTimeout(flush, 250);
    });
  } catch { /* volumes without FSEvents: refresh on focus instead */ }
}

// ---------------- terminals ----------------
// `claude` may be shadowed by a broken install (e.g. an npm package whose native binary never downloaded).
// Find a real executable: PATH first, then the native installer, Homebrew, and editor-bundled copies.
function resolveClaude() {
  const home = app.getPath('home');
  const ok = (f) => { try { fs.accessSync(f, fs.constants.X_OK); return fs.statSync(f).size > 100 * 1024; } catch { return false; } };
  const cands = [...loginPath.split(':').map((d) => path.join(d, 'claude')), path.join(home, '.local/bin/claude'), path.join(home, '.claude/local/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'];
  for (const base of [path.join(home, '.vscode/extensions'), path.join(home, '.cursor/extensions'), path.join(home, '.windsurf/extensions')]) {
    try { for (const d of fs.readdirSync(base).filter((n) => n.startsWith('anthropic.claude-code-')).sort().reverse()) cands.push(path.join(base, d, 'resources/native-binary/claude')); } catch { /* none */ }
  }
  for (const c of cands) if (ok(c)) return c;
  return 'claude';
}
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const ptys = new Map();
let ptySeq = 0;
function createPty({ cols = 100, rows = 30, cwd, command } = {}) {
  const pty = require('node-pty');
  const shellPath = process.env.SHELL || '/bin/zsh';
  const dir = cwd ? need().inside(cwd) : need().root;
  const env = { ...process.env, PATH: loginPath, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'Kestrel', TERM_PROGRAM_VERSION: VERSION, LANG: process.env.LANG || 'en_US.UTF-8' };
  delete env.ELECTRON_RUN_AS_NODE;
  // don't leak a parent Claude Code session (when Kestrel was started from one) into new terminals
  for (const k of Object.keys(env)) if (/^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_AGENT_SDK)/.test(k)) delete env[k];
  if (ide.port) Object.assign(env, { CLAUDE_CODE_SSE_PORT: String(ide.port), ENABLE_IDE_INTEGRATION: 'true' });
  if (command && /^claude(\s|$)/.test(command)) command = command.replace(/^claude/, shq(resolveClaude()));
  const args = command ? ['-lic', command] : ['-l'];
  const p = pty.spawn(shellPath, args, { name: 'xterm-256color', cols, rows, cwd: dir, env });
  const id = ++ptySeq;
  ptys.set(id, p);
  let buf = '', t = null; // batch output so a chatty program doesn't flood IPC
  p.onData((d) => { buf += d; if (!t) t = setTimeout(() => { win?.webContents.send('pty:data', id, buf); buf = ''; t = null; }, 8); });
  p.onExit(({ exitCode }) => { setTimeout(() => win?.webContents.send('pty:exit', id, exitCode), 20); ptys.delete(id); });
  return id;
}
function killPty(id) { try { ptys.get(id)?.kill(); } catch { /* gone */ } ptys.delete(id); }

// ---------------- AI + Claude Code bridge ----------------
const ai = createAI({ dir: DATA, getConfig: () => config, claude: { bin: () => resolveClaude(), env: () => ({ PATH: loginPath }) } });
const agent = createAgent({ bin: () => resolveClaude(), env: () => ({ PATH: loginPath }), emit: (ch, ...a) => win?.webContents.send(ch, ...a) });
const ideCalls = new Map();
let ideSeq = 0;
const ide = createIdeBridge({
  version: VERSION,
  getFolders: () => (ws ? [ws.root] : []),
  onStatus: (s) => win?.webContents.send('ide:status', s),
  call: (tool, args, signal) => {
    if (tool === 'getWorkspaceFolders') return Promise.resolve({ success: true, folders: ws ? [{ name: path.basename(ws.root), uri: pathToFileURL(ws.root).href, path: ws.root }] : [], rootPath: ws?.root || '' });
    if (!win) return Promise.reject(new Error('Kestrel window is closed'));
    const id = ++ideSeq;
    return new Promise((resolve, reject) => {
      ideCalls.set(id, { resolve, reject });
      signal.addEventListener('abort', () => { win?.webContents.send('ide:cancel', id); ideCalls.delete(id); reject(new Error('cancelled')); });
      win.webContents.send('ide:call', id, tool, args);
      win.show(); if (tool === 'openDiff' || tool === 'openFile') { if (process.platform === 'darwin') app.focus({ steal: true }); win.focus(); }
    });
  },
});

// ---------------- window ----------------
let win = null;
function createWindow() {
  const b = config.bounds || {};
  const theme = config.settings.theme || 'dark';
  const dark = theme === 'dark' || (theme === 'system' && nativeTheme.shouldUseDarkColors);
  win = new BrowserWindow({
    width: b.width || 1480, height: b.height || 940, x: b.x, y: b.y, minWidth: 860, minHeight: 560,
    titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 15, y: 13 },
    backgroundColor: dark ? '#0e1014' : '#f6f7f9', show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  });
  win.once('ready-to-show', () => win.show());
  const remember = () => { if (!win.isMinimized() && !win.isFullScreen()) { config.bounds = win.getBounds(); saveConfig(); } };
  win.on('resized', remember); win.on('moved', remember);
  win.on('focus', () => win.webContents.send('app:focus'));
  let closing = false;
  win.on('close', (e) => {
    if (closing || process.env.KS_SCRIPT) return;
    e.preventDefault();
    win.webContents.send('app:beforeClose'); // renderer asks about unsaved files, then calls app:closeNow
  });
  ipcMain.removeHandler('app:closeNow');
  ipcMain.handle('app:closeNow', () => { closing = true; win?.close(); });
  win.on('closed', () => { win = null; });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => {
    if (!(DEV_URL ? url.startsWith(DEV_URL) : url.startsWith('ks://app/'))) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); }
  });
  if (DEV_URL) win.loadURL(DEV_URL); else win.loadURL('ks://app/index.html');
  if (process.env.KS_SCRIPT) win.webContents.once('did-finish-load', () => runScript(process.env.KS_SCRIPT));
}

async function runScript(file) {
  const steps = JSON.parse(fs.readFileSync(file, 'utf8'));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  win.webContents.on('console-message', (_e, level, msg) => { if (level >= 2) console.log('[renderer]', msg); });
  await wait(2000);
  const timeout = (p, ms) => Promise.race([p, new Promise((_r, j) => setTimeout(() => j(new Error('step timed out')), ms))]);
  for (const st of steps) {
    try {
      if (st.size) win.setContentSize(st.size[0], st.size[1]);
      if (st.eval) { const r = await timeout(win.webContents.executeJavaScript(st.eval, true), st.timeout || 15000); if (r !== undefined) console.log('[eval]', JSON.stringify(r)); }
      if (st.key) win.webContents.sendInputEvent({ type: 'keyDown', keyCode: st.key, modifiers: st.mods || [] });
      if (st.type) for (const ch of st.type) win.webContents.sendInputEvent({ type: 'char', keyCode: ch });
      await wait(st.wait ?? 500);
      if (st.shot) fs.writeFileSync(st.shot, (await win.webContents.capturePage()).toPNG());
    } catch (e) { console.log('[step error]', e.message); }
  }
  saveConfig(true);
  app.exit(0);
}

// ---------------- menu ----------------
function send(cmd) { win?.webContents.send('menu', cmd); }
function buildMenu() {
  const item = (label, accelerator, cmd) => ({ label, accelerator, click: () => send(cmd) });
  const recent = config.recent.filter((r) => fs.existsSync(r)).slice(0, 10).map((r) => ({ label: r.replace(app.getPath('home'), '~'), click: () => win?.webContents.send('menu', 'open-path', r) }));
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Kestrel', submenu: [
      { role: 'about' }, { type: 'separator' }, item('Settings…', 'Cmd+,', 'settings'), item('Models & API Keys…', '', 'settings-models'), { type: 'separator' },
      { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
    { label: 'File', submenu: [
      item('New File', 'Cmd+N', 'new-file'), item('Open Folder…', 'Cmd+O', 'open'), { label: 'Open Recent', submenu: recent.length ? recent : [{ label: 'No recent folders', enabled: false }] },
      { type: 'separator' }, item('Save', 'Cmd+S', 'save'), item('Save All', 'Cmd+Alt+S', 'save-all'),
      { type: 'separator' }, item('Close Tab', 'Cmd+W', 'close-tab'), item('Close Folder', '', 'close-folder'),
      { type: 'separator' }, item('Reveal in Finder', 'Cmd+Alt+R', 'reveal')] },
    { label: 'Edit', submenu: [
      item('Undo', 'Cmd+Z', 'undo'), item('Redo', 'Shift+Cmd+Z', 'redo'), { type: 'separator' },
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }, { type: 'separator' },
      item('Find', 'Cmd+F', 'find'), item('Replace', 'Cmd+Alt+F', 'replace'), item('Find in Files', 'Cmd+Shift+F', 'search')] },
    { label: 'View', submenu: [
      item('Command Palette…', 'Cmd+Shift+P', 'palette'), item('Go to File…', 'Cmd+P', 'quick-open'), { type: 'separator' },
      item('Explorer', 'Cmd+Shift+E', 'explorer'), item('Search', '', 'search'), item('Source Control', 'Ctrl+Shift+G', 'scm'), { type: 'separator' },
      item('Toggle Sidebar', 'Cmd+B', 'toggle-sidebar'), item('Toggle Terminal', 'Ctrl+`', 'toggle-terminal'), item('Toggle Panel', 'Cmd+J', 'toggle-panel'), item('Toggle AI Chat', 'Cmd+Alt+B', 'toggle-chat'),
      { type: 'separator' }, item('Markdown Preview', 'Shift+Cmd+V', 'md-preview'),
      { type: 'separator' }, item('Zoom In', 'Cmd+=', 'zoom-in'), item('Zoom Out', 'Cmd+-', 'zoom-out'), item('Reset Zoom', 'Cmd+0', 'zoom-reset'),
      { type: 'separator' }, { role: 'togglefullscreen' }, ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' }])] },
    { label: 'Go', submenu: [
      item('Go to Line…', 'Ctrl+G', 'goto-line'), item('Go to Symbol…', 'Cmd+Shift+O', 'goto-symbol'), item('Go to Definition', 'F12', 'goto-def'),
      { type: 'separator' }, item('Next Tab', 'Cmd+Alt+Right', 'next-tab'), item('Previous Tab', 'Cmd+Alt+Left', 'prev-tab')] },
    { label: 'AI', submenu: [
      item('Chat', 'Cmd+L', 'chat'), item('Add Selection to Chat', 'Cmd+Shift+L', 'chat-add'), item('Edit with AI…', 'Cmd+K', 'inline-edit'), item('New Chat', 'Cmd+Alt+N', 'chat-new'),
      { type: 'separator' }, item('Toggle Autocomplete', '', 'toggle-autocomplete'),
      { type: 'separator' }, item('Launch Claude Code', 'Cmd+Escape', 'claude'), item('Send Selection to Claude Code', 'Cmd+Alt+K', 'claude-mention'),
      { type: 'separator' }, item('Models & API Keys…', '', 'settings-models')] },
    { role: 'windowMenu' },
  ]));
}

// ---------------- IPC ----------------
function handle(ch, fn) {
  ipcMain.handle(ch, async (_e, ...a) => {
    try { return { ok: true, value: await fn(...a) }; } catch (err) { return { ok: false, error: String(err.message || err) }; }
  });
}

function registerIpc() {
  handle('app:state', () => ({ workspace: wsInfo(), recent: config.recent.filter((r) => fs.existsSync(r)), settings: config.settings, home: app.getPath('home'), version: VERSION, ide: { port: ide.port, connected: ide.connected } }));
  handle('settings:set', (s) => {
    config.settings = { ...config.settings, ...s }; saveConfig();
    if (s.theme) nativeTheme.themeSource = s.theme;
    return config.settings;
  });
  handle('session:save', (s) => { if (ws) { config.sessions[ws.root] = s; saveConfig(); } });

  handle('ws:pick', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], message: 'Open a folder' });
    if (r.canceled) return null;
    const info = openWorkspace(r.filePaths[0]); buildMenu(); return info;
  });
  handle('ws:open', (dir) => { const info = openWorkspace(dir); buildMenu(); return info; });
  handle('ws:close', () => { closeWorkspace(); config.workspace = null; saveConfig(); ide.updateFolders(); win?.setTitle('Kestrel'); });
  handle('ws:forget', (dir) => { config.recent = config.recent.filter((r) => r !== dir); saveConfig(); buildMenu(); });

  handle('fs:list', (dir) => need().list(dir));
  handle('fs:read', (f) => need().read(f));
  handle('fs:write', (f, text) => need().write(f, text));
  handle('fs:create', (p, dir) => need().create(p, dir));
  handle('fs:rename', (a, b) => need().rename(a, b));
  handle('fs:trash', async (p) => { const abs = need().inside(p); if (abs === ws.root) throw new Error('Refusing to delete the workspace'); await shell.trashItem(abs); });
  handle('fs:files', () => need().files());
  handle('fs:search', (q, o) => need().search(q, o));
  handle('fs:abs', (p) => need().inside(p));
  handle('fs:readAbs', async (abs) => { // files Claude Code points at (may live outside the workspace) — read-only
    const st = await fs.promises.stat(abs);
    if (st.size > 8e6) throw new Error('File too large');
    return fs.promises.readFile(abs, 'utf8');
  });
  handle('git:status', () => need().gitStatus());
  handle('git:head', (f) => need().gitHead(f));

  handle('pty:create', (o) => createPty(o));
  ipcMain.on('pty:write', (_e, id, d) => ptys.get(id)?.write(d));
  ipcMain.on('pty:resize', (_e, id, c, r) => { try { ptys.get(id)?.resize(Math.max(2, c), Math.max(2, r)); } catch { /* exited */ } });
  handle('pty:kill', (id) => killPty(id));

  handle('ai:providers', (force) => ai.list(force));
  handle('ai:setKey', (id, key) => ai.setKey(id, key));
  handle('ai:setProvider', (id, o) => { config.providers[id] = { ...(config.providers[id] || {}), ...o }; saveConfig(); });
  handle('ai:models', async (id) => { const list = await ai.models(id); config.providers[id] = { ...(config.providers[id] || {}), models: list }; saveConfig(); return list; });
  handle('ai:chat', async (reqId, req) => ai.chat(reqId, req, (t) => win?.webContents.send('ai:delta', reqId, t)));
  handle('ai:abort', (reqId) => ai.abort(reqId));

  handle('cc:start', (sid, o = {}) => agent.start(sid, { ...o, cwd: need().root }));
  handle('cc:send', (sid, content) => agent.send(sid, content));
  ipcMain.on('cc:answer', (_e, sid, rid, result) => agent.answer(sid, rid, result));
  handle('cc:interrupt', (sid) => agent.interrupt(sid));
  handle('cc:setMode', (sid, mode) => agent.setMode(sid, mode));
  handle('cc:setModel', (sid, model) => agent.setModel(sid, model));
  handle('cc:setEffort', (sid, level) => agent.setEffort(sid, level));
  handle('cc:rewind', (sid, uuid, dryRun) => agent.rewind(sid, uuid, dryRun));
  handle('cc:commands', (sid) => agent.commands(sid));
  handle('cc:models', (sid) => agent.models(sid));
  handle('cc:close', (sid) => agent.close(sid));
  handle('cc:list', () => agent.list(need().root));
  handle('cc:history', (id) => agent.history(id, need().root));

  ipcMain.on('ide:reply', (_e, id, ok, value) => { const c = ideCalls.get(id); if (!c) return; ideCalls.delete(id); ok ? c.resolve(value) : c.reject(new Error(value)); });
  ipcMain.on('ide:notify', (_e, method, params) => { if (['selection_changed', 'at_mentioned'].includes(method)) ide.notify(method, params); });

  handle('shell:reveal', (p) => shell.showItemInFolder(need().inside(p)));
  handle('shell:external', (url) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); });
  handle('clip:copy', (text) => clipboard.writeText(String(text)));
  handle('menu:rebuild', () => buildMenu());
}

// ---------------- lifecycle ----------------
app.whenReady().then(async () => {
  protocol.handle('ks', (req) => {
    const u = new URL(req.url);
    if (u.host !== 'app') return new Response('not found', { status: 404 });
    const rel = path.normalize(decodeURIComponent(u.pathname)).replace(/^([/\\])+/, '');
    const p = path.join(DIST, rel || 'index.html');
    if (!p.startsWith(DIST)) return new Response('forbidden', { status: 403 });
    return net.fetch(pathToFileURL(p).toString());
  });
  if (!DEV_URL) {
    session.defaultSession.webRequest.onHeadersReceived((d, cb) => cb({ responseHeaders: { ...d.responseHeaders, 'Content-Security-Policy': [
      "default-src 'self' ks:; script-src 'self' ks:; worker-src 'self' ks: blob:; style-src 'self' ks: 'unsafe-inline'; img-src 'self' ks: data: blob: https:; font-src 'self' ks: data:; connect-src 'self' ks:; object-src 'none'; base-uri 'none'"] } }));
  }
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === 'clipboard-sanitized-write' || perm === 'clipboard-read'));
  nativeTheme.themeSource = config.settings.theme || 'dark';
  registerIpc();
  try { await ide.start(); } catch (e) { console.error('Claude Code bridge failed to start:', e.message); }
  const arg = process.argv.slice(app.isPackaged ? 1 : 2).find((a) => !a.startsWith('-') && fs.existsSync(a) && fs.statSync(a).isDirectory());
  const start = process.env.KS_OPEN || arg || config.workspace;
  if (start && fs.existsSync(start)) try { openWorkspace(start); } catch { /* ignore */ }
  buildMenu();
  createWindow();
  app.on('activate', () => { if (!win) createWindow(); });
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { ide.stop(); agent.closeAll(); for (const id of [...ptys.keys()]) killPty(id); saveConfig(true); });
process.on('exit', () => ide.stop());
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => { ide.stop(); app.exit(0); });
