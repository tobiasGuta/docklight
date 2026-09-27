import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { getContainerLogs, getContainerStats, getInventory, type InventorySnapshot } from './docker';
import { parseWebviewMessage } from './protocol';

let dashboardPanel: vscode.WebviewPanel | undefined;
let cleanupPanel: (() => void) | undefined;
const STATS_INTERVAL_MS = 10_000;

export function activate(context: vscode.ExtensionContext): void {
  const openDashboard = vscode.commands.registerCommand('docklight.openDashboard', () => {
    if (dashboardPanel) {
      dashboardPanel.reveal(vscode.ViewColumn.Active);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'docklight.dashboard', 'Docklight', vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: false,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
      },
    );
    dashboardPanel = panel;
    let disposed = false;
    let inventory: InventorySnapshot | undefined;
    let inventoryController: AbortController | undefined;
    let pendingRefresh = false;
    let selectedId: string | undefined;
    let statsController: AbortController | undefined;
    let logsController: AbortController | undefined;
    let statsTimer: ReturnType<typeof setTimeout> | undefined;

    const stopSelectedWork = (): void => {
      if (statsTimer) clearTimeout(statsTimer);
      statsTimer = undefined;
      statsController?.abort();
      statsController = undefined;
      logsController?.abort();
      logsController = undefined;
    };
    const currentContainer = () => inventory?.containers.find((item) => item.id === selectedId);
    const canSend = (id: string, signal: AbortSignal): boolean =>
      !disposed && panel.visible && !signal.aborted && selectedId === id;

    const requestStats = async (): Promise<void> => {
      const container = currentContainer();
      if (disposed || !panel.visible || !container || statsController) return;
      if (container.state !== 'running') {
        void panel.webview.postMessage({ type: 'statsUnavailable', id: container.id, message: 'Container is not running.' });
        return;
      }
      const id = container.id;
      const controller = new AbortController();
      statsController = controller;
      void panel.webview.postMessage({ type: 'statsLoading', id });
      try {
        const stats = await getContainerStats(id, undefined, controller.signal);
        if (canSend(id, controller.signal)) void panel.webview.postMessage({ type: 'stats', id, stats });
      } catch (error) {
        if (canSend(id, controller.signal)) {
          void panel.webview.postMessage({ type: 'statsUnavailable', id, message: error instanceof Error ? error.message : 'Stats unavailable.' });
        }
      } finally {
        if (statsController === controller) statsController = undefined;
        if (canSend(id, controller.signal) && currentContainer()?.state === 'running') {
          // Schedule *after* the previous sample settles; never overlap subprocesses.
          statsTimer = setTimeout(() => { statsTimer = undefined; void requestStats(); }, STATS_INTERVAL_MS);
        }
      }
    };

    const selectContainer = (id: string): void => {
      // Format is checked in the parser. Membership prevents forged messages from inspecting
      // arbitrary local containers outside our current inventory.
      if (!inventory?.containers.some((item) => item.id === id) || disposed || !panel.visible) return;
      if (selectedId === id) return;
      stopSelectedWork();
      selectedId = id;
      void requestStats();
    };

    const loadLogs = async (): Promise<void> => {
      const container = currentContainer();
      if (!container || disposed || !panel.visible || logsController) return;
      const id = container.id;
      const controller = new AbortController();
      logsController = controller;
      void panel.webview.postMessage({ type: 'logsLoading', id });
      try {
        const logs = await getContainerLogs(id, controller.signal);
        if (canSend(id, controller.signal)) void panel.webview.postMessage({ type: 'logs', id, logs });
      } catch (error) {
        if (canSend(id, controller.signal)) {
          void panel.webview.postMessage({ type: 'logsError', id, message: error instanceof Error ? error.message : 'Logs unavailable.' });
        }
      } finally {
        if (logsController === controller) logsController = undefined;
      }
    };

    const refresh = async (): Promise<void> => {
      if (disposed || !panel.visible) return;
      if (inventoryController) {
        if (inventoryController.signal.aborted) pendingRefresh = true;
        return;
      }
      const controller = new AbortController();
      inventoryController = controller;
      void panel.webview.postMessage({ type: 'loading' });
      try {
        const snapshot = await getInventory(undefined, controller.signal);
        if (!disposed && panel.visible && !controller.signal.aborted) {
          inventory = snapshot;
          void panel.webview.postMessage({ type: 'inventory', snapshot });
          const current = currentContainer();
          if (selectedId && !current) {
            stopSelectedWork();
            selectedId = undefined;
            void panel.webview.postMessage({ type: 'selectionCleared' });
          } else if (current && current.state !== 'running') {
            if (statsTimer) clearTimeout(statsTimer);
            statsTimer = undefined;
            statsController?.abort();
            statsController = undefined;
            void panel.webview.postMessage({ type: 'statsUnavailable', id: current.id, message: 'Container is not running.' });
          } else if (current && !statsController && !statsTimer) {
            void requestStats();
          }
        }
      } catch (error) {
        if (!disposed && panel.visible && !controller.signal.aborted) {
          void panel.webview.postMessage({ type: 'error', message: error instanceof Error ? error.message : 'Could not read the local Docker Engine.' });
        }
      } finally {
        if (inventoryController === controller) inventoryController = undefined;
        if (pendingRefresh && !disposed && panel.visible) {
          pendingRefresh = false;
          void refresh();
        }
      }
    };

    const messageSubscription = panel.webview.onDidReceiveMessage((raw: unknown) => {
      const message = parseWebviewMessage(raw);
      if (!message) return;
      switch (message.type) {
        case 'ready':
          stopSelectedWork();
          selectedId = undefined;
          void refresh();
          break;
        case 'refresh':
          void refresh();
          break;
        case 'select':
          selectContainer(message.id);
          break;
        case 'clearSelection':
          stopSelectedWork();
          selectedId = undefined;
          break;
        case 'loadLogs':
          void loadLogs();
          break;
      }
    });
    const stateSubscription = panel.onDidChangeViewState(() => {
      if (!panel.visible) {
        inventoryController?.abort();
        stopSelectedWork();
        selectedId = undefined;
      } else {
        void refresh();
      }
    });
    const disposeSubscription = panel.onDidDispose(() => {
      disposed = true;
      pendingRefresh = false;
      inventoryController?.abort();
      stopSelectedWork();
      selectedId = undefined;
      if (dashboardPanel === panel) dashboardPanel = undefined;
      cleanupPanel = undefined;
      messageSubscription.dispose();
      stateSubscription.dispose();
      disposeSubscription.dispose();
    });
    cleanupPanel = () => {
      pendingRefresh = false;
      inventoryController?.abort();
      stopSelectedWork();
    };
    // Register listeners before loading HTML to avoid losing the ready handshake.
    panel.webview.html = createDashboardHtml(panel.webview, context.extensionUri);
  });
  context.subscriptions.push(openDashboard);
}

