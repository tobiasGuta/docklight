import { spawn } from 'node:child_process';

/** Only the local Docker Engine is supported. No TCP, context, or remote-host selection. */
const DOCKER_HOST = 'unix:///var/run/docker.sock';
const COMMAND_TIMEOUT_MS = 8_000;
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 4 * 1024;
const INSPECT_BATCH_SIZE = 50;

/** Docker CLI emits JSON Lines for --format json; inspection is a narrow projection.
 * Never request full inspect JSON: it may include Config.Env and other secrets.
 */
export const INSPECT_TEMPLATE = [
  '{"id":{{json .Id}}',
  '"name":{{json .Name}}',
  '"image":{{json .Config.Image}}',
  '"state":{{json .State.Status}}',
  '"startedAt":{{json .State.StartedAt}}',
  // Health may be absent entirely on containers without a HEALTHCHECK; use index.
  '"health":{{with index .State "Health"}}{{json .Status}}{{else}}""{{end}}',
  '"ports":{{json .NetworkSettings.Ports}}',
  '"project":{{with .Config.Labels}}{{with index . "com.docker.compose.project"}}{{json .}}{{else}}""{{end}}{{else}}""{{end}}',
  '"service":{{with .Config.Labels}}{{with index . "com.docker.compose.service"}}{{json .}}{{else}}""{{end}}{{else}}""{{end}}}',
].join(',');

export interface PublishedPort {
  containerPort: string;
  hostIp: string;
  hostPort: string;
}

export interface ContainerSummary {
  id: string;
  name: string;
  image: string;
  state: string;
  health: string | null;
  startedAt: string | null;
  project: string | null;
  service: string | null;
  publishedPorts: PublishedPort[];
}

export interface InventorySnapshot {
  containers: ContainerSummary[];
  counts: {
    containers: number;
    running: number;
    stopped: number;
    images: number;
    networks: number;
    volumes: number;
  };
  capturedAt: string;
}

export type DockerRunner = (args: readonly string[], signal?: AbortSignal) => Promise<string>;

