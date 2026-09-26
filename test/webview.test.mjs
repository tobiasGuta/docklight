import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const script = readFileSync(new URL('../media/dashboard.js', import.meta.url), 'utf8');

test('Webview handshakes and renders host content as text', () => {
  const sent = [];
  const listeners = {};
  const elements = {
    'extension-status': { textContent: 'Connecting…' },
    'status-detail': { textContent: 'Waiting…' },
  };
  const document = {
    documentElement: { dataset: {} },
    getElementById: (id) => elements[id],
  };
  runInNewContext(script, {
    acquireVsCodeApi: () => ({ postMessage: (message) => sent.push(message) }),
    document,
    window: { addEventListener: (name, callback) => { listeners[name] = callback; } },
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'ready');
  listeners.message({ data: { type: 'start' } });
  assert.equal(elements['extension-status'].textContent, 'Connecting…');
  listeners.message({ data: { type: 'bootstrap', mode: 'scaffold' } });
  assert.equal(elements['extension-status'].textContent, 'Extension host connected');
  assert.equal(document.documentElement.dataset.connected, 'true');
});
