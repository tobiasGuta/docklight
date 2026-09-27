import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import Module from 'node:module';

const require = createRequire(import.meta.url);
const flush = () => new Promise((resolve) => setImmediate(resolve));

function setup(getInventory = async () => ({ containers: [], counts: { containers: 0, running: 0, stopped: 0, images: 0, networks: 0, volumes: 0 }, capturedAt: new Date().toISOString() }), getContainerStats = async () => ({ cpuPercent: '0.2%', memoryUsage: '10MiB / 1GiB', memoryPercent: '1%', capturedAt: new Date().toISOString() }), getContainerLogs = async () => ({ text: 'hello', truncated: false })) {
  const panels = [];
  let command;
  const vscode = {
    ViewColumn: { Active: -1 },
    Uri: { joinPath: (base, ...parts) => ({ path: [base.path, ...parts].join('/') }) },
    commands: { registerCommand: (_name, callback) => { command = callback; return { dispose() {} }; } },
    window: {
      createWebviewPanel: () => {
        const panel = {
          reveals: 0, disposed: false, visible: true, sent: [],
          webview: {
            cspSource: 'vscode-webview-resource:',
            asWebviewUri: (uri) => uri.path,
            onDidReceiveMessage(callback) { panel.receive = callback; return { dispose() {} }; },
            postMessage(message) { panel.sent.push(message); return Promise.resolve(true); },
          },
          onDidChangeViewState(callback) { panel.onChange = callback; return { dispose() {} }; },
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
    if (request === 'vscode') return vscode;
    if (request === './docker' && parent?.filename.endsWith('/out/extension.js')) return { getInventory, getContainerStats, getContainerLogs };
    return originalLoad.call(this, request, parent, isMain);
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

test('one Webview, strict CSP, validated read-only messages, and successful inventory', async () => {
  let calls = 0;
  const app = setup(async () => { calls++; return { containers: [], counts: { containers: 0 }, capturedAt: '2026-09-26T21:00:00Z' }; });
  app.open();
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
  await flush();
  assert.equal(calls, 1);
  assert.deepEqual(panel.sent.map((m) => m.type), ['loading', 'inventory']);
  panel.receive({ type: 'refresh' });
  await flush();
  assert.equal(calls, 2);
  panel.dispose();
  app.open();
  assert.equal(app.panels.length, 2);
  app.extension.deactivate();
  assert.equal(app.panels[1].disposed, true);
});

test('hiding aborts in-flight work and resumes with a fresh inventory when shown', async () => {
  const requests = [];
  const app = setup((_run, signal) => new Promise((resolve, reject) => {
    requests.push({ resolve, reject, signal });
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
  }));
  app.open();
  const panel = app.panels[0];
  panel.receive({ type: 'ready' });
  assert.equal(requests.length, 1);
  panel.visible = false;
  panel.onChange();
  assert.equal(requests[0].signal.aborted, true);
  panel.visible = true;
  panel.onChange();
  await flush();
  assert.equal(requests.length, 2);
  assert.equal(panel.sent.filter((m) => m.type === 'error').length, 0);
  requests[1].resolve({ containers: [], counts: {}, capturedAt: '' });
  await flush();
  assert.equal(panel.sent.filter((m) => m.type === 'inventory').length, 1);
  panel.dispose();
});

test('reports daemon failures without issuing management actions', async () => {
  const app = setup(async () => { throw new Error('permission denied'); });
  app.open();
  const panel = app.panels[0];
  panel.receive({ type: 'ready' });
  await flush();
  assert.equal(panel.sent.at(-1).type, 'error');
  assert.match(panel.sent.at(-1).message, /permission denied/);
  panel.dispose();
});

const liveId = 'a'.repeat(64);
const stoppedId = 'b'.repeat(64);
function inventoryWithContainers(containers) {
  return { containers, counts: { containers: containers.length, running: containers.filter(c => c.state === 'running').length, stopped: containers.filter(c => c.state !== 'running').length, images: 2, networks: 2, volumes: 2 }, capturedAt: new Date().toISOString() };
}
function summary(id, state) {
  return { id, name: state, image: 'test:latest', state, health: null, startedAt: state === 'running' ? '2026-09-26T21:00:00Z' : null, project: null, service: null, publishedPorts: [] };
}

test('selected running container gets a single sample; logs require explicit click', async () => {
  let statsCalls = 0;
  let logsCalls = 0;
  const app = setup(
    async () => inventoryWithContainers([summary(liveId, 'running'), summary(stoppedId, 'exited')]),
    async (id) => { statsCalls++; assert.equal(id, liveId); return { cpuPercent: '1%', memoryUsage: '16MiB', memoryPercent: '2%', capturedAt: '2026-09-26T21:00:00Z' }; },
    async (id) => { logsCalls++; assert.equal(id, liveId); return { text: 'sample log', truncated: false }; },
  );
  app.open();
  const panel = app.panels[0];
  panel.receive({ type: 'ready' });
  await flush();
  panel.receive({ type: 'loadLogs' }); // no selection
  panel.receive({ type: 'select', id: 'x'.repeat(64) }); // not present in snapshot
  await flush();
  assert.equal(statsCalls, 0);
  assert.equal(logsCalls, 0);
  panel.receive({ type: 'select', id: liveId });
  await flush();
  assert.equal(statsCalls, 1);
  assert.equal(logsCalls, 0);
  assert.equal(panel.sent.at(-1).type, 'stats');
  panel.receive({ type: 'loadLogs' });
  await flush();
  assert.equal(logsCalls, 1);
  assert.equal(panel.sent.at(-1).type, 'logs');
  panel.receive({ type: 'clearSelection' });
  panel.receive({ type: 'loadLogs' });
  await flush();
  assert.equal(logsCalls, 1);
  panel.receive({ type: 'select', id: stoppedId });
  await flush();
  assert.equal(statsCalls, 1);
  assert.equal(panel.sent.at(-1).type, 'statsUnavailable');
  panel.dispose();
});

test('switching selection aborts stale stats and stale logs are not delivered', async () => {
  let signalForStats;
  let signalForLogs;
  let resolveStats;
  let resolveLogs;
  const app = setup(
    async () => inventoryWithContainers([summary(liveId, 'running'), summary(stoppedId, 'exited')]),
    (_id, _run, signal) => { signalForStats = signal; return new Promise((resolve) => { resolveStats = resolve; }); },
    (_id, signal) => { signalForLogs = signal; return new Promise((resolve) => { resolveLogs = resolve; }); },
  );
  app.open();
  const panel = app.panels[0];
  panel.receive({ type: 'ready' });
  await flush();
  panel.receive({ type: 'select', id: liveId });
  panel.receive({ type: 'loadLogs' });
  assert.equal(signalForStats.aborted, false);
  assert.equal(signalForLogs.aborted, false);
  panel.receive({ type: 'select', id: stoppedId });
  assert.equal(signalForStats.aborted, true);
  assert.equal(signalForLogs.aborted, true);
  resolveStats({ cpuPercent: '55%', memoryUsage: 'secret', memoryPercent: '3%' });
  resolveLogs({ text: 'stale data', truncated: false });
  await flush();
  assert.equal(panel.sent.filter((m) => m.type === 'stats' || m.type === 'logs').length, 0);
  panel.dispose();
});
