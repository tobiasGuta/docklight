import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const script = readFileSync(new URL('../media/dashboard.js', import.meta.url), 'utf8');

class FakeElement {
  constructor(tag = 'div') {
    this.tag = tag;
    this.className = '';
    this.children = [];
    this.listeners = {};
    this.value = '';
    this.hidden = false;
    this.disabled = false;
    this.dataset = {};
    this._text = '';
    this.scrolled = false;
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map((item) => item.textContent).join(''); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = [...nodes]; this._text = ''; }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  setAttribute(name, value) { this[name] = value; }
  scrollIntoView() { this.scrolled = true; }
  fire(type) { this.listeners[type]?.(); }
}

function setup() {
  const sent = [];
  const listeners = {};
  const ids = ['extension-status', 'status-detail', 'error-message', 'empty-message', 'groups', 'refresh', 'search', 'filter', 'count-running', 'count-stopped', 'count-images', 'count-networks', 'count-volumes', 'container-total', 'details-panel', 'detail-fields', 'close-details', 'load-logs', 'clear-logs', 'wrap-logs', 'logs-status', 'logs-output', 'stats-status', 'details-heading', 'details-subtitle', 'stat-cpu', 'stat-memory', 'stat-memory-percent'];
  const elements = Object.fromEntries(ids.map((id) => [id, new FakeElement()]));
  elements.filter.value = 'all';
  const document = {
    documentElement: { dataset: {} },
    getElementById: (id) => elements[id],
    createElement: (tag) => new FakeElement(tag),
  };
  runInNewContext(script, {
    acquireVsCodeApi: () => ({ postMessage: (message) => sent.push(message) }),
    document,
    window: { addEventListener: (name, callback) => { listeners[name] = callback; } },
    Date,
  });
  return { sent, elements, document, receive: (data) => listeners.message({ data }) };
}

function snapshot() {
  return {
    containers: [
      { id: 'a'.repeat(64), name: '<img src=x onerror=alert(1)>', image: 'postgres:17', state: 'running', health: 'healthy', startedAt: '2026-09-26T21:00:00Z', project: 'demo', service: 'db', publishedPorts: [{ containerPort: '5432/tcp', hostIp: '127.0.0.1', hostPort: '5432' }] },
      { id: 'b'.repeat(64), name: 'standalone', image: 'redis:7', state: 'exited', health: null, startedAt: null, project: null, service: null, publishedPorts: [] },
    ],
    counts: { containers: 2, running: 1, stopped: 1, images: 2, networks: 3, volumes: 4 },
    capturedAt: '2026-09-26T21:00:00Z',
  };
}

function walk(element) { return [element, ...element.children.flatMap(walk)]; }

test('ready handshake, safe text rendering, global groups, health and summary counts', () => {
  const app = setup();
  assert.equal(app.sent.length, 1);
  assert.equal(app.sent[0].type, 'ready');
  app.receive({ type: 'inventory', snapshot: snapshot() });
  assert.equal(app.elements['count-running'].textContent, '1');
  assert.equal(app.elements['count-images'].textContent, '2');
  assert.equal(app.elements['count-volumes'].textContent, '4');
  const groups = app.elements.groups.children;
  assert.equal(groups.length, 2);
  assert.equal(walk(groups[0]).find((item) => item.className === 'group-title').textContent, 'demo');
  assert.equal(walk(groups[1]).find((item) => item.className === 'group-title').textContent, 'Standalone containers');
  const names = walk(app.elements.groups).filter((item) => item.className === 'container-name');
  assert.equal(names[0].textContent, '<img src=x onerror=alert(1)>');
  assert.equal(walk(app.elements.groups).find((item) => item.className.includes('state-pill')).textContent, 'healthy');
  assert.equal(app.document.documentElement.dataset.connected, 'true');
  assert.equal(app.elements['error-message'].hidden, true);
});

test('search and status filters apply without any Docker calls', () => {
  const app = setup();
  app.receive({ type: 'inventory', snapshot: snapshot() });
  app.elements.search.value = 'REDIS';
  app.elements.search.fire('input');
  assert.equal(app.elements.groups.children.length, 1);
  app.elements.filter.value = 'running';
  app.elements.filter.fire('change');
  assert.equal(app.elements.groups.children.length, 0);
  app.elements.search.value = '';
  app.elements.search.fire('input');
  assert.equal(app.elements.groups.children.length, 1);
  assert.equal(app.sent.length, 1);
  app.elements.refresh.fire('click');
  assert.equal(app.sent.at(-1).type, 'refresh');
  assert.equal(app.elements.refresh.disabled, true);
});

