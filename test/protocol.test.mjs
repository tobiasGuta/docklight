import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseWebviewMessage } = require('../out/protocol.js');

test('accepts only the exact ready handshake', () => {
  assert.deepEqual(parseWebviewMessage({ type: 'ready' }), { type: 'ready' });
});

test('rejects unknown, malformed, and mutation-shaped messages', () => {
  for (const input of [
    null, undefined, 42, 'ready', [], { type: 'ready', command: 'start' },
    { type: 'refresh' }, { type: 'start', containerId: 'abc' },
    { type: 'ready', __proto__: null, extra: true },
  ]) {
    assert.equal(parseWebviewMessage(input), undefined);
  }
});
