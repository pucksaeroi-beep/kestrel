// The /context and /usage dialogs of the Claude Code panel, drawn from the Agent SDK's structured data
// (getContextUsage, usage + accountInfo) instead of the CLI's text output.
import { h, clear } from '../ui/h.js';

const fmtK = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n || 0)));
const pctOf = (n, max) => { const p = max ? (n / max) * 100 : 0; return p === 0 ? '0%' : p < 0.1 ? '<0.1%' : p.toFixed(1) + '%'; };
const tilde = (p) => String(p || '').replace(/^\/(Users|home)\/[^/]+/, '~');

// one colour per context row, keyed by the row id (falls back to the name)
const COLORS = {
  system_prompt: '#c98a3a', system_tools: '#6b8cff', mcp_tools: '#6fcf7c', mcp_instructions: '#d9b86b', custom_agents: '#5ec8c8',
  memory_files: '#b07fe0', skills: '#e87a5d', messages: '#4aa3df', autocompact_buffer: '#c9ccd1', compact_buffer: '#c9ccd1',
};
const colorOf = (c) => COLORS[c.id] || COLORS[String(c.name).toLowerCase().replace(/ /g, '_')] || '#8a8f98';

export function contextView(d) {
  const max = d.maxTokens || d.rawMaxTokens || d.raw_max_tokens || 0;
  const total = d.totalTokens ?? d.total_tokens ?? 0;
  const rows = (d.categories || []).filter((c) => c.tokens > 0);
  const inWindow = rows.filter((c) => c.kind !== 'deferred' && !c.isDeferred);
  const bar = h('div', { class: 'cci-bar' }, inWindow.filter((c) => c.kind !== 'free').map((c) =>
    h('span', { title: `${c.name}: ${fmtK(c.tokens)}`, style: { width: Math.max(0.4, (c.tokens / max) * 100) + '%', background: colorOf(c) } })));
  const table = h('div', { class: 'cci-table' },
    h('div', { class: 'cci-tr cci-th' }, h('span', {}, 'Category'), h('span', {}, 'Tokens'), h('span', {}, 'Usage')),
    inWindow.map((c) => h('div', { class: 'cci-tr' },
      h('span', { class: 'cci-name' }, c.kind === 'free' ? h('i', { class: 'cci-sw none' }) : h('i', { class: 'cci-sw', style: { background: colorOf(c) } }), c.name),
      h('span', {}, fmtK(c.tokens)), h('span', { class: 'muted' }, pctOf(c.tokens, max)))));
  const deferred = rows.filter((c) => c.kind === 'deferred' || c.isDeferred);
  const mem = d.memoryFiles || d.memory_files || [];
  const skills = (d.skills?.skillFrontmatter || (Array.isArray(d.skills) ? d.skills : [])).filter((s) => s.tokens > 0).sort((a, b) => b.tokens - a.tokens);
  const list = (title, items) => items.length ? h('div', { class: 'cci-sec' }, h('div', { class: 'cci-h' }, title),
    items.map(([name, n]) => h('div', { class: 'cci-li' }, h('span', { class: 'ell' }, name), h('span', { class: 'muted' }, fmtK(n))))) : null;
  return h('div', { class: 'cci' },
    h('div', { class: 'cci-model' }, d.model || ''),
    h('div', { class: 'cci-total' }, `${fmtK(total)} / ${fmtK(max)} tokens (${d.percentage ?? Math.round((total / max) * 100)}%)`),
    bar, table,
    deferred.length ? h('div', { class: 'muted sm cci-note' }, deferred.map((c) => `${c.name}: ${fmtK(c.tokens)}`).join(' · '), ' — loaded only when used, not counted') : null,
    list('Memory files', mem.map((m) => [tilde(m.path), m.tokens])),
    list('Skills', skills.slice(0, 8).map((s) => ['/' + s.name, s.tokens]).concat(skills.length > 8 ? [[`+ ${skills.length - 8} more`, skills.slice(8).reduce((a, s) => a + s.tokens, 0)]] : [])));
}

const when = (iso, withDay) => {
  if (!iso) return '';
  const d = new Date(iso);
  const t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return withDay || d.toDateString() !== new Date().toDateString() ? `${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} at ${t}` : t;
};
const meter = (label, w, withDay) => w && w.utilization != null ? h('div', { class: 'ccu-m' },
  h('div', { class: 'ccu-mh' }, h('span', {}, label), h('span', {}, Math.round(w.utilization) + '%')),
  h('div', { class: 'ccu-bar' + (w.utilization >= 90 ? ' hot' : w.utilization >= 70 ? ' warm' : '') }, h('span', { style: { width: Math.min(100, w.utilization) + '%' } })),
  w.resets_at ? h('div', { class: 'muted sm' }, 'Resets ' + (withDay ? '' : 'at ') + when(w.resets_at, withDay)) : null) : null;

