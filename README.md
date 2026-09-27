# Docklight

A small, locally installed, **read-only** Docker dashboard in a full VS Code editor tab. It uses your existing local Docker Engine on Fedora and shows containers across **all VS Code workspaces**. No Docker Desktop, separate backend, network socket, or dependency on another VS Code extension.

## Current features (Phase 4 / v0.3.0)

- Global inventory of running and stopped containers grouped by the canonical `com.docker.compose.project` label; unlabeled containers appear as **Standalone containers**.
- Container name, image, state, health, running uptime, Compose service, and published host ports.
- Search, status filtering, manual refresh, and summary counts of unique images, networks, and volumes.
- Select a container to inspect its full ID and the fields above; **no full Docker inspect response or environment variables are forwarded to the Webview**.
- CPU percentage, memory usage, and memory percentage for the **selected running container only**, sampled using `docker container stats --no-stream --format json` approximately every 10 seconds while visible. No history, charts, or stats for stopped containers.
- Recent logs on explicit request, last 200 entries and at most 256 KiB, with a manual refresh button. No log following, background retrieval, or storage.

**Not included:** create/start/stop/delete, prune, build, terminal, registry authentication, Kubernetes, remote contexts, historical charts, automatic log streaming, or telemetry. The resource-count cards are summaries, not inventory browsers.

## Use on Fedora

```bash
cd /mnt/Development/Tools/docklight
git pull --ff-only
npm install
npm test
code .
```

Press **F5** (or **Ctrl+F5** if the debugger stalls) and run **Docklight: Open Dashboard** in the Extension Development Host. Click any container row to open its details section. Resource values begin loading for running containers; click **Load recent logs** if needed. Switch containers, hide the tab, or close it to cancel outstanding monitoring.

Docklight explicitly targets `unix:///var/run/docker.sock` in the **local VS Code UI extension host**, independently of the current workspace or Docker CLI context. If you use a nonstandard/rootless socket, v0.3.0 does not offer a custom socket setting; we can add a strictly local path configuration separately if your environment requires it. Don't change Docker Engine permissions or storage settings for Docklight.

```bash
test -S /var/run/docker.sock && echo 'Local Docker socket exists'
docker --host unix:///var/run/docker.sock container ls -a --format json
```

## Security and operational limits

- The extension host launches the existing Docker CLI with an argument vector, `shell: false`, no stdin, fixed local UNIX socket, and no inherited `DOCKER_HOST`/`DOCKER_CONTEXT` overrides. Webview messages are strictly allowlisted. An ID must be a full hexadecimal container ID **and be present in the latest inventory** before selection can trigger any Docker command.
- Docker inspection is narrowly formatted to return only non-secret dashboard fields, including two exact Compose labels. No `Config.Env`, full inspect object, mountpoint, or other arbitrary container configuration is sent to the Webview.
- Webview CSP denies default external resources and connections; daemon-provided names, metadata, errors, and logs use text rendering, never `innerHTML`. Assets are packaged locally.
- Inventory commands have an 8-second timeout, bounded output, and batched inspection. Resource polling has at most one pending request for the selected container and waits 10 seconds after each sample. It stops when the tab is hidden or selection changes. Logs have an 8-second timeout and a combined 256 KiB stdout/stderr cap; overlong output is truncated, and retrieval is stopped. The order between stdout and stderr log streams is not guaranteed.
- **Log text can contain credentials or other sensitive data.** Loading it is opt-in. Docklight doesn't automatically redact or persist logs; avoid sharing screenshots of sensitive output.
- Read-only is enforced in extension code, **not** a daemon-enforced permission boundary. Ordinary rootful Docker access is privileged. A compromised local extension host is outside this MVP's security guarantees.

## Development

```bash
npm run check  # TypeScript
npm test       # compile and deterministic tests with mocked Docker/Webview
npm run package
```

A live-engine smoke test on your Fedora machine is still necessary: select a running container, watch CPU/memory update, manually load recent logs, select a stopped container, and hide/reopen the tab. Automated tests do **not** prove behavior against the actual local Docker Engine or the live VS Code UI.

No files in Reconductor or ParamIntel are involved.
