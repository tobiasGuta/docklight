import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
assert.equal(manifest.name, 'docklight');
assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
assert.equal(manifest.private, true);
assert.equal(manifest.main, './out/extension.js');
assert.deepEqual(manifest.extensionKind, ['ui']);
assert.deepEqual(manifest.files, ['out/**', 'media/**']);
assert.equal(manifest.dependencies, undefined, 'No runtime dependencies should be packaged.');
assert.ok(manifest.contributes.commands.some((command) => command.command === 'docklight.openDashboard'));
for (const filename of ['out/extension.js', 'out/docker.js', 'out/protocol.js', 'media/dashboard.css', 'media/dashboard.js', 'README.md']) {
  assert.ok(statSync(new URL('../' + filename, import.meta.url)).size > 0, filename + ' must exist and be nonempty');
}
const extension = readFileSync(new URL('../out/extension.js', import.meta.url), 'utf8');
assert.match(extension, /docklight\.openDashboard/);
const htmlJs = readFileSync(new URL('../media/dashboard.js', import.meta.url), 'utf8');
assert.doesNotMatch(htmlJs, /innerHTML|eval\s*\(|new Function\s*\(/);
console.log('Release assets, manifest, runtime dependency boundary, and safe text rendering: OK');
