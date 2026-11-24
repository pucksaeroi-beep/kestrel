// Drives the Claude Code IDE bridge with a real WebSocket client, like the claude CLI does.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const WebSocket = require('ws');

test('Claude Code bridge: lock file, auth, MCP handshake, tools', async () => {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-claude-'));
  process.env.CLAUDE_CONFIG_DIR = cfg;
  const { createIdeBridge } = require('../electron/ide.cjs');
  const calls = [];
  const ide = createIdeBridge({ getFolders: () => ['/tmp/proj'], call: async (tool, args) => { calls.push([tool, args]); return tool === 'openDiff' ? ['FILE_SAVED', 'new text'] : { ok: true }; } });
  const port = await ide.start();
  const lock = JSON.parse(fs.readFileSync(path.join(cfg, 'ide', `${port}.lock`), 'utf8'));
  assert.equal(lock.ideName, 'Kestrel'); assert.equal(lock.transport, 'ws'); assert.deepEqual(lock.workspaceFolders, ['/tmp/proj']);
  assert.equal(fs.statSync(path.join(cfg, 'ide', `${port}.lock`)).mode & 0o777, 0o600);

  // wrong token is refused
  const bad = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { 'x-claude-code-ide-authorization': 'nope' } });
  const code = await new Promise((r) => bad.on('close', (c) => r(c)));
  assert.equal(code, 1008);

  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { 'x-claude-code-ide-authorization': lock.authToken } });
  await new Promise((r) => ws.on('open', r));
  const pending = new Map(); const notes = [];
  ws.on('message', (m) => { const j = JSON.parse(m); if (j.id != null) pending.get(j.id)?.(j); else notes.push(j); });
  let id = 0;
  const rpc = (method, params) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ jsonrpc: '2.0', id: i, method, params })); });

  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: 'test' } });
  assert.equal(init.result.serverInfo.name, 'Kestrel');
  ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
  const tools = (await rpc('tools/list', {})).result.tools.map((t) => t.name);
  for (const t of ['openDiff', 'getDiagnostics', 'close_tab', 'closeAllDiffTabs', 'openFile', 'getCurrentSelection']) assert.ok(tools.includes(t), t);

  const diff = await rpc('tools/call', { name: 'openDiff', arguments: { old_file_path: '/tmp/proj/a.ts', new_file_path: '/tmp/proj/a.ts', new_file_contents: 'x', tab_name: 'a.ts' } });
  assert.deepEqual(diff.result.content, [{ type: 'text', text: 'FILE_SAVED' }, { type: 'text', text: 'new text' }]);
  const sel = await rpc('tools/call', { name: 'getCurrentSelection', arguments: {} });
  assert.deepEqual(JSON.parse(sel.result.content[0].text), { ok: true });
  assert.equal((await rpc('nope/method', {})).error.code, -32601);

  ide.notify('selection_changed', { text: 'hi' });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(notes[0].method, 'selection_changed');
  assert.equal(calls.length, 2);

  ws.close(); ide.stop();
  assert.ok(!fs.existsSync(path.join(cfg, 'ide', `${port}.lock`)));
});
