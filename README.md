# Docklight

A lightweight, private-use, read-only Docker dashboard that opens in a VS Code editor tab. This repository is a **Phase 2 scaffold**: it intentionally makes **no Docker calls** and shows no real container data yet.

## Design boundaries

- One local VS Code UI extension, one Webview, no separate server.
- Plain HTML/CSS/JavaScript frontend; TypeScript extension host.
- Packaged assets only, strict Webview CSP, and an allowlisted message protocol.
- No telemetry, remote resources, Docker socket exposure, or resource mutations.
- The future inventory will come from the existing **local** Docker Engine, independently of the open VS Code workspace.

## Develop on Fedora

```bash
cd /mnt/Development/Tools
git clone https://github.com/tobiasGuta/docklight.git
cd docklight
npm install
npm test
code .
```

Press **F5** to launch the Extension Development Host. Open the Command Palette and run **Docklight: Open Dashboard**. The status should change from `Connecting to extension host…` to `Extension host connected`. Closing and reopening the tab should work, and only one tab should exist per extension host.

> The location above is only the extension source. It does not install or reconfigure Docker, and it does not touch existing projects.

## Package locally

```bash
npm run package
```

Install the generated `.vsix` with **Extensions → … → Install from VSIX…**, or `code --install-extension docklight-0.1.0.vsix`.

## Next milestone

Phase 3 will add read-only local container inventory, Compose-label grouping, health, uptime, search, and resource summaries. No management operations will be added without a separate scope decision.
