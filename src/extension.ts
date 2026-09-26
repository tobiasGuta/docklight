import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { parseWebviewMessage } from './protocol';

let dashboardPanel: vscode.WebviewPanel | undefined;

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

    const messageSubscription = panel.webview.onDidReceiveMessage((raw: unknown) => {
      const message = parseWebviewMessage(raw);
      if (message?.type === 'ready') {
        void panel.webview.postMessage({ type: 'bootstrap', mode: 'scaffold' });
      }
    });

    const disposeSubscription = panel.onDidDispose(() => {
      if (dashboardPanel === panel) {
        dashboardPanel = undefined;
      }
      messageSubscription.dispose();
      disposeSubscription.dispose();
    });

    // Register the message listener before loading HTML so the ready handshake cannot race it.
    panel.webview.html = createDashboardHtml(panel.webview, context.extensionUri);
  });

  context.subscriptions.push(openDashboard);
}

export function deactivate(): void {
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
        <div><span class="eyebrow">PHASE 2 · EXTENSION SCAFFOLD</span>
          <h2 id="welcome-title">Your Docker workspace, in one place.</h2>
          <p id="extension-status" role="status" aria-live="polite">Connecting to extension host…</p>
          <p id="status-detail" class="hint">This version does not access Docker or change any resources.</p>
        </div>
        <span class="welcome-icon" aria-hidden="true">◈</span>
      </section>
      <section class="overview" aria-label="Resource overview">
        <div class="metric"><span>Containers</span><strong>—</strong><small>Inventory in Phase 3</small></div>
        <div class="metric"><span>Images</span><strong>—</strong><small>Inventory in Phase 3</small></div>
        <div class="metric"><span>Networks</span><strong>—</strong><small>Inventory in Phase 3</small></div>
        <div class="metric"><span>Volumes</span><strong>—</strong><small>Inventory in Phase 3</small></div>
      </section>
      <section class="empty-state" aria-labelledby="empty-title">
        <div class="empty-symbol" aria-hidden="true">▣</div>
        <h2 id="empty-title">Container inventory is coming next</h2>
        <p>The next phase adds global container listing, Compose grouping, health, and search.</p>
      </section>
    </main>
    <footer>LOCAL ONLY <span aria-hidden="true">·</span> NO TELEMETRY <span aria-hidden="true">·</span> NO DOCKER OPERATIONS IN THIS PHASE</footer>
  </div>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}
