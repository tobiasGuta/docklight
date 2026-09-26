'use strict';

// This Webview has no Node.js or Docker access. All displayed daemon text is textContent.
const vscode = acquireVsCodeApi();
const statusElement = document.getElementById('extension-status');
const detailElement = document.getElementById('status-detail');
const errorElement = document.getElementById('error-message');
const emptyElement = document.getElementById('empty-message');
const groupsElement = document.getElementById('groups');
const refreshButton = document.getElementById('refresh');
const searchInput = document.getElementById('search');
const filterSelect = document.getElementById('filter');

let snapshot = null;
let loading = false;
const collapsedGroups = new Set();

function element(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value !== undefined) node.textContent = String(value);
  return node;
}

function setCount(id, value) {
  document.getElementById(id).textContent = String(value);
}

function formatUptime(startedAt) {
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started)) return 'Uptime unavailable';
  const seconds = Math.max(0, Math.floor((Date.now() - started) / 1000));
  if (seconds < 60) return 'Up <1m';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `Up ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Up ${hours}h ${minutes % 60}m`;
  return `Up ${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function displayState(container) {
  if (container.state === 'running' && container.health) return container.health;
  if (container.state === 'running') return 'Running';
  return container.state ? container.state[0].toUpperCase() + container.state.slice(1) : 'Unknown';
}

function stateClass(container) {
  if (container.state === 'running' && container.health === 'unhealthy') return 'danger';
  if ((container.state === 'running' && container.health === 'starting') || container.state === 'restarting') return 'warning';
  if (container.state === 'running') return 'success';
  return 'muted';
}

function matches(container, search, filter) {
  if (filter === 'running' && container.state !== 'running') return false;
  if (filter === 'stopped' && container.state === 'running') return false;
  if (filter === 'unhealthy' && container.health !== 'unhealthy') return false;
  const haystack = [container.name, container.image, container.project, container.service, container.state, container.health]
    .filter((value) => typeof value === 'string').join(' ').toLowerCase();
  return haystack.includes(search);
}

function makeContainerRow(container) {
  const row = element('article', 'container-row');
  const top = element('div', 'container-top');
  const nameWrap = element('div', 'container-name-wrap');
  const mark = element('span', 'container-mark', '▣');
  mark.setAttribute('aria-hidden', 'true');
  const nameBlock = element('div', 'container-name-block');
  nameBlock.append(element('strong', 'container-name', container.name));
  nameBlock.append(element('span', 'container-image', container.image));
  nameWrap.append(mark, nameBlock);
  const pill = element('span', `state-pill ${stateClass(container)}`, displayState(container));
  top.append(nameWrap, pill);
  row.append(top);

  const facts = element('div', 'container-facts');
  facts.append(element('span', 'fact', container.id.slice(0, 12)));
  if (container.service) facts.append(element('span', 'fact', `Service: ${container.service}`));
  if (container.state === 'running' && container.startedAt) {
    facts.append(element('span', 'fact', formatUptime(container.startedAt)));
  }
  if (container.publishedPorts.length) {
    const ports = container.publishedPorts.map((port) => {
      const host = port.hostIp.includes(':') ? `[${port.hostIp}]` : (port.hostIp || '*');
      return `${host}:${port.hostPort} → ${port.containerPort}`;
    });
    const portText = element('span', 'fact port-list', ports.join('  ·  '));
    portText.title = ports.join('\n');
    facts.append(portText);
  } else {
    facts.append(element('span', 'fact', 'No published ports'));
  }
  row.append(facts);
  return row;
}

function render() {
  groupsElement.replaceChildren();
  if (!snapshot) {
    emptyElement.hidden = false;
    emptyElement.textContent = loading ? 'Reading the local Docker Engine…' : 'No inventory loaded yet.';
    return;
  }
  const search = searchInput.value.trim().toLowerCase();
  const filter = filterSelect.value;
  const visible = snapshot.containers.filter((item) => matches(item, search, filter));
  emptyElement.hidden = visible.length > 0;
  emptyElement.textContent = snapshot.containers.length === 0
    ? 'No containers found on the local Docker Engine.'
    : 'No containers match the current search or filter.';

  const groups = new Map();
  for (const container of visible) {
    const key = container.project ? `project:${container.project}` : 'standalone';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(container);
  }
  const keys = [...groups.keys()].sort((a, b) => {
    if (a === 'standalone') return 1;
    if (b === 'standalone') return -1;
    return a.localeCompare(b);
  });
  for (const key of keys) {
    const containers = groups.get(key);
    const details = element('details', 'project-group');
    details.open = !collapsedGroups.has(key);
    details.addEventListener('toggle', () => {
      if (details.open) collapsedGroups.delete(key);
      else collapsedGroups.add(key);
    });
    const summary = element('summary', 'group-summary');
    const title = element('span', 'group-title', key === 'standalone' ? 'Standalone containers' : key.slice('project:'.length));
    const count = element('span', 'group-count', `${containers.length} container${containers.length === 1 ? '' : 's'}`);
    const running = containers.filter((container) => container.state === 'running').length;
    const runningLabel = element('span', 'group-running', `${running} running`);
    summary.append(title, count, runningLabel);
    details.append(summary);
    const rows = element('div', 'container-rows');
    for (const container of containers) rows.append(makeContainerRow(container));
    details.append(rows);
    groupsElement.append(details);
  }
}

function setLoading(value) {
  loading = value;
  refreshButton.disabled = value;
  refreshButton.textContent = value ? 'Refreshing…' : '↻ Refresh';
}

refreshButton.addEventListener('click', () => {
  if (loading) return;
  setLoading(true);
  statusElement.textContent = 'Refreshing local Docker inventory…';
  vscode.postMessage({ type: 'refresh' });
});
searchInput.addEventListener('input', render);
filterSelect.addEventListener('change', render);

window.addEventListener('message', (event) => {
  const message = event.data;
  if (!message || typeof message !== 'object' || Array.isArray(message)) return;
  if (message.type === 'loading') {
    setLoading(true);
    errorElement.hidden = true;
    statusElement.textContent = 'Reading local Docker inventory…';
    render();
  } else if (message.type === 'inventory' && message.snapshot && Array.isArray(message.snapshot.containers)) {
    snapshot = message.snapshot;
    setLoading(false);
    errorElement.hidden = true;
    statusElement.textContent = 'Local Docker Engine connected';
    document.documentElement.dataset.connected = 'true';
    const counts = snapshot.counts;
    setCount('count-running', counts.running);
    setCount('count-stopped', counts.stopped);
    setCount('count-images', counts.images);
    setCount('count-networks', counts.networks);
    setCount('count-volumes', counts.volumes);
    setCount('container-total', counts.containers);
    detailElement.textContent = `Updated ${new Date(snapshot.capturedAt).toLocaleTimeString()} · All workspaces · Manual refresh`;
    render();
  } else if (message.type === 'error' && typeof message.message === 'string') {
    setLoading(false);
    errorElement.textContent = `Docker inventory unavailable: ${message.message}`;
    errorElement.hidden = false;
    statusElement.textContent = 'Could not refresh local Docker inventory';
    detailElement.textContent = snapshot ? 'Showing the last successful snapshot.' : 'Check that Docker Engine is running and your user has socket access.';
    render();
  }
});

setLoading(true);
vscode.postMessage({ type: 'ready' });
