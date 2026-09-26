# Docklight

A small, locally installed, read-only Docker inventory inside a full VS Code editor tab. **Phase 3** reads the existing Fedora Docker Engine across **all workspaces**, groups containers using Compose project labels, and provides a midnight-inspired, theme-aware interface. No Docker Desktop, additional service, or third-party VS Code extension is required.

## Features in this phase

- All running and stopped containers, grouped by `com.docker.compose.project`; unlabeled containers appear under **Standalone containers**.
- Container name, image, running state, health, running uptime, service name, and **published** host ports.
- Client-side search and All / Running / Stopped / Unhealthy filters.
- Overview counts of running/stopped containers, unique image IDs, networks, and volumes.
- Manual Refresh; a new inventory is also requested on dashboard activation and when the editor tab becomes visible again.
- Bounded, abortable Docker CLI subprocesses; no background daemon or resource polling.

**Not yet implemented:** container detail inspector, live CPU/memory, logs, resource browsing, container operations, remote contexts, or historical data. Those are separate scope decisions for subsequent phases.

## Get started on Fedora

```bash
cd /mnt/Development/Tools
# On a new machine, clone first: git clone https://github.com/tobiasGuta/docklight.git
cd docklight
git pull --ff-only
npm install
npm test
code .
```

Press **F5** (or **Ctrl+F5** if your VS Code debugger pauses the Extension Development Host), then run **Docklight: Open Dashboard** in the new window's Command Palette. You should see the inventory from all local projects, including stopped containers. Switch to another workspace: the dashboard still shows the same local Engine. Click Refresh after a Docker change.

The CLI is required in the **local VS Code extension host PATH**. Docklight explicitly uses `unix:///var/run/docker.sock` regardless of the active Docker CLI context or workspace. It does not change the Engine's data-root, containerd settings, or storage.

Verify the local endpoint if the dashboard reports an error:

```bash
test -S /var/run/docker.sock && echo 'Local Docker socket exists'
docker --host unix:///var/run/docker.sock container ls -a --format json
```

A rootless or nonstandard UNIX socket is not configurable in v0.2.0. We can add a strictly local socket-path setting if your Engine actually uses one. **Do not grant additional daemon permissions just to fix a Docklight UI error.**

## Security model

- Docker execution happens only in the extension host using `spawn` with an argument array, `shell: false`, and a fixed local UNIX socket. `DOCKER_HOST` and `DOCKER_CONTEXT` are excluded from subprocess environment overrides.
- The Webview accepts no arbitrary Docker commands. Its only messages are an exact `{ "type": "ready" }` or `{ "type": "refresh" }`; there is no mutation handler.
- Container IDs are full 64-character hexadecimal strings from a JSON-formatted global listing; they are checked before being passed to a **read-only** `container inspect` command.
- `docker container inspect --format` emits **only** ID, name, image, state, started time, health, published-port bindings, and the two Compose labels. Full inspect output and `Config.Env` are never passed to the Webview.
- Resource summaries are counts only; images are deduplicated by ID. No volume mountpoints, container environment variables, or labels other than Compose project/service are displayed.
- Webview CSP disallows default external resources, network connections, objects, and frames. Dynamic daemon text is rendered as `textContent`, not HTML. No external assets, analytics, or telemetry.
- One outstanding inventory request at a time; processes have an 8-second per-command timeout and an 8 MiB stdout bound. Inspection is batched in groups of 50. Requests are aborted on hidden/disposed tabs. **No automatic periodic polling.**

**Important limitation:** a normal user's access to a rootful Docker daemon is already a privileged capability. These read-only checks are an application-level policy, not a daemon-enforced security boundary. Do not install untrusted extensions or treat container-provided names/metadata as trusted input. CLI errors can disclose details about the local Engine to the local Webview. Docklight never exposes the socket through a network listener.

## Developer commands

```bash
npm run check   # TypeScript, no output
npm test        # compile + deterministic tests (mock Docker and Webview)
npm run package # creates docklight-0.2.0.vsix; packaging/polish are Phase 5
```

The automated tests use a mock Docker CLI and Webview. A **live-engine smoke test on your Fedora machine** is required before calling Phase 3 fully verified. If a running container is missing or grouping/ports are unexpected, send the dashboard screenshot and relevant **redacted** extension-host error; do not post environment variables or full inspect output.

No files in Reconductor or ParamIntel are involved.
