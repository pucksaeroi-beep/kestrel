'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

// invoke() unwraps { ok, value | error } so the renderer gets normal promise rejections
const call = (ch) => async (...a) => {
  const r = await ipcRenderer.invoke(ch, ...a);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};
const on = (ch) => (fn) => { const f = (_e, ...a) => fn(...a); ipcRenderer.on(ch, f); return () => ipcRenderer.removeListener(ch, f); };

contextBridge.exposeInMainWorld('ks', {
  app: {
    state: call('app:state'), newWindow: call('app:newWindow'), closeNow: () => ipcRenderer.invoke('app:closeNow'),
    onFocus: on('app:focus'), onBeforeClose: on('app:beforeClose'), onMenu: on('menu'), rebuildMenu: call('menu:rebuild'),
  },
  settings: { set: call('settings:set') },
  session: { save: call('session:save') },
  ws: { pick: call('ws:pick'), focusOpen: call('ws:focusOpen'), open: call('ws:open'), close: call('ws:close'), forget: call('ws:forget') },
  fs: {
    list: call('fs:list'), read: call('fs:read'), write: call('fs:write'), create: call('fs:create'), rename: call('fs:rename'),
    trash: call('fs:trash'), files: call('fs:files'), search: call('fs:search'), abs: call('fs:abs'), readAbs: call('fs:readAbs'), statAbs: call('fs:statAbs'), import: call('fs:import'),
    onChanged: on('fs:changed'),
  },
  git: { status: call('git:status'), head: call('git:head') },
  pty: {
    create: call('pty:create'), kill: call('pty:kill'),
    write: (id, d) => ipcRenderer.send('pty:write', id, d), resize: (id, c, r) => ipcRenderer.send('pty:resize', id, c, r),
    onData: on('pty:data'), onExit: on('pty:exit'),
  },
  ai: {
    providers: call('ai:providers'), setKey: call('ai:setKey'), setProvider: call('ai:setProvider'), models: call('ai:models'),
    chat: call('ai:chat'), abort: call('ai:abort'), onDelta: on('ai:delta'),
  },
  ide: {
    onCall: on('ide:call'), onCancel: on('ide:cancel'), onStatus: on('ide:status'),
    reply: (id, ok, value) => ipcRenderer.send('ide:reply', id, ok, value),
    notify: (method, params) => ipcRenderer.send('ide:notify', method, params),
  },
  cc: {
    start: call('cc:start'), send: call('cc:send'), interrupt: call('cc:interrupt'), setMode: call('cc:setMode'), setModel: call('cc:setModel'), setEffort: call('cc:setEffort'), rewind: call('cc:rewind'),
    commands: call('cc:commands'), models: call('cc:models'), contextUsage: call('cc:contextUsage'), usage: call('cc:usage'), close: call('cc:close'), list: call('cc:list'), history: call('cc:history'),
    answer: (sid, rid, result) => ipcRenderer.send('cc:answer', sid, rid, result),
    onMsg: on('cc:msg'), onEnd: on('cc:end'), onPerm: on('cc:perm'), onPermCancel: on('cc:permCancel'), onStderr: on('cc:stderr'),
  },
  shell: { reveal: call('shell:reveal'), external: call('shell:external') },
  clip: { copy: call('clip:copy') },
  pathOf: (file) => { try { return webUtils.getPathForFile(file); } catch { return ''; } },
});
