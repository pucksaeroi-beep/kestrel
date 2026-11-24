'use strict';
// Claude Code sessions for the GUI pane, run through the official Agent SDK.
// The SDK drives the user's own `claude` CLI, so the same login (API key or claude.ai OAuth),
// settings, CLAUDE.md, skills, slash commands, MCP servers and permission modes apply as in the terminal.
// The renderer gets the SDK's messages as-is and answers permission prompts (canUseTool).

let sdkP = null;
const sdk = () => (sdkP ||= import('@anthropic-ai/claude-agent-sdk'));

/** A push-based async iterable: the session's prompt stream (one item per user turn). */
function channel() {
  const items = [];
  let wake = null, closed = false;
  return {
    push(x) { items.push(x); wake?.(); wake = null; },
    close() { closed = true; wake?.(); wake = null; },
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (items.length) { yield items.shift(); continue; }
        if (closed) return;
        await new Promise((r) => { wake = r; });
      }
    },
  };
}

function cleanEnv(extra) {
  const env = { ...process.env, ...extra };
  delete env.ELECTRON_RUN_AS_NODE;
  // don't leak a parent Claude Code session (when Kestrel was started from one)
  for (const k of Object.keys(env)) if (/^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_AGENT_SDK)/.test(k)) delete env[k];
  return env;
}

const APPEND = 'You are running inside Kestrel, a desktop code editor, in its Claude Code side panel. '
  + 'The user reads your replies as rendered Markdown in a narrow pane. When they attach the current file or a selection, it arrives as an @-mention or a <selection> block in their message.';

function createAgent({ bin, env, emit }) {
  const sessions = new Map(); // sid → { q, input, perms: Map<rid, {resolve}>, cwd }
  let rseq = 0;

  async function start(sid, { cwd, model, mode, resume, resumeAt, effort } = {}) {
    if (sessions.has(sid)) return;
    const { query } = await sdk();
    const input = channel();
    const s = { input, perms: new Map(), cwd, q: null };
    sessions.set(sid, s);
    const options = {
      cwd,
      env: cleanEnv(env()),
      pathToClaudeCodeExecutable: bin(),
      includePartialMessages: true,
      enableFileCheckpointing: true, // lets "Rewind" put files back the way they were before a message
      settingSources: ['user', 'project', 'local'],
      systemPrompt: { type: 'preset', preset: 'claude_code', append: APPEND },
      permissionMode: mode || 'default',
      ...(mode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
      ...(model && model !== 'default' ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(resume ? { resume } : {}),
      ...(resume && resumeAt ? { resumeSessionAt: resumeAt, forkSession: true } : {}),
      stderr: (d) => { if (/error/i.test(d)) emit('cc:stderr', sid, String(d).slice(0, 2000)); },
      canUseTool: (toolName, toolInput, o) => new Promise((resolve) => {
        const rid = ++rseq;
        s.perms.set(rid, { resolve });
        o.signal?.addEventListener('abort', () => { if (s.perms.delete(rid)) { emit('cc:permCancel', sid, rid); resolve({ behavior: 'deny', message: 'Cancelled' }); } });
        emit('cc:perm', sid, rid, {
          tool: toolName, input: toolInput, title: o.title, description: o.description, displayName: o.displayName,
          reason: o.decisionReason, blockedPath: o.blockedPath, suggestions: o.suggestions || [], toolUseID: o.toolUseID,
        });
      }),
    };
    const q = query({ prompt: input, options });
    s.q = q;
    (async () => {
      try {
        for await (const m of q) emit('cc:msg', sid, m);
        emit('cc:end', sid, null);
      } catch (e) {
        emit('cc:end', sid, String(e?.message || e));
      } finally {
        for (const [, p] of s.perms) p.resolve({ behavior: 'deny', message: 'Session ended' });
        if (sessions.get(sid) === s) sessions.delete(sid);
      }
    })();
  }

  const need = (sid) => { const s = sessions.get(sid); if (!s) throw new Error('Claude Code session is not running'); return s; };

  return {
    start,
    running: (sid) => sessions.has(sid),
    send(sid, content) {
      const uuid = require('crypto').randomUUID();
      need(sid).input.push({ type: 'user', uuid, message: { role: 'user', content }, parent_tool_use_id: null, origin: { kind: 'human' } });
      return uuid;
    },
    setEffort: (sid, level) => need(sid).q.applyFlagSettings({ effortLevel: level || null }),
    rewind: (sid, uuid, dryRun) => need(sid).q.rewindFiles(uuid, { dryRun: !!dryRun }),
    answer(sid, rid, result) {
      const s = sessions.get(sid); const p = s?.perms.get(rid);
      if (!p) return; s.perms.delete(rid); p.resolve(result);
    },
    interrupt: (sid) => need(sid).q.interrupt(),
    setMode: (sid, mode) => need(sid).q.setPermissionMode(mode),
    setModel: (sid, model) => need(sid).q.setModel(model === 'default' ? undefined : model),
    commands: (sid) => need(sid).q.supportedCommands(),
    models: (sid) => need(sid).q.supportedModels(),
    contextUsage: (sid) => need(sid).q.getContextUsage(),
    async usage(sid) {
      const q = need(sid).q;
      const [usage, account] = await Promise.all([
        q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET().catch(() => null), // experimental: fall back to the /usage text if it goes away
        q.accountInfo().catch(() => null)]);
      return { usage, account };
    },
    close(sid) {
      const s = sessions.get(sid);
      if (!s) return;
      sessions.delete(sid);
      for (const [, p] of s.perms) p.resolve({ behavior: 'deny', message: 'Session closed' });
      s.input.close();
      try { s.q?.close?.(); } catch { /* already gone */ }
    },
    closeAll() { for (const sid of [...sessions.keys()]) this.close(sid); },
    async list(dir) {
      const { listSessions } = await sdk();
      const all = await listSessions({ dir, limit: 30, includeProgrammatic: true });
      return all.filter((x) => !x.archived).map((x) => ({ id: x.sessionId, title: x.customTitle || x.summary || x.firstPrompt || 'Untitled', updated: x.lastModified, branch: x.gitBranch }));
    },
    async history(id, dir) {
      const { getSessionMessages } = await sdk();
      return getSessionMessages(id, { dir });
    },
  };
}

module.exports = { createAgent, channel };
