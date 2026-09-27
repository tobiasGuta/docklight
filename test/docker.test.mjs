import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { getInventory, parseContainer, parseJsonLines, INSPECT_TEMPLATE, runDocker } = require('../out/docker.js');
const first = 'a'.repeat(64);
const second = 'b'.repeat(64);

function fixture(id, options = {}) {
  return {
    id, name: `/${options.name ?? 'db'}`, image: options.image ?? 'postgres:17',
    state: options.state ?? 'running', startedAt: '2026-09-26T21:00:00.123456789Z',
    health: options.health ?? '', project: options.project ?? '', service: options.service ?? '',
    ports: options.ports ?? { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '5432' }], '80/tcp': null },
  };
}

function mockRunner({ list = [first, second], rows = [fixture(first, { name: 'db', project: 'app', service: 'db', health: 'healthy' }), fixture(second, { name: 'solo', state: 'exited', ports: {} })], inspectFailures = 0 } = {}) {
  const calls = [];
  const runner = async (args) => {
    calls.push([...args]);
    if (args[0] === 'container' && args[1] === 'ls') return list.map((id) => JSON.stringify(id)).join('\n') + '\n';
    if (args[0] === 'container' && args[1] === 'inspect') {
      if (inspectFailures-- > 0) throw new Error('No such container');
      return rows.filter((row) => args.includes(row.id)).map((row) => JSON.stringify(row)).join('\n') + '\n';
    }
    if (args[0] === 'image') return '{"ID":"sha256:1"}\n{"ID":"sha256:1"}\n{"ID":"sha256:2"}\n';
    if (args[0] === 'network') return '{"Name":"bridge"}\n{"Name":"host"}\n';
    if (args[0] === 'volume') return '{"Name":"vol"}\n';
    throw new Error('Unexpected Docker command: ' + args.join(' '));
  };
  return { runner, calls };
}

test('parses JSON Lines without interpreting CLI tables or arbitrary label strings', () => {
  assert.deepEqual(parseJsonLines('\n{"a":1}\r\n{"b":2}\n'), [{ a: 1 }, { b: 2 }]);
  assert.deepEqual(parseJsonLines('\n'), []);
  assert.throws(() => parseJsonLines('{not JSON}'), /invalid JSON Lines/);
  assert.throws(() => parseContainer({ id: 'bad' }), /full container ID/);
});

test('projects health, exact Compose labels, true published ports, and safe timestamps', () => {
  const parsed = parseContainer(fixture(first, { project: 'my-project', service: 'db', health: 'healthy' }));
  assert.equal(parsed.name, 'db');
  assert.equal(parsed.project, 'my-project');
  assert.equal(parsed.service, 'db');
  assert.equal(parsed.health, 'healthy');
  assert.equal(parsed.startedAt, '2026-09-26T21:00:00.123456789Z');
  assert.deepEqual(parsed.publishedPorts, [{ containerPort: '5432/tcp', hostIp: '127.0.0.1', hostPort: '5432' }]);
  const stopped = parseContainer(fixture(second, { state: 'exited', health: '', project: '', ports: {} }));
  assert.equal(stopped.startedAt, null);
  assert.equal(stopped.health, null);
  assert.equal(stopped.project, null);
  assert.deepEqual(stopped.publishedPorts, []);
  assert.doesNotMatch(INSPECT_TEMPLATE, /Config\.Env|Mountpoint|HostConfig/);
  // Docker 29 can omit State.Health entirely when no HEALTHCHECK is configured.
  // Dotted lookup fails even inside an if expression in Docker's template mode.
  assert.match(INSPECT_TEMPLATE, /\{\{with index \.State "Health"\}\}/);
  assert.doesNotMatch(INSPECT_TEMPLATE, /\.State\.Health/);
  assert.match(INSPECT_TEMPLATE, /com\.docker\.compose\.project/);
  assert.match(INSPECT_TEMPLATE, /com\.docker\.compose\.service/);
});

test('loads global inventory, counts unique image IDs, never issues write commands', async () => {
  const { runner, calls } = mockRunner();
  const result = await getInventory(runner);
  assert.equal(result.counts.containers, 2);
  assert.equal(result.counts.running, 1);
  assert.equal(result.counts.stopped, 1);
  assert.equal(result.counts.images, 2);
  assert.equal(result.counts.networks, 2);
  assert.equal(result.counts.volumes, 1);
  assert.equal(result.containers[0].project, 'app');
  assert.equal(result.containers[1].name, 'solo');
  assert.equal(calls.length, 5);
  assert.deepEqual(calls.map((a) => a.slice(0, 2)), [
    ['container', 'ls'], ['container', 'inspect'], ['image', 'ls'],
    ['network', 'ls'], ['volume', 'ls'],
  ]);
  assert.ok(calls.every((a) => !a.includes('rm') && !a.includes('start') && !a.includes('prune')));
});

test('skips inspect entirely on a daemon with no containers', async () => {
  const { runner, calls } = mockRunner({ list: [] });
  const result = await getInventory(runner);
  assert.equal(result.counts.containers, 0);
  assert.ok(calls.every((a) => a[1] !== 'inspect'));
});

test('batches container inspection in bounded groups', async () => {
  const ids = Array.from({ length: 51 }, (_, i) => i.toString(16).padStart(64, '0'));
  const { runner, calls } = mockRunner({ list: ids, rows: ids.map((id, i) => fixture(id, { name: `container-${i}` })) });
  const result = await getInventory(runner);
  assert.equal(result.counts.containers, 51);
  assert.deepEqual(calls.filter((args) => args[1] === 'inspect').map((args) => args.length - 4), [50, 1]);
});

