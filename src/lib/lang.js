// File-type helpers: Monaco language ids and small coloured badges for the explorer and tabs.
const EXT = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'typescript',
  json: 'json', jsonc: 'json', json5: 'json', md: 'markdown', mdx: 'markdown', markdown: 'markdown', html: 'html', htm: 'html', vue: 'html', svelte: 'html',
  css: 'css', scss: 'scss', sass: 'scss', less: 'less', py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', kts: 'kotlin',
  swift: 'swift', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'csharp', php: 'php', sh: 'shell', bash: 'shell', zsh: 'shell',
  yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', env: 'ini', xml: 'xml', svg: 'xml', plist: 'xml', sql: 'sql', graphql: 'graphql', gql: 'graphql',
  dockerfile: 'dockerfile', lua: 'lua', r: 'r', dart: 'dart', scala: 'scala', pl: 'perl', ex: 'elixir', exs: 'elixir', clj: 'clojure', ps1: 'powershell',
  txt: 'plaintext', log: 'plaintext', proto: 'proto', tf: 'hcl', hcl: 'hcl', sol: 'sol', m: 'objective-c', mm: 'objective-c',
};
const NAMES = { dockerfile: 'dockerfile', makefile: 'shell', '.gitignore': 'ini', '.env': 'ini', '.zshrc': 'shell', '.bashrc': 'shell', 'cmakelists.txt': 'plaintext' };

export function languageOf(path) {
  const name = path.split('/').pop().toLowerCase();
  if (NAMES[name]) return NAMES[name];
  if (name.startsWith('.env')) return 'ini';
  if (name.startsWith('dockerfile')) return 'dockerfile';
  const ext = name.includes('.') ? name.split('.').pop() : '';
  return EXT[ext] || 'plaintext';
}

// [label, colour] per extension — rendered as a tiny badge instead of an icon font
const BADGE = {
  js: ['JS', '#f0d24a'], mjs: ['JS', '#f0d24a'], cjs: ['JS', '#f0d24a'], jsx: ['JSX', '#61dafb'], ts: ['TS', '#4c9bf0'], tsx: ['TSX', '#4c9bf0'],
  json: ['{}', '#e8b44a'], md: ['M↓', '#7aa2f7'], html: ['<>', '#f0743e'], css: ['#', '#58a6ff'], scss: ['#', '#e06c9f'], py: ['PY', '#5ea3e0'],
  go: ['GO', '#4fc3d9'], rs: ['RS', '#e3895a'], java: ['JV', '#e0814a'], kt: ['KT', '#a97bff'], swift: ['SW', '#f06c3e'], rb: ['RB', '#e0514a'],
  php: ['PHP', '#8c93d6'], c: ['C', '#7f9fd6'], h: ['H', '#9c8fd6'], cpp: ['C++', '#7f9fd6'], cs: ['C#', '#9b6ae0'], sh: ['$', '#8fd16a'], zsh: ['$', '#8fd16a'],
  yml: ['YML', '#d6a24a'], yaml: ['YML', '#d6a24a'], toml: ['TML', '#c9a26a'], xml: ['XML', '#e0954a'], svg: ['SVG', '#f0b33e'], sql: ['SQL', '#e0b84a'],
  png: ['IMG', '#56c28a'], jpg: ['IMG', '#56c28a'], jpeg: ['IMG', '#56c28a'], gif: ['IMG', '#56c28a'], webp: ['IMG', '#56c28a'], ico: ['IMG', '#56c28a'],
  lock: ['🔒', '#8a8f99'], env: ['ENV', '#e8d44a'], vue: ['V', '#42b883'], svelte: ['S', '#ff3e00'], lua: ['LUA', '#5c7cfa'], dart: ['DT', '#40c4ff'],
  txt: ['TXT', '#8a8f99'], log: ['LOG', '#8a8f99'], gitignore: ['GIT', '#e8664a'], dockerfile: ['DKR', '#3ea6f0'],
};
export function badgeOf(path) {
  const name = path.split('/').pop().toLowerCase();
  if (name === 'dockerfile') return BADGE.dockerfile;
  if (name === '.gitignore') return BADGE.gitignore;
  if (name.startsWith('.env')) return BADGE.env;
  if (name === 'package-lock.json' || name.endsWith('.lock')) return BADGE.lock;
  const ext = name.includes('.') ? name.split('.').pop() : '';
  return BADGE[ext] || ['•', '#8a8f99'];
}
export const isImage = (p) => /\.(png|jpe?g|gif|webp|ico|bmp)$/i.test(p);