export function usageView({ usage: u, account: a }, { open, run }) {
  const kv = (k, v) => v ? h('div', { class: 'ccu-kv' }, h('span', { class: 'muted' }, k), h('span', { class: 'ell' }, v)) : null;
  const plan = a?.subscriptionType || (u?.subscription_type ? 'Claude ' + u.subscription_type[0].toUpperCase() + u.subscription_type.slice(1) : '');
  const auth = a?.apiProvider && a.apiProvider !== 'firstParty' ? a.apiProvider : a?.apiKeySource || a?.tokenSource ? 'API key' : plan ? 'Claude AI' : '';
  const rl = u?.rate_limits;
  const s = u?.session;
  const sec = (title, ...kids) => h('div', { class: 'cci-sec' }, h('div', { class: 'cci-h' }, title), ...kids);
  const cost = s && (s.total_cost_usd > 0 || s.total_lines_added || s.total_lines_removed) ? sec('This session',
    kv('Cost', '$' + s.total_cost_usd.toFixed(2) + (plan ? ' (covered by your plan)' : '')),
    kv('Code changes', `+${s.total_lines_added} −${s.total_lines_removed} lines`),
    Object.entries(s.model_usage || {}).map(([m, x]) => kv(m.replace(/^claude-/, ''), `${fmtK((x.inputTokens || 0) + (x.cacheReadInputTokens || 0) + (x.cacheCreationInputTokens || 0))} in · ${fmtK(x.outputTokens || 0)} out`))) : null;

  // "What's contributing" with a Day / Week switch
  const b = u?.behaviors;
  let span = 'day';
  const recs = h('div');
  const drawRecs = () => {
    clear(recs);
    const x = b?.[span];
    if (!x) return;
    recs.append(h('div', { class: 'muted sm' }, `Approximate · sessions on this machine only · ${x.request_count ?? 0} requests in ${x.session_count ?? 0} sessions`));
    for (const r of x.recommendations || []) {
      const cmd = /run (\/[\w-]+)/.exec(r.detail || '')?.[1];
      recs.append(h('div', { class: 'ccu-rec' }, h('span', {}, h('b', {}, r.title), r.detail ? h('span', { class: 'muted' }, ' · ', cmd ? h('a', { href: '#', onclick: (e) => { e.preventDefault(); document.querySelector('.modal-back .modal-x')?.click(); run(cmd); } }, r.detail) : r.detail) : null), h('span', { class: 'muted' }, r.pct + '%')));
    }
    if (x.skills?.length) recs.append(h('div', { class: 'ccu-sub' }, h('div', { class: 'ccu-kv muted sm' }, h('span', {}, 'Skills'), h('span', {}, '% of usage')),
      x.skills.map((k) => h('div', { class: 'ccu-kv' }, h('span', { class: 'cc-mono' }, '/' + k.name), h('span', { class: 'muted' }, k.pct + '%')))));
    if (!x.recommendations?.length && !x.skills?.length) recs.append(h('div', { class: 'muted sm' }, 'Nothing stands out.'));
  };
  const tabs = h('div', { class: 'ccu-tabs' }, ['day', 'week'].map((k) => h('button', { class: k === span ? 'on' : '', onclick: (e) => {
    span = k; tabs.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === e.currentTarget)); drawRecs(); } }, k === 'day' ? 'Day' : 'Week')));
  drawRecs();

  return h('div', { class: 'cci ccu' },
    a ? sec('Account', kv('Auth method', auth), kv('Email', a.email), kv('Organization', a.organization), kv('Plan', plan)) : null,
    u?.rate_limits_available && rl ? sec('Usage',
      meter('Session (5hr)', rl.five_hour), meter('Weekly (7 day)', rl.seven_day, true),
      meter('Weekly · Opus', rl.seven_day_opus, true), meter('Weekly · Sonnet', rl.seven_day_sonnet, true),
      (rl.model_scoped || []).map((m) => meter(`Weekly · ${m.display_name}`, m, true)),
      rl.extra_usage?.is_enabled ? meter('Usage credits', rl.extra_usage) : null,
      h('a', { href: '#', class: 'ccu-link', onclick: (e) => { e.preventDefault(); open('https://claude.ai/settings/usage'); } }, 'Manage usage on claude.ai'))
      : u ? sec('Usage', h('div', { class: 'muted sm' }, 'Plan limits do not apply to this login (API key or cloud provider).')) : null,
    cost,
    b ? sec("What's contributing to your limits usage?", tabs, recs) : null);
}
