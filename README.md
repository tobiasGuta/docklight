# Docklight

A small, **read-only Docker dashboard** inside a full Visual Studio Code editor tab. It shows the existing Fedora Docker Engine across every VS Code workspace. No Docker Desktop installation, extra daemon, framework, telemetry, or dependency on Microsoft's Container Tools extension.

## Features (v0.4.0)

- Global running/stopped inventory, Compose project grouping, health, image, uptime, published ports, search, and status filters.
- Summary counts for unique image IDs, networks, and volumes.
- Click a container to jump to its details: ID, image, state, health, uptime, and published ports.
- Selected **running** container only: one CPU/memory sample about every 10 seconds while the Webview is visible. No historical measurements.
- Explicit **Load recent logs** / **Refresh logs**: up to 200 lines and a combined 256 KiB cap. Use **Wrap lines** for long entries or **Clear view** to discard the displayed text locally. Logs are never auto-fetched.
- Manual inventory refresh, error messages that preserve the last successful snapshot, and cancellation when the tab is hidden, selection changes, or the editor closes.

The extension remains strictly read-only: no create/start/stop/delete, pruning, builds, terminals, remote connections, or registry access. Resource count cards are summaries, not separate resource browsers.

## Build and test on Fedora

```bash
cd /mnt/Development/Tools/docklight
git pull --ff-only
npm install
npm run verify
code .
```

Press **F5** in the source VS Code window. In the Extension Development Host, run **Docklight: Open Dashboard** via the Command Palette. If the debugger stalls during startup, stop it and use **Ctrl+F5** instead.

### Package and install a private VSIX

```bash
cd /mnt/Development/Tools/docklight
npm run package
code --install-extension ./docklight-0.4.0.vsix --force
```

The packaging command compiles, runs automated tests and release assertions, invokes the official `@vscode/vsce` packager, then uses `unzip` to verify the VSIX contains the extension manifest and runtime files and **does not contain source, tests, node_modules, logs, or environment files**. `npm install` installs build tooling only; the installed extension has no npm runtime dependencies. `unzip` is a packaging-check utility, not an extension runtime requirement. If it isn't installed: `sudo dnf install unzip`.

To see the installed version:

```bash
code --list-extensions --show-versions | grep -i '^tobiasguta\.docklight@'
```

After installing, open an ordinary VS Code window (no Extension Development Host needed) and run **Docklight: Open Dashboard**. The built VSIX is local-only; `npm run package` does **not** publish anything to the Marketplace or create a GitHub release. The VSIX is ignored by Git; keep it locally rather than committing it to the source repository.

## Final local smoke test

1. Open the installed dashboard and confirm the running and stopped totals match `docker --host unix:///var/run/docker.sock container ls -a`.
2. Try searching by name or host port and filtering by state. The displayed count should update.
3. Select a running container. It should scroll to details and show CPU/memory; wait about 10 seconds for another sample.
4. Opt in to recent logs; verify line wrapping and Clear view. **Check for secrets before sharing a screenshot.**
5. Select a stopped container. It should show no live resource statistics. Hide and reopen the tab and confirm polling resumes only for an active selection.
6. Close the editor tab and confirm normal VS Code operation. No Docker resources should have changed.

## Security and limitations

The CLI is invoked **only by the local extension host** with argument arrays (`shell: false`) and the explicit `unix:///var/run/docker.sock` endpoint. No Docker socket is exposed over HTTP/TCP. Only validated full IDs from the latest inventory may be selected. The inspection template excludes `Config.Env`, full configuration, mountpoints, and arbitrary labels. The Webview uses a restrictive CSP, locally bundled assets, a small message allowlist, and safe `textContent` rendering. Logs are opt-in, limited, and not persisted by Docklight.

Logs can contain secrets. **Clear view** removes the Webview's displayed text; it does not remove the original Docker logs or guarantee that secrets have not been displayed or captured by the OS. Docker group access is privileged; read-only is an application-level policy, not a daemon-enforced capability boundary. Do not treat an untrusted extension or container output as safe.

The current version supports the conventional **local rootful UNIX socket** only; it never follows a remote Docker context. A different local socket path can be considered later if required. Docker's existing storage and containerd configuration are untouched.

## Project structure

- `src/extension.ts` — editor panel, validated messages, selection and polling lifecycle.
- `src/docker.ts` — fixed read-only Docker CLI interface and bounded output.
- `src/protocol.ts` — minimal Webview message allowlist.
- `media/` — vanilla JavaScript/CSS; reacts to VS Code theme colors.
- `test/` — deterministic unit tests using mock Docker and Webview interfaces.
- `scripts/` — release asset and VSIX safety checks; never shipped.

[VS Code's official VSIX packaging guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
