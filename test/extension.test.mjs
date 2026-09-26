import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import Module from 'node:module';

const require = createRequire(import.meta.url);

function setup() {
  const panels = [];
  let command;
  const vscode = {
    ViewColumn: { Active: -1 },
    Uri: { joinPath: (base, ...parts) => ({ path: [base.path, ...parts].join('/') }) },
    commands: { registerCommand: (_name, callback) => { command = callback; return { dispose() {} }; } },
    window: {
      createWebviewPanel: () => {
        const panel = {
          reveals: 0,
          disposed: false,
          sent: [],
          webview: {
            cspSource: 'vscode-webview-resource:',
            asWebviewUri: (uri) => uri.path,
            onDidReceiveMessage(callback) { panel.receive = callback; return { dispose() {} }; },
            postMessage(message) { panel.sent.push(message); return Promise.resolve(true); },
          },
          onDidDispose(callback) { panel.onDispose = callback; return { dispose() {} }; },
          reveal() { this.reveals += 1; },
          dispose() { this.disposed = true; this.onDispose?.(); },
        };
        panels.push(panel);
        return panel;
      },
    },
  };
  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    return request === 'vscode' ? vscode : originalLoad.call(this, request, parent, isMain);
  };
  let extension;
  try {
    delete require.cache[require.resolve('../out/extension.js')];
    extension = require('../out/extension.js');
  } finally {
    Module._load = originalLoad;
  }
  const context = { extensionUri: { path: '/extension' }, subscriptions: [] };
  extension.activate(context);
  return { extension, context, panels, open: () => command() };
}

test('opens one Webview with a restrictive CSP and no Docker execution', () => {
  const app = setup();
  app.open();
  assert.equal(app.panels.length, 1);
  const panel = app.panels[0];
  assert.match(panel.webview.html, /default-src 'none'/);
  assert.match(panel.webview.html, /connect-src 'none'/);
  assert.match(panel.webview.html, /script-src 'nonce-/);
  assert.doesNotMatch(panel.webview.html, /https?:\/\//);
  app.open();
  assert.equal(app.panels.length, 1);
  assert.equal(panel.reveals, 1);
  panel.receive({ type: 'start', containerId: 'abc' });
  assert.equal(panel.sent.length, 0);
  panel.receive({ type: 'ready' });
  assert.deepEqual(panel.sent, [{ type: 'bootstrap', mode: 'scaffold' }]);
  panel.dispose();
  app.open();
  assert.equal(app.panels.length, 2);
  app.extension.deactivate();
  assert.equal(app.panels[1].disposed, true);
});
