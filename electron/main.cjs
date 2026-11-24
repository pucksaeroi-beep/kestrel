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

// ---------------- windows ----------------
// Every window is its own context: one workspace, its file watcher, its terminals and its Claude Code sessions.
const ctxs = new Map(); // webContents.id → ctx
let lastCtx = null;     // the most recently focused window (menu commands, IDE calls without a file)
let quitting = false;
const ctxOf = (e) => ctxs.get(e.sender.id);
const sendTo = (c, ch, ...a) => { if (c?.win && !c.win.isDestroyed()) c.win.webContents.send(ch, ...a); };
const focusedCtx = () => { const w = BrowserWindow.getFocusedWindow(); return (w && [...ctxs.values()].find((c) => c.win === w)) || (lastCtx && ctxs.has(lastCtx.id) ? lastCtx : null) || [...ctxs.values()][0] || null; };
const allRoots = () => [...ctxs.values()].filter((c) => c.ws).map((c) => c.ws.root);
// the open folders, restored as windows on the next launch (left alone while quitting closes them one by one)
function saveOpen() { if (quitting) return; config.windows = allRoots(); saveConfig(); }

// ---------------- workspace ----------------
function openWorkspace(c, dir) {
  const real = fs.realpathSync(path.resolve(dir));
  if (!fs.statSync(real).isDirectory()) throw new Error('Not a folder: ' + dir);
  closeWorkspace(c);
  c.ws = W.createWorkspace(real);
  config.workspace = real;
  config.recent = [real, ...config.recent.filter((r) => r !== real)].slice(0, 15);
  saveOpen();
  watch(c, real);
  ide.updateFolders();
  c.win?.setRepresentedFilename(real);
  c.win?.setTitle(path.basename(real) + ' — Kestrel');
  return wsInfo(c);
}
function closeWorkspace(c) {
  c.watcher?.close(); c.watcher = null; c.ws = null;
  for (const id of [...c.ptys.keys()]) killPty(c, id);
  c.agent.closeAll();
}
function wsInfo(c) { return c?.ws ? { root: c.ws.root, name: path.basename(c.ws.root), session: config.sessions[c.ws.root] || null } : null; }
function need(c) { if (!c?.ws) throw new Error('No folder is open'); return c.ws; }
// the window that already has this folder open, if any
function ctxWithRoot(dir, except) {
  let real; try { real = fs.realpathSync(path.resolve(dir)); } catch { return null; }
  return [...ctxs.values()].find((c) => c !== except && c.ws?.root === real) || null;
}
function focusCtx(c) { if (c.win.isMinimized()) c.win.restore(); c.win.show(); c.win.focus(); }

