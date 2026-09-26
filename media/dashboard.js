'use strict';

const vscode = acquireVsCodeApi();
const status = document.getElementById('extension-status');
const detail = document.getElementById('status-detail');

window.addEventListener('message', (event) => {
  const message = event.data;
  if (!message || message.type !== 'bootstrap' || message.mode !== 'scaffold') {
    return;
  }

  status.textContent = 'Extension host connected';
  detail.textContent = 'The Webview is ready. Docker integration begins in Phase 3.';
  document.documentElement.dataset.connected = 'true';
});

vscode.postMessage({ type: 'ready' });
