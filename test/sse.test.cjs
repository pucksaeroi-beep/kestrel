const test = require('node:test');
const assert = require('node:assert/strict');
const { sseParser, deltaText } = require('../electron/sse.cjs');

test('sse parser joins chunks split mid-event', () => {
  const p = sseParser();
  assert.deepEqual(p.feed('data: {"a":1}\n\ndata: {"b"'), ['{"a":1}']);
  assert.deepEqual(p.feed(':2}\r\n\r\nevent: x\ndata: [DONE]\n\n'), ['{"b":2}', '[DONE]']);
});
test('delta text per wire format', () => {
  assert.equal(deltaText('openai', { choices: [{ delta: { content: 'hi' } }] }), 'hi');
  assert.equal(deltaText('gemini', { candidates: [{ content: { parts: [{ text: 'a' }, { text: 'skip', thought: true }, { text: 'b' }] } }] }), 'ab');
  assert.equal(deltaText('openai', { choices: [{ delta: {} }] }), '');
});
