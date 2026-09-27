import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseWebviewMessage } = require('../out/protocol.js');
const id = 'a'.repeat(64);

test('accepts only exact read-only messages and validated full container IDs', () => {
  for (const type of ['ready', 'refresh', 'clearSelection', 'loadLogs']) {
    assert.deepEqual(parseWebviewMessage({ type }), { type });
  }
  assert.deepEqual(parseWebviewMessage({ type: 'select', id }), { type: 'select', id });
});

test('rejects malformed, arbitrary, and mutation-shaped messages', () => {
  for (const input of [
    null, undefined, 42, 'ready', [], { type: 'ready', command: 'start' },
    { type: 'refresh', args: ['container', 'rm'] }, { type: 'start', containerId: id },
    { type: 'inspect', containerId: id }, { type: 'ready', extra: true },
    { type: 'select', id: 'short' }, { type: 'select', id: id.toUpperCase() },
    { type: 'select', id, command: 'rm' }, { type: 'select', id: { id } },
    { type: { toString: null } }, { type: 'loadLogs', id },
  ]) {
    assert.equal(parseWebviewMessage(input), undefined);
  }
});
