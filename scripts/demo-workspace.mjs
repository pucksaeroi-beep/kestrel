// Creates a small demo project full of mock code (fake app, fake people) for screenshots and testing.
//   node scripts/demo-workspace.mjs [dir]   → <dir>/aurora-weather
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';

const base = resolve(process.argv[2] || 'demo');
const root = join(base, 'aurora-weather');
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });
const w = (f, s) => { mkdirSync(dirname(join(root, f)), { recursive: true }); writeFileSync(join(root, f), s.replace(/^\n/, '')); };
const git = (...a) => execFileSync('git', a, { cwd: root, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 'Mia Hartley', GIT_AUTHOR_EMAIL: 'mia@aurora.example', GIT_COMMITTER_NAME: 'Mia Hartley', GIT_COMMITTER_EMAIL: 'mia@aurora.example' } });

w('README.md', `
# Aurora Weather

A tiny forecast service and web widget (demo project with mock data).

## Run

\`\`\`sh
npm install
npm run dev
\`\`\`

## Layout

- \`src/server.ts\` — HTTP API
- \`src/forecast.ts\` — forecast logic
- \`src/units.ts\` — unit conversion
- \`web/\` — the embeddable widget
`);
w('package.json', JSON.stringify({ name: 'aurora-weather', version: '0.3.0', type: 'module', scripts: { dev: 'tsx watch src/server.ts', test: 'node --test' }, devDependencies: { tsx: '^4.19.0', typescript: '^5.6.0' } }, null, 2) + '\n');
w('tsconfig.json', JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', strict: true, outDir: 'dist' }, include: ['src'] }, null, 2) + '\n');
w('.gitignore', 'node_modules\ndist\n.env\n');
w('src/units.ts', `
export type Unit = 'C' | 'F';

export const toF = (c: number) => (c * 9) / 5 + 32;
export const toC = (f: number) => ((f - 32) * 5) / 9;
export const kmh = (ms: number) => ms * 3.6;
`);
w('src/forecast.ts', `
import { toF, type Unit } from './units.js';

export interface Forecast {
  city: string;
  temp: number;
  humidity: number;
  sky: 'sunny' | 'cloudy' | 'rain' | 'storm';
  updated: Date;
}

const SAMPLE: Record<string, Omit<Forecast, 'city' | 'updated'>> = {
  bangkok: { temp: 33, humidity: 71, sky: 'sunny' },
  oslo: { temp: 4, humidity: 82, sky: 'rain' },
  lima: { temp: 19, humidity: 77, sky: 'cloudy' },
};

export function forecast(city: string, unit: Unit = 'C'): Forecast {
  const hit = SAMPLE[city.toLowerCase()];
  if (!hit) throw new Error(\`Unknown city: \${city}\`);
  const temp = unit === 'F' ? toF(hit.temp) : hit.temp;
  return { city, ...hit, temp, updated: new Date() };
}

export function summary(f: Forecast) {
  return \`\${f.city}: \${Math.round(f.temp)}° and \${f.sky}, humidity \${f.humidity}%\`;
}
`);
w('src/cache.ts', `
const store = new Map<string, { value: unknown; until: number }>();

export function cached<T>(key: string, ttlMs: number, fn: () => T): T {
  const hit = store.get(key);
  if (hit && hit.until > Date.now()) return hit.value as T;
  const value = fn();
  store.set(key, { value, until: Date.now() + ttlMs });
  return value;
}
`);
w('src/server.ts', `
import http from 'node:http';
import { forecast, summary } from './forecast.js';
import { cached } from './cache.js';

const PORT = Number(process.env.PORT ?? 3000);

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const city = url.searchParams.get('city') ?? 'Bangkok';
  const unit = url.searchParams.get('unit') === 'F' ? 'F' : 'C';
  try {
    const data = cached(\`\${city}:\${unit}\`, 10 * 60_000, () => forecast(city, unit));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ...data, text: summary(data) }));
  } catch (err) {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: (err as Error).message }));
  }
});

server.listen(PORT, () => console.log(\`Aurora listening on :\${PORT}\`));
`);
w('web/widget.ts', `
type Data = { city: string; temp: number; sky: string; text: string };

export async function mount(el: HTMLElement, city = 'Bangkok') {
  const res = await fetch(\`/api?city=\${encodeURIComponent(city)}\`);
  const data: Data = await res.json();
  el.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'aurora-card';
  card.textContent = data.text;
  el.append(card);
}
`);
w('web/theme.css', `
:root { --bg: #ffffff; --fg: #111827; --accent: #ff7a45; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #0d1117; --fg: #e6edf3; }
}
.aurora-card {
  background: var(--bg);
  color: var(--fg);
  border-radius: 12px;
  padding: 16px 20px;
  border-left: 4px solid var(--accent);
}
`);
w('test/forecast.test.ts', `
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forecast } from '../src/forecast.js';

test('converts to Fahrenheit', () => {
  assert.equal(forecast('Bangkok', 'F').temp, 91.4);
});
`);
git('init', '-q', '-b', 'main');
git('add', '-A');
git('commit', '-q', '-m', 'Aurora Weather 0.3');
// some uncommitted work so the explorer shows git colours
w('src/units.ts', `
export type Unit = 'C' | 'F';

export const toF = (c: number) => (c * 9) / 5 + 32;
export const toC = (f: number) => ((f - 32) * 5) / 9;
export const kmh = (ms: number) => ms * 3.6;
export const mph = (ms: number) => ms * 2.237;
`);
w('src/alerts.ts', `
export type Level = 'green' | 'yellow' | 'orange' | 'red';

export const LEVELS: Level[] = ['green', 'yellow', 'orange', 'red'];

export function alertsFor(city: string) {
  return [{ city, level: 'yellow' as Level, text: 'Heavy rain this evening' }];
}
`);
console.log('Demo workspace ready →', root);
