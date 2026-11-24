// Copy the built Kestrel.app into /Applications (no signing / developer account needed).
import { cpSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const rel = 'release';
const dir = readdirSync(rel).find((d) => d.startsWith('mac') && existsSync(join(rel, d, 'Kestrel.app')));
if (!dir) { console.error('Kestrel.app not found — run `npm run dist` first'); process.exit(1); }
const src = join(rel, dir, 'Kestrel.app');
const dest = '/Applications/Kestrel.app';
rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true, verbatimSymlinks: true });
console.log('Installed →', dest);
