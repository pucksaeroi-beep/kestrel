import test from 'node:test';
import assert from 'node:assert/strict';
import { parse, inline, fenceInfo } from '../src/lib/markdown.js';
import { score, rank } from '../src/lib/fuzzy.js';

test('fence info: language and path', () => {
  assert.deepEqual(fenceInfo('ts src/app.ts'), { lang: 'ts', file: 'src/app.ts' });
  assert.deepEqual(fenceInfo('ts:src/app.ts'), { lang: 'ts', file: 'src/app.ts' });
  assert.deepEqual(fenceInfo('src/app.py'), { lang: 'py', file: 'src/app.py' });
  assert.deepEqual(fenceInfo('python path=tools/x.py'), { lang: 'python', file: 'tools/x.py' });
  assert.deepEqual(fenceInfo('bash'), { lang: 'bash', file: '' });
});
test('blocks: headings, lists, code (even unclosed while streaming), tables', () => {
  const b = parse('# Title\n\nSome **text**.\n\n- a\n- b\n\n```ts src/a.ts\nconst x = 1;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```js\nlet y');
  assert.deepEqual(b.map((x) => x.type), ['h', 'p', 'list', 'code', 'table', 'code']);
  assert.equal(b[3].file, 'src/a.ts'); assert.equal(b[3].code, 'const x = 1;'); assert.equal(b[3].closed, true);
  assert.equal(b[5].closed, false); assert.equal(b[5].code, 'let y');
  assert.deepEqual(b[4].rows, [['1', '2']]);
});
test('inline spans', () => {
  assert.deepEqual(inline('use `npm i` and **bold** see [docs](https://x.dev)').map((s) => s.t), ['text', 'code', 'text', 'b', 'text', 'a']);
  assert.equal(inline('<img src=x onerror=alert(1)>')[0].t, 'text'); // never HTML
});
test('fuzzy ranking prefers file-name matches', () => {
  const r = rank('srv', ['src/server.ts', 'docs/service-overview.md', 'web/serve/x.ts']);
  assert.equal(r[0].item, 'src/server.ts');
  assert.equal(score('xyz', 'abc'), null);
  assert.equal(rank('fts', ['src/forecast.ts', 'test/forecast.test.ts'])[0].item, 'src/forecast.ts');
});
