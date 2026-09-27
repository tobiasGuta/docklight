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