export function deactivate(): void {
  cleanupPanel?.();
  dashboardPanel?.dispose();
  dashboardPanel = undefined;
  cleanupPanel = undefined;
}

function createDashboardHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const stylesheet = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'dashboard.css'));
  const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'dashboard.js'));
  const nonce = randomBytes(16).toString('base64');
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
    `img-src ${webview.cspSource}`,
    "connect-src 'none'",
    "font-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Docklight</title>
  <link rel="stylesheet" href="${stylesheet}">
</head>
<body>
  <div class="app-shell">
    <header class="app-header">
      <div class="brand"><span class="brand-mark" aria-hidden="true">D</span>
        <div><h1>Docklight</h1><p>Local Docker overview</p></div>
      </div>
      <span class="read-only-badge">READ-ONLY</span>
    </header>
    <main>
      <section class="welcome" aria-labelledby="welcome-title">
        <div><span class="eyebrow">LOCAL ENGINE · READ-ONLY</span>
          <h2 id="welcome-title">Your Docker workspace, in one place.</h2>
          <p id="extension-status" role="status" aria-live="polite">Connecting to extension host…</p>
          <p id="status-detail" class="hint">Reading the global container inventory.</p>
        </div>
        <span class="welcome-icon" aria-hidden="true">◈</span>
      </section>
      <section class="overview" aria-label="Resource overview">
        <div class="metric"><span>Running</span><strong id="count-running">—</strong><small id="count-running-detail">Containers</small></div>
        <div class="metric"><span>Stopped / other</span><strong id="count-stopped">—</strong><small>Containers</small></div>
        <div class="metric"><span>Images</span><strong id="count-images">—</strong><small>Unique image IDs</small></div>
        <div class="metric"><span>Networks</span><strong id="count-networks">—</strong><small>Docker networks</small></div>
        <div class="metric"><span>Volumes</span><strong id="count-volumes">—</strong><small>Docker volumes</small></div>
      </section>
      <section class="inventory" aria-labelledby="inventory-heading">
        <div class="inventory-heading"><div><h2 id="inventory-heading">Containers <span id="container-total">—</span></h2>
          <p>All Compose projects and standalone containers on this local Engine.</p></div>
          <button id="refresh" type="button" title="Refresh container inventory">↻ Refresh</button>
        </div>
        <div class="toolbar">
          <label class="search-wrap"><span class="sr-only">Search containers</span><input id="search" type="search" placeholder="Search name, image, project, or service…" autocomplete="off" /></label>
          <label class="filter-wrap"><span class="sr-only">Filter containers</span><select id="filter"><option value="all">All states</option><option value="running">Running</option><option value="stopped">Stopped / other</option><option value="unhealthy">Unhealthy</option></select></label>
        </div>
        <p id="error-message" class="error-message" role="alert" hidden></p>
        <div id="groups" class="groups" aria-live="polite"></div>
        <p id="empty-message" class="empty-state">Waiting for container inventory…</p>
      </section>

      <section class="details-panel" id="details-panel" aria-labelledby="details-heading" hidden>
        <div class="inventory-heading"><div><span class="eyebrow">SELECTED CONTAINER · READ-ONLY</span><h2 id="details-heading">Container details</h2></div>
          <button type="button" id="close-details" aria-label="Close container details">✕ Close</button></div>
        <p id="details-subtitle" class="hint"></p>
        <dl class="detail-grid" id="detail-fields"></dl>
        <div class="details-section"><div class="inventory-heading"><h3>Resources</h3><span class="hint">Selected container · approximately every 10s while visible</span></div>
          <p id="stats-status" class="hint" role="status">Waiting for statistics…</p>
          <div class="resource-cards"><div class="metric"><span>CPU</span><strong id="stat-cpu">—</strong></div><div class="metric"><span>Memory</span><strong id="stat-memory">—</strong><small id="stat-memory-percent">—</small></div></div>
        </div>
        <div class="details-section"><div class="inventory-heading"><div><h3>Recent logs</h3><p class="hint">Up to 200 lines · 256 KiB maximum · may contain secrets</p></div>
          <div class="log-actions"><button id="wrap-logs" type="button" aria-pressed="false">Wrap lines: Off</button><button id="clear-logs" type="button" disabled>Clear view</button><button id="load-logs" type="button">Load recent logs</button></div></div>
          <p id="logs-status" class="hint" role="status">Logs are never loaded automatically. Output may contain secrets.</p>
          <pre id="logs-output" class="logs-output" tabindex="0" hidden></pre>
        </div>
      </section>
    </main>
    <footer>LOCAL UNIX SOCKET <span aria-hidden="true">·</span> NO TELEMETRY <span aria-hidden="true">·</span> READ-ONLY <span aria-hidden="true">·</span> BOUNDED MONITORING</footer>
  </div>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}
