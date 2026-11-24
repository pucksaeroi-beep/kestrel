// Fuzzy matching for quick-open and the command palette.
// score() returns null for no match, otherwise { score, hits:[indices] } — higher is better.
export function score(query, text) {
  if (!query) return { score: 0, hits: [] };
  const q = query.toLowerCase(), t = text.toLowerCase();
  const hits = [];
  let qi = 0, s = 0, prev = -2, start = -1;
  // prefer matches inside the file name (after the last slash)
  const base = t.lastIndexOf('/') + 1;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] !== q[qi]) continue;
    if (start < 0) start = i;
    let bonus = 1;
    if (i === prev + 1) bonus += 5; // consecutive
    const ch = text[i - 1];
    if (i === 0 || ch === '/' || ch === '-' || ch === '_' || ch === '.' || ch === ' ') bonus += 6; // word start
    else if (text[i] !== t[i] && ch === ch?.toLowerCase()) bonus += 4; // camelCase hump
    if (i >= base) bonus += 2;
    s += bonus; hits.push(i); prev = i; qi++;
  }
  if (qi < q.length) return null;
  // exact substring in the base name wins
  const sub = t.indexOf(q, base);
  if (sub >= 0) s += 20 + (sub === base ? 10 : 0);
  s -= text.length * 0.02 + start * 0.05;
  return { score: s, hits };
}

export function rank(query, items, key = (x) => x, limit = 200) {
  const out = [];
  for (const it of items) {
    const r = score(query, key(it));
    if (r) out.push({ item: it, ...r });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}
