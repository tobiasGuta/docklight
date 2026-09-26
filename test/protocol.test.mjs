import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseWebviewMessage } = require('../out/protocol.js');

test('accepts only the two exact read-only messages', () => {
  assert.deepEqual(parseWebviewMessage({ type: 'ready' }), { type: 'ready' });
  assert.deepEqual(parseWebviewMessage({ type: 'refresh' }), { type: 'refresh' });
});

test('rejects unknown, malformed, and mutation-shaped messages', () => {
  for (const input of [
    null, undefined, 42, 'ready', [], { type: 'ready', command: 'start' },
    { type: 'refresh', args: ['container', 'rm'] }, { type: 'start', containerId: 'abc' },
    { type: 'inspect', containerId: 'abc' }, { type: 'ready', extra: true },
  ]) {
    assert.equal(parseWebviewMessage(input), undefined);
  }
});
