'use strict';
// Claude Code IDE bridge — the same local protocol the official VS Code / JetBrains integrations speak:
// a WebSocket MCP server on 127.0.0.1, advertised through ~/.claude/ide/<port>.lock with a random auth token.
// `claude` started in Kestrel's terminal (CLAUDE_CODE_SSE_PORT is set) connects automatically; from any other
// terminal, run `/ide` inside claude and pick Kestrel.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const LOCK_DIR = () => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'ide');

const s = (description, props = {}, required = []) => ({ description, inputSchema: { type: 'object', properties: props, required } });
const str = (description) => ({ type: 'string', description });
const TOOLS = {
  openDiff: s('Open a diff of a proposed change for the user to accept or reject', {
    old_file_path: str('Path of the file being changed'), new_file_path: str('Path of the file after the change'),
    new_file_contents: str('Proposed contents of the new file'), tab_name: str('Name of the diff tab') }, ['old_file_path', 'new_file_path', 'new_file_contents', 'tab_name']),
  openFile: s('Open a file in the editor and optionally select a range of text', {
    filePath: str('Path to the file'), preview: { type: 'boolean' }, startText: str('Text marking the start of the selection'),
    endText: str('Text marking the end of the selection'), makeFrontmost: { type: 'boolean' } }, ['filePath']),
  getDiagnostics: s('Get language diagnostics (errors, warnings) from the editor', { uri: str('Optional file URI; omit for all open files') }),
  getCurrentSelection: s('Get the current text selection in the active editor'),
  getLatestSelection: s('Get the most recent text selection, even if the editor lost focus'),
  getOpenEditors: s('List the files open in the editor'),
  getWorkspaceFolders: s('List the workspace folders open in the editor'),
  checkDocumentDirty: s('Check whether a document has unsaved changes', { filePath: str('Path to the file') }, ['filePath']),
  saveDocument: s('Save a document with unsaved changes', { filePath: str('Path to the file') }, ['filePath']),
  close_tab: s('Close a tab by name', { tab_name: str('Tab name') }, ['tab_name']),
  closeAllDiffTabs: s('Close all diff tabs in the editor'),
};

function createIdeBridge({ name = 'Kestrel', version = '1.0.0', getFolders, call, onStatus = () => {}, log = () => {} }) {
  let server = null, wss = null, port = 0, token = '', client = null, lockFile = '';
  const pending = new Map(); // in-flight tool calls per connection, aborted on disconnect

  function writeLock() {
    if (!port) return;
    const dir = LOCK_DIR();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    lockFile = path.join(dir, `${port}.lock`);
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, workspaceFolders: getFolders(), ideName: name, transport: 'ws', runningInWindows: false, authToken: token }), { mode: 0o600 });
  }

  function send(ws, msg) { if (ws?.readyState === 1) ws.send(JSON.stringify(msg)); }
  const text = (t) => ({ content: [{ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t, null, 2) }] });

  async function onMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return send(ws, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
    const { id, method, params = {} } = msg;
    if (id === undefined || id === null) return; // notifications from the client (initialized, cancelled…)
    const reply = (result) => send(ws, { jsonrpc: '2.0', id, result });
    const fail = (code, message) => send(ws, { jsonrpc: '2.0', id, error: { code, message } });
    try {
      switch (method) {
        case 'initialize':
          return reply({ protocolVersion: params.protocolVersion || '2025-06-18', capabilities: { tools: { listChanged: true } }, serverInfo: { name, version } });
        case 'ping': return reply({});
        case 'tools/list': return reply({ tools: Object.entries(TOOLS).map(([n, t]) => ({ name: n, ...t })) });
        case 'resources/list': return reply({ resources: [] });
        case 'prompts/list': return reply({ prompts: [] });
        case 'tools/call': {
          const tool = params.name;
          if (!Object.hasOwn(TOOLS, tool)) return fail(-32602, 'Unknown tool ' + tool);
          const ctrl = new AbortController();
          pending.set(id, ctrl);
          try {
            const r = await call(tool, params.arguments || {}, ctrl.signal);
            if (tool === 'openDiff') return reply({ content: r.map((t) => ({ type: 'text', text: t })) });
            return reply(text(r));
          } finally { pending.delete(id); }
        }
        default: return fail(-32601, 'Method not found: ' + method);
      }
    } catch (e) {
      log('tool error', e);
      return reply({ content: [{ type: 'text', text: 'Error: ' + (e.message || e) }], isError: true });
    }
  }

  function start() {
    if (server) return Promise.resolve(port);
    token = crypto.randomUUID();
    server = http.createServer((_q, r) => { r.writeHead(426); r.end(); });
    wss = new WebSocketServer({ server });
    wss.on('connection', (ws, req) => {
      if (req.headers['x-claude-code-ide-authorization'] !== token) { ws.close(1008, 'Unauthorized'); return; }
      if (client) try { client.close(1000, 'A newer Claude Code session connected'); } catch { /* ignore */ }
      client = ws;
      onStatus({ connected: true, port });
      ws.on('message', (m) => onMessage(ws, m));
      ws.on('close', () => {
        if (client === ws) { client = null; onStatus({ connected: false, port }); }
        for (const c of pending.values()) c.abort();
        pending.clear();
      });
      ws.on('error', () => {});
    });
    return new Promise((resolve, reject) => {
      const tryListen = (n) => {
        const p = 10000 + Math.floor(Math.random() * 55000);
        server.once('error', (e) => (n > 0 ? tryListen(n - 1) : reject(e)));
        server.listen(p, '127.0.0.1', () => { port = p; writeLock(); onStatus({ connected: false, port }); resolve(port); });
      };
      tryListen(5);
    });
  }

  function stop() {
    try { if (lockFile) fs.unlinkSync(lockFile); } catch { /* ignore */ }
    lockFile = '';
    try { client?.close(); wss?.close(); server?.close(); } catch { /* ignore */ }
    server = wss = client = null; port = 0;
  }

  return {
    start, stop,
    get port() { return port; },
    get connected() { return !!client; },
    updateFolders: () => { if (port) writeLock(); },
    notify: (method, params) => send(client, { jsonrpc: '2.0', method, params }),
  };
}

module.exports = { createIdeBridge, TOOLS, LOCK_DIR };
