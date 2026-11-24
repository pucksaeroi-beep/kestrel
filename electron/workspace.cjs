'use strict';
// File-system access for the open workspace. Every path is resolved and checked to be inside the root.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { execFile } = require('child_process');

const IGNORE_DIRS = new Set(['.git', 'node_modules', '.DS_Store', '.next', '.nuxt', 'dist', 'build', 'out', 'target', '.venv', 'venv', '__pycache__', '.cache', '.turbo', '.idea', 'coverage', 'Pods', 'DerivedData', '.svelte-kit', '.parcel-cache']);
const MAX_READ = 8 * 1024 * 1024;

let PATH = process.env.PATH;
function setPath(p) { PATH = p; }

function run(cmd, args, cwd, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, PATH, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }, ...opts }, (err, out, errOut) =>
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: String(out || ''), err: String(errOut || '') }));
  });
}

function createWorkspace(rootDir) {
  const root = path.resolve(rootDir);
  const inside = (p) => {
    const abs = path.resolve(root, String(p || ''));
    if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error('Path is outside the workspace: ' + p);
    return abs;
  };
  const rel = (abs) => path.relative(root, abs).split(path.sep).join('/');

  async function list(dir = '') {
    const abs = inside(dir);
    const ents = await fsp.readdir(abs, { withFileTypes: true });
    const out = [];
    for (const e of ents) {
      if (e.name === '.DS_Store' || e.name === '.git') continue;
      let isDir = e.isDirectory();
      if (e.isSymbolicLink()) { try { isDir = (await fsp.stat(path.join(abs, e.name))).isDirectory(); } catch { /* broken link */ } }
      out.push({ name: e.name, path: rel(path.join(abs, e.name)), dir: isDir, dim: IGNORE_DIRS.has(e.name) || e.name.startsWith('.') });
    }
    out.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    return out;
  }

  async function read(file) {
    const abs = inside(file);
    const st = await fsp.stat(abs);
    if (st.isDirectory()) throw new Error('Is a directory');
    if (st.size > MAX_READ) return { tooLarge: true, size: st.size };
    const buf = await fsp.readFile(abs);
    const probe = buf.subarray(0, 8000);
    if (probe.includes(0)) return { binary: true, size: st.size, ext: path.extname(abs).slice(1).toLowerCase(), data: /\.(png|jpe?g|gif|webp|ico|bmp)$/i.test(abs) && st.size < 5e6 ? buf.toString('base64') : null };
    return { text: buf.toString('utf8'), mtime: st.mtimeMs, size: st.size };
  }

  async function write(file, text) {
    const abs = inside(file);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, text);
    return (await fsp.stat(abs)).mtimeMs;
  }

  async function create(p, dir) {
    const abs = inside(p);
    if (fs.existsSync(abs)) throw new Error(`"${p}" already exists`);
    if (dir) await fsp.mkdir(abs, { recursive: true });
    else { await fsp.mkdir(path.dirname(abs), { recursive: true }); await fsp.writeFile(abs, ''); }
    return rel(abs);
  }

  async function rename(from, to) {
    const a = inside(from), b = inside(to);
    if (fs.existsSync(b)) throw new Error(`"${to}" already exists`);
    await fsp.mkdir(path.dirname(b), { recursive: true });
    await fsp.rename(a, b);
    return rel(b);
  }

  async function isGit() { return (await run('git', ['rev-parse', '--is-inside-work-tree'], root)).out.trim() === 'true'; }

  /** All files for quick-open: git ls-files when possible (honours .gitignore), otherwise a bounded walk. */
  async function files() {
    if (await isGit()) {
      const r = await run('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], root);
      if (r.code === 0) return r.out.split('\0').filter(Boolean).filter((f) => fs.existsSync(path.join(root, f))).slice(0, 100000);
    }
    const out = [];
    const walk = async (d) => {
      if (out.length > 50000) return;
      let ents; try { ents = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        if (IGNORE_DIRS.has(e.name) || e.name.startsWith('.git')) continue;
        const p = path.join(d, e.name);
        if (e.isDirectory()) await walk(p); else if (e.isFile()) out.push(rel(p));
      }
    };
    await walk(root);
    return out;
  }

  /** Text search across workspace files. Returns [{ file, matches:[{line, col, len, text}] }]. */
  async function search(query, { regex = false, caseSensitive = false, wholeWord = false, include = '', limit = 2000 } = {}) {
    if (!query) return { results: [], total: 0 };
    let re;
    try {
      let src = regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (wholeWord) src = `\\b${src}\\b`;
      re = new RegExp(src, caseSensitive ? 'g' : 'gi');
    } catch (e) { throw new Error('Invalid regular expression: ' + e.message); }
    const inc = include.split(',').map((s) => s.trim()).filter(Boolean).map(globToRe);
    const all = (await files()).filter((f) => !inc.length || inc.some((r) => r.test(f)));
    const results = [];
    let total = 0;
    for (const f of all) {
      if (total >= limit) break;
      let st; try { st = await fsp.stat(path.join(root, f)); } catch { continue; }
      if (st.size > 2e6) continue;
      const buf = await fsp.readFile(path.join(root, f));
      if (buf.subarray(0, 4000).includes(0)) continue;
      const lines = buf.toString('utf8').split('\n');
      const matches = [];
      for (let i = 0; i < lines.length && total < limit; i++) {
        re.lastIndex = 0;
        const m = re.exec(lines[i]);
        if (m) { matches.push({ line: i + 1, col: m.index + 1, len: Math.max(1, m[0].length), text: lines[i].slice(0, 400) }); total++; }
      }
      if (matches.length) results.push({ file: f, matches });
    }
    return { results, total, capped: total >= limit };
  }

  // ---- git decorations
  async function gitStatus() {
    if (!(await isGit())) return null;
    const [st, br] = await Promise.all([run('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], root), run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], root)]);
    const files = {};
    const parts = st.out.split('\0');
    for (let i = 0; i < parts.length; i++) {
      const e = parts[i];
      if (e.length < 4) continue;
      const x = e[0], y = e[1], f = e.slice(3);
      if (x === 'R' || x === 'C') i++; // next entry is the original name
      files[f] = x === '?' ? 'U' : (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) ? 'C' : (x === 'A' ? 'A' : (x === 'D' || y === 'D') ? 'D' : 'M');
    }
    return { branch: br.out.trim(), files };
  }
  async function gitHead(file) {
    const r = await run('git', ['show', `HEAD:${String(file).replace(/^\.?\//, '')}`], root);
    return r.code === 0 ? r.out : null;
  }

  return { root, inside, rel, list, read, write, create, rename, files, search, gitStatus, gitHead, isGit };
}

function globToRe(g) {
  let s = g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '\u0000').replace(/\*\*/g, '\u0001').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')
    .replace(/\u0000/g, '(?:.*/)?').replace(/\u0001/g, '.*');
  if (!g.includes('/')) s = '(?:^|.*/)' + s;
  return new RegExp('^' + s + '(?:$|/)');
}

module.exports = { createWorkspace, setPath, globToRe, run };