/** The only process entry point. All arguments are fixed by Docklight or validated IDs. */
export const runDocker: DockerRunner = (args, signal) => new Promise((resolve, reject) => {
  const { DOCKER_HOST: _host, DOCKER_CONTEXT: _context, ...environment } = process.env;
  const child = spawn('docker', ['--host', DOCKER_HOST, ...args], {
    shell: false,
    cwd: '/',
    env: environment,
    signal,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutSize = 0;
  let stderrSize = 0;
  let failure: Error | undefined;
  const failAndKill = (error: Error): void => {
    failure ??= error;
    child.kill('SIGKILL');
  };
  const timer = setTimeout(() => failAndKill(new Error('Docker request timed out.')), COMMAND_TIMEOUT_MS);

  child.stdout.on('data', (part: Buffer) => {
    stdoutSize += part.length;
    if (stdoutSize > MAX_STDOUT_BYTES) {
      failAndKill(new Error('Docker returned more data than the inventory limit allows.'));
    } else {
      stdout.push(part);
    }
  });
  child.stderr.on('data', (part: Buffer) => {
    stderrSize += part.length;
    if (stderrSize <= MAX_STDERR_BYTES) {
      stderr.push(part);
    }
  });
  child.on('error', (error: Error) => {
    failure ??= error;
  });
  child.on('close', (exitCode) => {
    clearTimeout(timer);
    if (failure) {
      reject(failure);
    } else if (exitCode !== 0) {
      const detail = Buffer.concat(stderr).toString('utf8').trim();
      reject(new Error(detail || `Docker exited with code ${String(exitCode)}.`));
    } else {
      resolve(Buffer.concat(stdout).toString('utf8'));
    }
  });
});

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Docker returned an unexpected JSON record.');
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Docker returned an invalid ${field} field.`);
  }
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** No parsing of tabular CLI output, label strings, or human-readable status. */
export function parseJsonLines(output: string): unknown[] {
  return output.split(/\r?\n/).filter((line) => line.trim().length > 0).map((line) => {
    try {
      return JSON.parse(line) as unknown;
    } catch {
      throw new Error('Docker returned invalid JSON Lines output.');
    }
  });
}

export function parseContainer(value: unknown): ContainerSummary {
  const item = record(value);
  const id = requiredString(item.id, 'container ID');
  if (!/^[0-9a-f]{64}$/.test(id)) {
    throw new Error('Docker returned an invalid full container ID.');
  }

  const ports = item.ports == null ? {} : record(item.ports);
  const publishedPorts: PublishedPort[] = [];
  for (const [containerPort, bindings] of Object.entries(ports)) {
    // null signifies an exposed container port without any published host binding.
    if (bindings == null) {
      continue;
    }
    if (!Array.isArray(bindings)) {
      throw new Error('Docker returned an invalid port binding.');
    }
    for (const binding of bindings) {
      const entry = record(binding);
      publishedPorts.push({
        containerPort,
        hostIp: requiredString(entry.HostIp, 'host IP'),
        hostPort: requiredString(entry.HostPort, 'host port'),
      });
    }
  }
  publishedPorts.sort((a, b) => a.containerPort.localeCompare(b.containerPort) || a.hostIp.localeCompare(b.hostIp));

  const rawName = requiredString(item.name, 'container name');
  const state = requiredString(item.state, 'container state');
  return {
    id,
    name: rawName.startsWith('/') ? rawName.slice(1) : rawName,
    image: requiredString(item.image, 'image'),
    state,
    health: optionalString(item.health),
    startedAt: state === 'running' ? optionalString(item.startedAt) : null,
    project: optionalString(item.project),
    service: optionalString(item.service),
    publishedPorts,
  };
}

function idsFromOutput(output: string): string[] {
  return parseJsonLines(output).map((value) => {
    const id = requiredString(value, 'container ID');
    if (!/^[0-9a-f]{64}$/.test(id)) {
      throw new Error('Docker returned an invalid full container ID.');
    }
    return id;
  });
}

async function inspectAll(ids: string[], run: DockerRunner, signal?: AbortSignal): Promise<ContainerSummary[]> {
  const result: ContainerSummary[] = [];
  for (let index = 0; index < ids.length; index += INSPECT_BATCH_SIZE) {
    const batch = ids.slice(index, index + INSPECT_BATCH_SIZE);
    const data = parseJsonLines(await run(['container', 'inspect', '--format', INSPECT_TEMPLATE, ...batch], signal))
      .map(parseContainer);
    const expected = new Set(batch);
    if (data.length !== batch.length || data.some((item) => !expected.delete(item.id)) || expected.size !== 0) {
      throw new Error('Docker returned an incomplete container inspection.');
    }
    result.push(...data);
  }
  return result;
}

/** If a container disappears between listing and inspection, retry once with a fresh list. */
async function loadContainers(run: DockerRunner, signal?: AbortSignal): Promise<ContainerSummary[]> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const ids = idsFromOutput(await run(['container', 'ls', '--all', '--no-trunc', '--format', '{{json .ID}}'], signal));
    if (ids.length === 0) {
      return [];
    }
    try {
      return await inspectAll(ids, run, signal);
    } catch (error) {
      if (attempt !== 0 || signal?.aborted) {
        throw error;
      }
    }
  }
  return [];
}

function countImages(output: string): number {
  const ids = new Set<string>();
  for (const value of parseJsonLines(output)) {
    ids.add(requiredString(record(value).ID, 'image ID'));
  }
  return ids.size;
}

export async function getInventory(run: DockerRunner = runDocker, signal?: AbortSignal): Promise<InventorySnapshot> {
  const containers = await loadContainers(run, signal);
  // Read-only resource summaries; no inspect, mountpoint, labels, or secret fields forwarded.
  const images = countImages(await run(['image', 'ls', '--no-trunc', '--format', 'json'], signal));
  const networks = parseJsonLines(await run(['network', 'ls', '--format', 'json'], signal)).length;
  const volumes = parseJsonLines(await run(['volume', 'ls', '--format', 'json'], signal)).length;
  containers.sort((a, b) => {
    if (!a.project && b.project) return 1;
    if (a.project && !b.project) return -1;
    return (a.project ?? '').localeCompare(b.project ?? '') || a.name.localeCompare(b.name);
  });
  const running = containers.filter((item) => item.state === 'running').length;
  return {
    containers,
    counts: {
      containers: containers.length,
      running,
      stopped: containers.length - running,
      images,
      networks,
      volumes,
    },
    capturedAt: new Date().toISOString(),
  };
}

/** Phase 4 only inspects IDs from the last validated global inventory. */
export function isFullContainerId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

export interface ContainerStats {
  cpuPercent: string;
  memoryUsage: string;
  memoryPercent: string;
  capturedAt: string;
}

function statField(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 100) {
    throw new Error('Docker returned an invalid ' + field + ' statistic.');
  }
  return value;
}

/** Single sample, only for a selected running container. No historical metrics. */
export async function getContainerStats(
  id: string,
  run: DockerRunner = runDocker,
  signal?: AbortSignal,
): Promise<ContainerStats> {
  if (!isFullContainerId(id)) throw new Error('Invalid container ID.');
  const rows = parseJsonLines(await run(['container', 'stats', '--no-stream', '--format', 'json', id], signal));
  if (rows.length !== 1) throw new Error('No statistics returned (the container may have stopped).');
  const stats = record(rows[0]);
  return {
    cpuPercent: statField(stats.CPUPerc, 'CPU'),
    memoryUsage: statField(stats.MemUsage, 'memory usage'),
    memoryPercent: statField(stats.MemPerc, 'memory percent'),
    capturedAt: new Date().toISOString(),
  };
}

export interface ContainerLogs {
  text: string;
  truncated: boolean;
}

const MAX_LOG_BYTES = 256 * 1024;
const LOG_TIMEOUT_MS = 8_000;

/**
 * No follow or stdin. Docker may write logs to stdout and stderr; capture both with a
 * combined cap and kill on overflow. Their cross-stream ordering is not guaranteed.
 * Never fetch or persist logs without an explicit request from the Webview.
 */
export function getContainerLogs(id: string, signal?: AbortSignal): Promise<ContainerLogs> {
  if (!isFullContainerId(id)) return Promise.reject(new Error('Invalid container ID.'));
  return new Promise((resolve, reject) => {
    const { DOCKER_HOST: _host, DOCKER_CONTEXT: _context, ...environment } = process.env;
    const child = spawn('docker', [
      '--host', DOCKER_HOST, 'container', 'logs', '--tail', '200', '--timestamps', id,
    ], {
      shell: false,
      cwd: '/',
      env: environment,
      signal,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    let size = 0;
    let errorSize = 0;
    let truncated = false;
    let failure: Error | undefined;
    const timer = setTimeout(() => {
      failure ??= new Error('Docker log request timed out.');
      child.kill('SIGKILL');
    }, LOG_TIMEOUT_MS);
    const capture = (part: Buffer, stderr: boolean): void => {
      if (stderr && errorSize < MAX_STDERR_BYTES) {
        errors.push(part.subarray(0, MAX_STDERR_BYTES - errorSize));
        errorSize += part.length;
      }
      const remaining = MAX_LOG_BYTES - size;
      if (remaining > 0) chunks.push(part.subarray(0, remaining));
      size += part.length;
      if (size > MAX_LOG_BYTES && !truncated) {
        truncated = true;
        child.kill('SIGKILL');
      }
    };
    child.stdout.on('data', (part: Buffer) => capture(part, false));
    child.stderr.on('data', (part: Buffer) => capture(part, true));
    child.on('error', (error: Error) => { failure ??= error; });
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      if (failure) return reject(failure);
      if (exitCode !== 0 && !truncated) {
        const detail = Buffer.concat(errors).toString('utf8').trim();
        return reject(new Error(detail || 'Docker logs exited with code ' + String(exitCode) + '.'));
      }
      // Plain-text rendering is still mandatory; strip terminal control sequences as defense in depth.
      const text = Buffer.concat(chunks).toString('utf8')
        .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
      return resolve({ text, truncated });
    });
  });
}