test('retries once if inventory changes during inspection', async () => {
  const { runner, calls } = mockRunner({ inspectFailures: 1 });
  const result = await getInventory(runner);
  assert.equal(result.counts.containers, 2);
  assert.equal(calls.filter((a) => a[1] === 'inspect').length, 2);
  assert.equal(calls.filter((a) => a[1] === 'ls' && a[0] === 'container').length, 2);
});

test('reports failure rather than displaying misleading zero resource counts', async () => {
  const { runner } = mockRunner();
  const failingRunner = async (args) => args[0] === 'network' ? Promise.reject(new Error('daemon error')) : runner(args);
  await assert.rejects(getInventory(failingRunner), /daemon error/);
});

test('Docker executable receives fixed UNIX socket and argument vector, not shell interpolation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'docklight-docker-test-'));
  const executable = join(directory, 'docker');
  writeFileSync(executable, '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({args:process.argv.slice(2), host:process.env.DOCKER_HOST, context:process.env.DOCKER_CONTEXT}));\n');
  chmodSync(executable, 0o700);
  const originalPath = process.env.PATH;
  const originalHost = process.env.DOCKER_HOST;
  const originalContext = process.env.DOCKER_CONTEXT;
  try {
    process.env.PATH = `${directory}:${originalPath}`;
    process.env.DOCKER_HOST = 'tcp://external-host:2375';
    process.env.DOCKER_CONTEXT = 'remote';
    const result = JSON.parse(await runDocker(['container', 'ls', '--format', '{{json .ID}}']));
    assert.deepEqual(result.args, ['--host', 'unix:///var/run/docker.sock', 'container', 'ls', '--format', '{{json .ID}}']);
    assert.equal(result.host, undefined);
    assert.equal(result.context, undefined);
  } finally {
    process.env.PATH = originalPath;
    if (originalHost === undefined) delete process.env.DOCKER_HOST; else process.env.DOCKER_HOST = originalHost;
    if (originalContext === undefined) delete process.env.DOCKER_CONTEXT; else process.env.DOCKER_CONTEXT = originalContext;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('selected stats uses JSON and a validated full ID, with no streaming', async () => {
  const { getContainerStats } = require('../out/docker.js');
  const calls = [];
  const result = await getContainerStats(first, async (args) => {
    calls.push(args);
    return JSON.stringify({ CPUPerc: '0.42%', MemUsage: '16.4MiB / 1GiB', MemPerc: '1.60%' }) + '\n';
  });
  assert.deepEqual(calls[0], ['container', 'stats', '--no-stream', '--format', 'json', first]);
  assert.equal(result.cpuPercent, '0.42%');
  assert.equal(result.memoryUsage, '16.4MiB / 1GiB');
  assert.equal(result.memoryPercent, '1.60%');
  await assert.rejects(getContainerStats('--all', async () => { throw new Error('should not execute'); }), /Invalid container ID/);
  await assert.rejects(getContainerStats(first, async () => ''), /No statistics returned/);
  await assert.rejects(getContainerStats(first, async () => '{"CPUPerc": 1}\n'), /invalid CPU/);
});

test('logs use fixed local socket, tail bound, no follow, and no environment overrides', async () => {
  const { getContainerLogs } = require('../out/docker.js');
  const directory = mkdtempSync(join(tmpdir(), 'docklight-log-test-'));
  const executable = join(directory, 'docker');
  writeFileSync(executable, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({args:process.argv.slice(2), host:process.env.DOCKER_HOST, context:process.env.DOCKER_CONTEXT}));
`);
  chmodSync(executable, 0o700);
  const oldPath = process.env.PATH;
  const oldHost = process.env.DOCKER_HOST;
  const oldContext = process.env.DOCKER_CONTEXT;
  try {
    process.env.PATH = `${directory}:${oldPath}`;
    process.env.DOCKER_HOST = 'tcp://remote-host';
    process.env.DOCKER_CONTEXT = 'remote';
    const result = JSON.parse((await getContainerLogs(first)).text);
    assert.deepEqual(result.args, ['--host', 'unix:///var/run/docker.sock', 'container', 'logs', '--tail', '200', '--timestamps', first]);
    assert.equal(result.host, undefined);
    assert.equal(result.context, undefined);
    await assert.rejects(getContainerLogs('--follow'), /Invalid container ID/);
  } finally {
    process.env.PATH = oldPath;
    if (oldHost === undefined) delete process.env.DOCKER_HOST; else process.env.DOCKER_HOST = oldHost;
    if (oldContext === undefined) delete process.env.DOCKER_CONTEXT; else process.env.DOCKER_CONTEXT = oldContext;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('logs are capped at 256 KiB and strip terminal escapes', async () => {
  const { getContainerLogs } = require('../out/docker.js');
  const directory = mkdtempSync(join(tmpdir(), 'docklight-log-cap-'));
  const executable = join(directory, 'docker');
  writeFileSync(executable, `#!/usr/bin/env node
process.stdout.write('\\x1b[31m' + 'x'.repeat(300*1024));
`);
  chmodSync(executable, 0o700);
  const oldPath = process.env.PATH;
  try {
    process.env.PATH = `${directory}:${oldPath}`;
    const result = await getContainerLogs(first);
    assert.equal(result.truncated, true);
    assert.ok(Buffer.byteLength(result.text) <= 256 * 1024);
    assert.doesNotMatch(result.text, /\x1b/);
  } finally {
    process.env.PATH = oldPath;
    rmSync(directory, { recursive: true, force: true });
  }
});
