import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { getInventory } from './docker';
import { parseWebviewMessage } from './protocol';

let dashboardPanel: vscode.WebviewPanel | undefined;
let activeController: AbortController | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const openDashboard = vscode.commands.registerCommand('docklight.openDashboard', () => {
    if (dashboardPanel) {
      dashboardPanel.reveal(vscode.ViewColumn.Active);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'docklight.dashboard',
      'Docklight',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: false,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
      },
    );

    dashboardPanel = panel;
    let disposed = false;
    let pendingRefresh = false;

    const refresh = async (): Promise<void> => {
      if (disposed) {
        return;
      }
      if (activeController) {
        if (activeController.signal.aborted) pendingRefresh = true;
        return;
      }
      const controller = new AbortController();
      activeController = controller;
      void panel.webview.postMessage({ type: 'loading' });
      try {
        const snapshot = await getInventory(undefined, controller.signal);
        if (!disposed && !controller.signal.aborted && panel.visible) {
          void panel.webview.postMessage({ type: 'inventory', snapshot });
        }
      } catch (error) {
        if (!disposed && !controller.signal.aborted && panel.visible) {
          const message = error instanceof Error ? error.message : 'Could not read the local Docker Engine.';
          void panel.webview.postMessage({ type: 'error', message });
        }
      } finally {
        if (activeController === controller) {
          activeController = undefined;
        }
        if (pendingRefresh && !disposed && panel.visible) {
          pendingRefresh = false;
          void refresh();
        }
      }
    };

    const messageSubscription = panel.webview.onDidReceiveMessage((raw: unknown) => {
      const message = parseWebviewMessage(raw);
      if (message?.type === 'ready' || message?.type === 'refresh') {
        void refresh();
      }
    });

    const stateSubscription = panel.onDidChangeViewState(() => {
      if (!panel.visible) {
        activeController?.abort();
      } else {
        void refresh();
      }
    });

    const disposeSubscription = panel.onDidDispose(() => {
      disposed = true;
      activeController?.abort();
      if (dashboardPanel === panel) {
        dashboardPanel = undefined;
      }
      messageSubscription.dispose();
      stateSubscription.dispose();
      disposeSubscription.dispose();
    });

    // Listen before loading HTML: the ready handshake must not race registration.
    panel.webview.html = createDashboardHtml(panel.webview, context.extensionUri);
  });

  context.subscriptions.push(openDashboard);
}

export function deactivate(): void {
  activeController?.abort();
  dashboardPanel?.dispose();
  dashboardPanel = undefined;
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
    </main>
    <footer>LOCAL UNIX SOCKET <span aria-hidden="true">·</span> NO TELEMETRY <span aria-hidden="true">·</span> READ-ONLY <span aria-hidden="true">·</span> MANUAL REFRESH</footer>
  </div>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}
