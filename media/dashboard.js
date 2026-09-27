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
const detailsPanel = document.getElementById('details-panel');
const fieldsElement = document.getElementById('detail-fields');
const closeDetailsButton = document.getElementById('close-details');
const logsButton = document.getElementById('load-logs');
const logsStatus = document.getElementById('logs-status');
const logsOutput = document.getElementById('logs-output');
const clearLogsButton = document.getElementById('clear-logs');
const wrapLogsButton = document.getElementById('wrap-logs');
const statsStatus = document.getElementById('stats-status');

let snapshot = null;
let loading = false;
let selectedId = null;
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
    .filter((value) => typeof value === 'string')
    .concat(container.id, ...container.publishedPorts.map((port) => `${port.hostIp}:${port.hostPort} ${port.containerPort}`))
    .join(' ').toLowerCase();
  return haystack.includes(search);
}

function makeContainerRow(container) {
  const row = element('button', 'container-row');
  row.type = 'button';
  row.setAttribute('aria-pressed', String(selectedId === container.id));
  row.setAttribute('aria-label', `View details for ${container.name}`);
  if (selectedId === container.id) row.className += ' selected';
  row.addEventListener('click', () => selectContainer(container.id));
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

function selectedContainer() {
  return snapshot?.containers.find((container) => container.id === selectedId);
}

function clearDetailView() {
  selectedId = null;
  detailsPanel.hidden = true;
  fieldsElement.replaceChildren();
  logsOutput.textContent = '';
  logsOutput.hidden = true;
  logsStatus.textContent = 'Logs are never loaded automatically. Output may contain secrets.';
  clearLogsButton.disabled = true;
  logsButton.disabled = false;
  statsStatus.textContent = 'Waiting for statistics…';
  document.getElementById('stat-cpu').textContent = '—';
  document.getElementById('stat-memory').textContent = '—';
  document.getElementById('stat-memory-percent').textContent = '—';
}

function selectContainer(id) {
  const container = snapshot?.containers.find((item) => item.id === id);
  if (!container || selectedId === id) return;
  selectedId = id;
  logsOutput.textContent = '';
  logsOutput.hidden = true;
  logsStatus.textContent = 'Logs are never loaded automatically. Output may contain secrets.';
  clearLogsButton.disabled = true;
  logsButton.disabled = false;
  statsStatus.textContent = container.state === 'running' ? 'Reading resource statistics…' : 'Container is not running.';
  document.getElementById('stat-cpu').textContent = '—';
  document.getElementById('stat-memory').textContent = '—';
  document.getElementById('stat-memory-percent').textContent = '—';
  renderDetails();
  render();
  vscode.postMessage({ type: 'select', id });
  detailsPanel.scrollIntoView?.({ block: 'start' });
}

function appendField(label, value) {
  fieldsElement.append(element('dt', '', label), element('dd', '', value));
}

function renderDetails() {
  const container = selectedContainer();
  if (!container) {
    clearDetailView();
    return;
  }
  detailsPanel.hidden = false;
  document.getElementById('details-heading').textContent = container.name;
  document.getElementById('details-subtitle').textContent = container.image;
  fieldsElement.replaceChildren();
  appendField('Full ID', container.id);
  appendField('State', displayState(container));
  appendField('Image', container.image);
  appendField('Compose project', container.project || 'Standalone');
  appendField('Compose service', container.service || '—');
  appendField('Health', container.health || 'No health check');
  appendField('Uptime', container.state === 'running' && container.startedAt ? formatUptime(container.startedAt) : 'Not running');
  appendField('Published ports', container.publishedPorts.length ? container.publishedPorts.map((port) => {
    const host = port.hostIp.includes(':') ? `[${port.hostIp}]` : (port.hostIp || '*');
    return `${host}:${port.hostPort} → ${port.containerPort}`;
  }).join(' · ') : 'None');
  if (container.state !== 'running') {
    statsStatus.textContent = 'Container is not running.';
    document.getElementById('stat-cpu').textContent = '—';
    document.getElementById('stat-memory').textContent = '—';
    document.getElementById('stat-memory-percent').textContent = '—';
  }
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
  document.getElementById('container-total').textContent = search || filter !== 'all'
    ? `${visible.length} / ${snapshot.containers.length}` : String(snapshot.containers.length);
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
closeDetailsButton.addEventListener('click', () => {
  clearDetailView();
  render();
  vscode.postMessage({ type: 'clearSelection' });
});
logsButton.addEventListener('click', () => {
  if (!selectedContainer() || logsButton.disabled) return;
  logsButton.disabled = true;
  logsStatus.textContent = 'Loading a bounded log snapshot…';
  logsOutput.hidden = true;
  logsOutput.textContent = '';
  clearLogsButton.disabled = true;
  vscode.postMessage({ type: 'loadLogs' });
});
clearLogsButton.addEventListener('click', () => {
  logsOutput.textContent = '';
  logsOutput.hidden = true;
  clearLogsButton.disabled = true;
  logsStatus.textContent = 'Log view cleared locally. Use Refresh logs to request a new snapshot.';
});
wrapLogsButton.addEventListener('click', () => {
  const wrapped = logsOutput.className !== 'logs-output wrapped';
  logsOutput.className = wrapped ? 'logs-output wrapped' : 'logs-output';
  wrapLogsButton.textContent = wrapped ? 'Wrap lines: On' : 'Wrap lines: Off';
  wrapLogsButton.setAttribute('aria-pressed', String(wrapped));
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
    if (selectedId) renderDetails();
    render();
  } else if (message.type === 'error' && typeof message.message === 'string') {
    setLoading(false);
    errorElement.textContent = `Docker inventory unavailable: ${message.message}`;
    errorElement.hidden = false;
    statusElement.textContent = 'Could not refresh local Docker inventory';
    detailElement.textContent = snapshot ? 'Showing the last successful snapshot.' : 'Check that Docker Engine is running and your user has socket access.';
    render();
  } else if (message.type === 'selectionCleared') {
    clearDetailView();
    render();
  } else if (selectedId && message.id === selectedId) {
    if (message.type === 'statsLoading') {
      statsStatus.textContent = 'Reading resource statistics…';
    } else if (message.type === 'stats' && message.stats) {
      document.getElementById('stat-cpu').textContent = message.stats.cpuPercent;
      document.getElementById('stat-memory').textContent = message.stats.memoryUsage;
      document.getElementById('stat-memory-percent').textContent = message.stats.memoryPercent;
      statsStatus.textContent = `Updated ${new Date(message.stats.capturedAt).toLocaleTimeString()} · 10s refresh while visible`;
    } else if (message.type === 'statsUnavailable') {
      document.getElementById('stat-cpu').textContent = '—';
      document.getElementById('stat-memory').textContent = '—';
      document.getElementById('stat-memory-percent').textContent = '—';
      statsStatus.textContent = message.message;
    } else if (message.type === 'logsLoading') {
      logsButton.disabled = true;
      logsStatus.textContent = 'Loading a bounded log snapshot…';
      logsOutput.hidden = true;
    } else if (message.type === 'logs' && message.logs) {
      logsButton.disabled = false;
      logsOutput.hidden = false;
      logsOutput.textContent = message.logs.text || '(No log entries returned.)';
      clearLogsButton.disabled = false;
      logsStatus.textContent = message.logs.truncated
        ? 'Output truncated at 256 KiB. Showing the captured portion.'
        : 'Up to 200 recent log lines · manual refresh only · may contain secrets';
      logsButton.textContent = 'Refresh logs';
    } else if (message.type === 'logsError') {
      logsButton.disabled = false;
      logsOutput.hidden = true;
      logsOutput.textContent = '';
      clearLogsButton.disabled = true;
      logsStatus.textContent = `Logs unavailable: ${message.message}`;
    }
  }
});

setLoading(true);
vscode.postMessage({ type: 'ready' });
