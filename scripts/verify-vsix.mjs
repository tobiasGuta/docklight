import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const filename = process.argv[2] ?? `${manifest.name}-${manifest.version}.vsix`;
assert.ok(filename?.endsWith('.vsix'), 'Pass a VSIX file path.');
let listing;
try {
  listing = execFileSync('unzip', ['-Z1', filename], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
} catch (error) {
  throw new Error('Could not inspect the VSIX. On Fedora, install the standard unzip utility if missing.', { cause: error });
}
const actual = new Set(listing.filter((name) => !name.endsWith('/')));
const expected = [
  '[Content_Types].xml', 'extension.vsixmanifest', 'extension/package.json',
  'extension/readme.md', 'extension/out/extension.js', 'extension/out/docker.js',
  'extension/out/protocol.js', 'extension/media/dashboard.js', 'extension/media/dashboard.css',
];
for (const file of expected) assert.ok(actual.has(file), 'Missing VSIX entry: ' + file);
const packagedManifest = JSON.parse(execFileSync('unzip', ['-p', filename, 'extension/package.json'], { encoding: 'utf8' }));
assert.equal(packagedManifest.name, manifest.name);
assert.equal(packagedManifest.version, manifest.version);
assert.equal(packagedManifest.main, manifest.main);
assert.equal(packagedManifest.dependencies, undefined);
const runtime = [...actual].filter((name) => name.startsWith('extension/'));
assert.ok(runtime.every((name) => !/node_modules|\.env|\.log|\.map|test\/|src\/|scripts\/|package-lock\.json|\.git\//i.test(name)),
  'VSIX unexpectedly includes development files or sensitive paths: ' + runtime.join(', '));
console.log('VSIX entries verified (' + actual.size + ' files); runtime assets present; no development directories.');
