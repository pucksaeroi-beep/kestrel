const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { createWorkspace, globToRe } = require('../electron/workspace.cjs');

test('paths cannot escape the workspace', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-'));
  const w = createWorkspace(dir);
  assert.equal(w.inside('a/b.txt'), path.join(fs.realpathSync(dir) === dir ? dir : dir, 'a/b.txt'));
  assert.throws(() => w.inside('../etc/passwd'), /outside/);
  assert.throws(() => w.inside('/etc/passwd'), /outside/);
  assert.throws(() => w.inside('a/../../x'), /outside/);
});
test('glob include patterns', () => {
  assert.ok(globToRe('*.ts').test('src/a.ts'));
  assert.ok(!globToRe('*.ts').test('src/a.tsx'));
  assert.ok(globToRe('src/**').test('src/deep/a.js'));
  assert.ok(!globToRe('src/**').test('web/a.js'));
  assert.ok(globToRe('web').test('web/theme.css'));
});
test('search and file listing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-'));
  fs.mkdirSync(path.join(dir, 'src')); fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.writeFileSync(path.join(dir, 'src/a.ts'), 'const Alpha = 1;\nalpha();\n');
  fs.writeFileSync(path.join(dir, 'node_modules/x.js'), 'alpha');
  const w = createWorkspace(dir);
  assert.deepEqual((await w.files()).sort(), ['src/a.ts']);
  const r = await w.search('alpha');
  assert.equal(r.total, 2);
  assert.equal((await w.search('alpha', { caseSensitive: true })).total, 1);
  assert.equal((await w.search('Al.ha', { regex: true, caseSensitive: true })).results[0].matches[0].col, 7);
  await assert.rejects(w.search('(', { regex: true }), /Invalid regular expression/);
});