test('failures show diagnostics as text and preserve last successful snapshot', () => {
  const app = setup();
  app.receive({ type: 'inventory', snapshot: snapshot() });
  app.receive({ type: 'error', message: '<script>test</script>' });
  assert.equal(app.elements['error-message'].textContent, 'Docker inventory unavailable: <script>test</script>');
  assert.equal(app.elements['error-message'].hidden, false);
  assert.equal(app.elements.groups.children.length, 2);
  app.receive({ type: 'mutate', command: 'remove' });
  assert.equal(app.sent.length, 1);
});

test('selected details and bounded log text render safely, never auto-request logs', () => {
  const app = setup();
  app.receive({ type: 'inventory', snapshot: snapshot() });
  const firstRow = walk(app.elements.groups).find((item) => item.className === 'container-row');
  firstRow.fire('click');
  assert.equal(app.sent.at(-1).type, 'select');
  assert.equal(app.elements['details-panel'].hidden, false);
  assert.equal(app.elements['details-heading'].textContent, '<img src=x onerror=alert(1)>');
  assert.equal(app.elements['detail-fields'].children.find((item) => item.textContent === 'Health').tag, 'dt');
  assert.equal(app.sent.filter((item) => item.type === 'loadLogs').length, 0);
  app.receive({ type: 'stats', id: 'a'.repeat(64), stats: { cpuPercent: '0.1%', memoryUsage: '15MiB / 1GiB', memoryPercent: '1.5%', capturedAt: '2026-09-26T21:00:00Z' } });
  assert.equal(app.elements['stat-cpu'].textContent, '0.1%');
  app.elements['load-logs'].fire('click');
  assert.equal(app.sent.at(-1).type, 'loadLogs');
  app.receive({ type: 'logs', id: 'a'.repeat(64), logs: { text: '<script>do not run</script>', truncated: true } });
  assert.equal(app.elements['logs-output'].textContent, '<script>do not run</script>');
  assert.match(app.elements['logs-status'].textContent, /truncated/);
  app.receive({ type: 'logs', id: 'b'.repeat(64), logs: { text: 'other container', truncated: false } });
  assert.equal(app.elements['logs-output'].textContent, '<script>do not run</script>');
  app.elements['close-details'].fire('click');
  assert.equal(app.elements['details-panel'].hidden, true);
  assert.equal(app.sent.at(-1).type, 'clearSelection');
});

test('Phase 5: selection scrolls into view and search matches IDs and published ports', () => {
  const app = setup();
  app.receive({ type: 'inventory', snapshot: snapshot() });
  app.elements.search.value = '5432';
  app.elements.search.fire('input');
  assert.equal(app.elements['container-total'].textContent, '1 / 2');
  assert.equal(app.elements.groups.children.length, 1);
  app.elements.search.value = '';
  app.elements.search.fire('input');
  const selected = walk(app.elements.groups).find((item) => item.className === 'container-row');
  selected.fire('click');
  assert.equal(app.elements['details-panel'].scrolled, true);
  assert.equal(app.sent.at(-1).type, 'select');
});

test('Phase 5: wrapped logs and Clear view do not cause host operations', () => {
  const app = setup();
  app.receive({ type: 'inventory', snapshot: snapshot() });
  walk(app.elements.groups).find((item) => item.className === 'container-row').fire('click');
  assert.equal(app.elements['clear-logs'].disabled, true);
  app.receive({ type: 'logs', id: 'a'.repeat(64), logs: { text: '<secret>\nraw', truncated: false } });
  assert.equal(app.elements['clear-logs'].disabled, false);
  app.elements['wrap-logs'].fire('click');
  assert.equal(app.elements['logs-output'].className, 'logs-output wrapped');
  assert.equal(app.elements['wrap-logs']['aria-pressed'], 'true');
  const before = app.sent.length;
  app.elements['clear-logs'].fire('click');
  assert.equal(app.elements['logs-output'].textContent, '');
  assert.equal(app.elements['logs-output'].hidden, true);
  assert.equal(app.elements['clear-logs'].disabled, true);
  assert.equal(app.sent.length, before);
  app.elements['wrap-logs'].fire('click');
  assert.equal(app.elements['logs-output'].className, 'logs-output');
});
