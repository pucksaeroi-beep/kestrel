'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { cliPrompt } = require('../electron/ai.cjs');

test('cliPrompt: a single message is passed through as is', () => {
  assert.strictEqual(cliPrompt([{ role: 'user', content: 'hello' }]), 'hello');
});

test('cliPrompt: earlier turns become a transcript and the last message stays last', () => {
  const out = cliPrompt([
    { role: 'user', content: 'What is 2+2?' },
    { role: 'assistant', content: '4' },
    { role: 'user', content: 'And times 3?' },
  ]);
  assert.match(out, /^<conversation_so_far>/);
  assert.match(out, /<turn role="user">\nWhat is 2\+2\?\n<\/turn>\n<turn role="assistant">\n4\n<\/turn>/);
  assert.ok(out.endsWith('</conversation_so_far>\n\nAnd times 3?'));
});