function watch(c, root) {
  let t = null; const changed = new Set();
  const flush = () => { const list = [...changed]; changed.clear(); sendTo(c, 'fs:changed', list); };
  try {
    c.watcher = fs.watch(root, { recursive: true }, (_ev, f) => {
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
let ptySeq = 0;
function createPty(c, { cols = 100, rows = 30, cwd, command } = {}) {
  const pty = require('node-pty');
  const shellPath = process.env.SHELL || '/bin/zsh';
  const dir = cwd ? need(c).inside(cwd) : need(c).root;
  const env = { ...process.env, PATH: loginPath, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'Kestrel', TERM_PROGRAM_VERSION: VERSION, LANG: process.env.LANG || 'en_US.UTF-8' };
  delete env.ELECTRON_RUN_AS_NODE;
  // don't leak a parent Claude Code session (when Kestrel was started from one) into new terminals
  for (const k of Object.keys(env)) if (/^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_AGENT_SDK)/.test(k)) delete env[k];
  if (ide.port) Object.assign(env, { CLAUDE_CODE_SSE_PORT: String(ide.port), ENABLE_IDE_INTEGRATION: 'true' });
  if (command && /^claude(\s|$)/.test(command)) command = command.replace(/^claude/, shq(resolveClaude()));
  const args = command ? ['-lic', command] : ['-l'];
  const p = pty.spawn(shellPath, args, { name: 'xterm-256color', cols, rows, cwd: dir, env });
  const id = ++ptySeq;
  c.ptys.set(id, p);
  let buf = '', t = null; // batch output so a chatty program doesn't flood IPC
  p.onData((d) => { buf += d; if (!t) t = setTimeout(() => { sendTo(c, 'pty:data', id, buf); buf = ''; t = null; }, 8); });
  p.onExit(({ exitCode }) => { setTimeout(() => sendTo(c, 'pty:exit', id, exitCode), 20); c.ptys.delete(id); });
  return id;
}
function killPty(c, id) { try { c.ptys.get(id)?.kill(); } catch { /* gone */ } c.ptys.delete(id); }

// ---------------- AI + Claude Code bridge ----------------
const ai = createAI({ dir: DATA, getConfig: () => config, claude: { bin: () => resolveClaude(), env: () => ({ PATH: loginPath }) } });
const ideCalls = new Map();
let ideSeq = 0;
// Claude Code (from any terminal) talks to Kestrel as one IDE with every open folder. A call goes to the
// window whose folder holds the file it names, otherwise to the window the user used last.
function ideTarget(args) {
  const f = args?.filePath || args?.old_file_path || args?.new_file_path || (typeof args?.uri === 'string' ? args.uri.replace(/^file:\/\//, '') : '');
  if (f) {
    let abs = f; try { abs = path.resolve(decodeURIComponent(f)); } catch { /* keep as is */ }
    const hit = [...ctxs.values()].filter((c) => c.ws && (abs === c.ws.root || abs.startsWith(c.ws.root + path.sep))).sort((x, y) => y.ws.root.length - x.ws.root.length)[0];
    if (hit) return hit;
  }
  return focusedCtx();
}
const ide = createIdeBridge({
  version: VERSION,
  getFolders: () => allRoots(),
  onStatus: (s) => { for (const c of ctxs.values()) sendTo(c, 'ide:status', s); },
  call: (tool, args, signal) => {
    if (tool === 'getWorkspaceFolders') { const roots = allRoots(); return Promise.resolve({ success: true, folders: roots.map((r) => ({ name: path.basename(r), uri: pathToFileURL(r).href, path: r })), rootPath: ideTarget(args)?.ws?.root || roots[0] || '' }); }
    const c = ideTarget(args);
    if (!c) return Promise.reject(new Error('No Kestrel window is open'));
    const id = ++ideSeq;
    return new Promise((resolve, reject) => {
      ideCalls.set(id, { resolve, reject });
      signal.addEventListener('abort', () => { sendTo(c, 'ide:cancel', id); ideCalls.delete(id); reject(new Error('cancelled')); });
      sendTo(c, 'ide:call', id, tool, args);
      c.win.show(); if (tool === 'openDiff' || tool === 'openFile') { if (process.platform === 'darwin') app.focus({ steal: true }); c.win.focus(); }
    });
  },
});

// ---------------- window ----------------
function createWindow(root, { focus = true } = {}) {
  const b = config.bounds || {};
  const theme = config.settings.theme || 'dark';
  const dark = theme === 'dark' || (theme === 'system' && nativeTheme.shouldUseDarkColors);
  // a new window next to an open one is offset a little so both stay visible
  const from = focusedCtx()?.win;
  const at = from && !from.isDestroyed() ? (([x, y]) => ({ x: x + 28, y: y + 28 }))(from.getPosition()) : { x: b.x, y: b.y };
  const win = new BrowserWindow({
    width: b.width || 1480, height: b.height || 940, ...at, minWidth: 860, minHeight: 560,
    titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 15, y: 13 },
    backgroundColor: dark ? '#0e1014' : '#f6f7f9', show: false, title: 'Kestrel',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  });
  const id = win.webContents.id;
  const c = { id, win, ws: null, watcher: null, ptys: new Map(), closing: false };
  c.agent = createAgent({ bin: () => resolveClaude(), env: () => ({ PATH: loginPath }), emit: (ch, ...a) => sendTo(c, ch, ...a) });
  ctxs.set(id, c);
  if (focus || !lastCtx) lastCtx = c;
  if (root) try { openWorkspace(c, root); } catch { /* the folder is gone: show the welcome screen */ }
  win.once('ready-to-show', () => (focus ? win.show() : win.showInactive()));
  const remember = () => { if (!win.isMinimized() && !win.isFullScreen()) { config.bounds = win.getBounds(); saveConfig(); } };
  win.on('resized', remember); win.on('moved', remember);
  win.on('focus', () => { lastCtx = c; win.webContents.send('app:focus'); });
  win.on('page-title-updated', (e) => { if (c.ws) e.preventDefault(); }); // keep "folder — Kestrel" (the Window menu lists windows by it)
  win.on('close', (e) => {
    if (c.closing || process.env.KS_SCRIPT) return;
    e.preventDefault();
    win.webContents.send('app:beforeClose'); // renderer asks about unsaved files, then calls app:closeNow
  });
  win.on('closed', () => {
    closeWorkspace(c);
    ctxs.delete(id);
    if (lastCtx === c) lastCtx = null;
    saveOpen(); ide.updateFolders();
  });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => {
    if (!(DEV_URL ? url.startsWith(DEV_URL) : url.startsWith('ks://app/'))) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); }
  });
  if (DEV_URL) win.loadURL(DEV_URL); else win.loadURL('ks://app/index.html');
  return c;
}

async function runScript(file) {
  const steps = JSON.parse(fs.readFileSync(file, 'utf8'));
  const first = [...ctxs.values()][0].win;
  let win = first;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  app.on('web-contents-created', (_e, wc) => wc.on('console-message', (_x, level, msg) => { if (level >= 2) console.log('[renderer]', msg); }));
  first.webContents.on('console-message', (_e, level, msg) => { if (level >= 2) console.log('[renderer]', msg); });
  await wait(2000);
  const timeout = (p, ms) => Promise.race([p, new Promise((_r, j) => setTimeout(() => j(new Error('step timed out')), ms))]);
  for (const st of steps) {
    try {
      if (st.win != null) { const all = [...ctxs.values()]; win = (all[st.win] || all[0]).win; }
      if (st.main) { const r = await eval(st.main); if (r !== undefined) console.log('[main]', JSON.stringify(r)); } // test hook: inspect windows from the main process
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
function send(cmd, ...a) { const c = focusedCtx(); if (c) sendTo(c, 'menu', cmd, ...a); }
function buildMenu() {
  const item = (label, accelerator, cmd) => ({ label, accelerator, click: () => send(cmd) });
  const recent = config.recent.filter((r) => fs.existsSync(r)).slice(0, 10).map((r) => ({ label: r.replace(app.getPath('home'), '~'), click: () => openIn(r) }));
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Kestrel', submenu: [
      { role: 'about' }, { type: 'separator' }, item('Settings…', 'Cmd+,', 'settings'), item('Models & API Keys…', '', 'settings-models'), { type: 'separator' },
      { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
    { label: 'File', submenu: [
      item('New File', 'Cmd+N', 'new-file'), { label: 'New Window', accelerator: 'Shift+Cmd+N', click: () => createWindow() }, { type: 'separator' },
      item('Open Folder…', 'Cmd+O', 'open'), { label: 'Open Recent', submenu: recent.length ? recent : [{ label: 'No recent folders', enabled: false }] },
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
  if (process.platform === 'darwin') app.dock?.setMenu(Menu.buildFromTemplate([{ label: 'New Window', click: () => createWindow() }]));
}
// Open Recent: focus the window that already has the folder, else open it in the current window (or a new one)
function openIn(dir) {
  const other = ctxWithRoot(dir);
  if (other) return focusCtx(other);
  const c = focusedCtx();
  if (c) sendTo(c, 'menu', 'open-path', dir); else createWindow(dir);
}

// ---------------- IPC ----------------
// every handler gets the calling window's context first
function handle(ch, fn) {
  ipcMain.handle(ch, async (e, ...a) => {
    try { return { ok: true, value: await fn(ctxOf(e), ...a) }; } catch (err) { return { ok: false, error: String(err.message || err) }; }
  });
}

function registerIpc() {
  handle('app:state', (c) => ({ workspace: wsInfo(c), recent: config.recent.filter((r) => fs.existsSync(r)), settings: config.settings, home: app.getPath('home'), version: VERSION, ide: { port: ide.port, connected: ide.connected } }));
  handle('settings:set', (_c, s) => {
    config.settings = { ...config.settings, ...s }; saveConfig();
    if (s.theme) nativeTheme.themeSource = s.theme;
    return config.settings;
  });
  handle('session:save', (c, s) => { if (c?.ws) { config.sessions[c.ws.root] = s; saveConfig(); } });

  // picking only returns the folder: the renderer then opens it (after asking about unsaved files)
  handle('ws:pick', async (c) => {
    const r = await dialog.showOpenDialog(c.win, { properties: ['openDirectory', 'createDirectory'], message: 'Open a folder' });
    return r.canceled ? null : r.filePaths[0];
  });
  // true when another window already has this folder open (it is brought to the front instead)
  handle('ws:focusOpen', (c, dir) => { const o = ctxWithRoot(dir, c); if (o) focusCtx(o); return !!o; });
  handle('ws:open', (c, dir) => { const info = openWorkspace(c, dir); buildMenu(); return info; });
  handle('ws:close', (c) => { closeWorkspace(c); saveOpen(); ide.updateFolders(); c.win.setRepresentedFilename(''); c.win.setTitle('Kestrel'); });
  handle('ws:forget', (_c, dir) => { config.recent = config.recent.filter((r) => r !== dir); saveConfig(); buildMenu(); });

  handle('fs:list', (c, dir) => need(c).list(dir));
  handle('fs:read', (c, f) => need(c).read(f));
  handle('fs:write', (c, f, text) => need(c).write(f, text));
  handle('fs:create', (c, p, dir) => need(c).create(p, dir));
  handle('fs:rename', (c, a, b) => need(c).rename(a, b));
  handle('fs:trash', async (c, p) => { const abs = need(c).inside(p); if (abs === c.ws.root) throw new Error('Refusing to delete the workspace'); await shell.trashItem(abs); });
  handle('fs:files', (c) => need(c).files());
  handle('fs:search', (c, q, o) => need(c).search(q, o));
  handle('fs:abs', (c, p) => need(c).inside(p));
  handle('fs:readAbs', async (c, abs) => { // files Claude Code points at (may live outside the workspace) — read-only
    const st = await fs.promises.stat(abs);
    if (st.size > 8e6) throw new Error('File too large');
    return fs.promises.readFile(abs, 'utf8');
  });
  // files dropped from Finder: what they are, and copying them into the project
  handle('fs:statAbs', async (c, abs) => {
    const st = await fs.promises.stat(abs);
    let rel = null;
    if (c?.ws) { const r = path.relative(c.ws.root, fs.realpathSync(abs)); if (r && !r.startsWith('..') && !path.isAbsolute(r)) rel = r.split(path.sep).join('/'); }
    return { dir: st.isDirectory(), size: st.size, rel };
  });
  handle('fs:import', async (c, list, dir) => {
    const w = need(c); const into = w.inside(dir || '');
    const out = [];
    for (const src of list) {
      const ext = path.extname(src), base = path.basename(src, ext);
      let dest = path.join(into, base + ext);
      for (let i = 2; fs.existsSync(dest); i++) dest = path.join(into, `${base} ${i}${ext}`);
      await fs.promises.cp(src, dest, { recursive: true, errorOnExist: true, force: false });
      out.push(w.rel(dest));
    }
    return out;
  });
  handle('git:status', (c) => need(c).gitStatus());
  handle('git:head', (c, f) => need(c).gitHead(f));

  handle('pty:create', (c, o) => createPty(c, o));
  ipcMain.on('pty:write', (e, id, d) => ctxOf(e)?.ptys.get(id)?.write(d));
  ipcMain.on('pty:resize', (e, id, cols, r) => { try { ctxOf(e)?.ptys.get(id)?.resize(Math.max(2, cols), Math.max(2, r)); } catch { /* exited */ } });
  handle('pty:kill', (c, id) => killPty(c, id));

  handle('ai:providers', (_c, force) => ai.list(force));
  handle('ai:setKey', (_c, id, key) => ai.setKey(id, key));
  handle('ai:setProvider', (_c, id, o) => { config.providers[id] = { ...(config.providers[id] || {}), ...o }; saveConfig(); });
  handle('ai:models', async (_c, id) => { const list = await ai.models(id); config.providers[id] = { ...(config.providers[id] || {}), models: list }; saveConfig(); return list; });
  handle('ai:chat', async (c, reqId, req) => ai.chat(reqId, req, (t) => sendTo(c, 'ai:delta', reqId, t)));
  handle('ai:abort', (_c, reqId) => ai.abort(reqId));

  handle('cc:start', (c, sid, o = {}) => c.agent.start(sid, { ...o, cwd: need(c).root }));
  handle('cc:send', (c, sid, content) => c.agent.send(sid, content));
  ipcMain.on('cc:answer', (e, sid, rid, result) => ctxOf(e)?.agent.answer(sid, rid, result));
  handle('cc:interrupt', (c, sid) => c.agent.interrupt(sid));
  handle('cc:setMode', (c, sid, mode) => c.agent.setMode(sid, mode));
  handle('cc:setModel', (c, sid, model) => c.agent.setModel(sid, model));
  handle('cc:setEffort', (c, sid, level) => c.agent.setEffort(sid, level));
  handle('cc:rewind', (c, sid, uuid, dryRun) => c.agent.rewind(sid, uuid, dryRun));
  handle('cc:commands', (c, sid) => c.agent.commands(sid));
  handle('cc:models', (c, sid) => c.agent.models(sid));
  handle('cc:contextUsage', (c, sid) => c.agent.contextUsage(sid));
  handle('cc:usage', (c, sid) => c.agent.usage(sid));
  handle('cc:close', (c, sid) => c.agent.close(sid));
  handle('cc:list', (c) => c.agent.list(need(c).root));
  handle('cc:history', (c, id) => c.agent.history(id, need(c).root));

  ipcMain.on('ide:reply', (_e, id, ok, value) => { const c = ideCalls.get(id); if (!c) return; ideCalls.delete(id); ok ? c.resolve(value) : c.reject(new Error(value)); });
  ipcMain.on('ide:notify', (_e, method, params) => { if (['selection_changed', 'at_mentioned'].includes(method)) ide.notify(method, params); });

  handle('shell:reveal', (c, p) => shell.showItemInFolder(need(c).inside(p)));
  handle('shell:external', (_c, url) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); });
  handle('clip:copy', (_c, text) => clipboard.writeText(String(text)));
  handle('menu:rebuild', () => buildMenu());
  handle('app:newWindow', (_c, dir) => { if (dir) { const o = ctxWithRoot(dir); if (o) return focusCtx(o); } createWindow(dir || null); });
  ipcMain.handle('app:closeNow', (e) => { const c = ctxOf(e); if (c) { c.closing = true; c.win.close(); } });
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
  // reopen the folders that were open at quit, each in its own window
  const restore = (Array.isArray(config.windows) ? config.windows : [config.workspace]).filter((r) => r && fs.existsSync(r));
  const roots = process.env.KS_OPEN || arg ? [process.env.KS_OPEN || arg] : restore;
  if (roots.length) roots.forEach((r, i) => createWindow(r, { focus: i === roots.length - 1 })); else createWindow();
  buildMenu();
  const first = [...ctxs.values()][0];
  if (process.env.KS_SCRIPT) first.win.webContents.once('did-finish-load', () => runScript(process.env.KS_SCRIPT));
  app.on('activate', () => { if (!ctxs.size) createWindow(); });
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { quitting = true; config.windows = allRoots(); saveConfig(true); });
app.on('will-quit', () => { ide.stop(); for (const c of ctxs.values()) closeWorkspace(c); saveConfig(true); });
process.on('exit', () => ide.stop());
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => { ide.stop(); app.exit(0); });
