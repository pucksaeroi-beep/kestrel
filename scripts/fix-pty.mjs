// node-pty ships prebuilt binaries; npm sometimes drops the exec bit on its spawn helper.
import { chmodSync, existsSync, readdirSync } from 'node:fs';
const dir = 'node_modules/node-pty/prebuilds';
if (existsSync(dir)) for (const d of readdirSync(dir)) { const f = `${dir}/${d}/spawn-helper`; if (existsSync(f)) chmodSync(f, 0o755); }
