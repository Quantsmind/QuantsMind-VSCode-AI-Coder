import { readFileSync, statSync } from 'node:fs';
import { unzipSync } from 'fflate';

const vsixPath = process.argv[2] ?? 'quantsmind-vscode-ai-coder-0.3.2.vsix';
const failures = [];

function ok(message) {
  console.log(`  ok  ${message}`);
}

function fail(message) {
  failures.push(message);
  console.log(`  FAIL ${message}`);
}

function assert(condition, message) {
  if (condition) {
    ok(message);
  } else {
    fail(message);
  }
}

function textOf(files, name) {
  const entry = files[name];
  return entry === undefined ? undefined : Buffer.from(entry).toString('utf8');
}

let archive;
try {
  archive = unzipSync(new Uint8Array(readFileSync(vsixPath)));
} catch (error) {
  console.error(`Cannot read VSIX ${vsixPath}: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}

const names = Object.keys(archive);
console.log(`VSIX: ${vsixPath}`);
console.log(`Size: ${(statSync(vsixPath).size / 1024).toFixed(1)} KiB across ${names.length} entries\n`);

const required = [
  'extension/package.json',
  'extension/readme.md',
  'extension/LICENSE.txt',
  'extension/changelog.md',
  'extension/out/src/extension.js',
  'extension/media/chat.js',
  'extension/media/chat.css',
  'extension/media/icon.svg',
  'extension/node_modules/minimatch/package.json',
];

console.log('Required entries');
for (const name of required) {
  assert(names.includes(name), name);
}

console.log('\nForbidden entries');
const forbiddenPrefixes = [
  'extension/src/',
  'extension/test/',
  'extension/out/test/',
  'extension/docs/',
  'extension/scripts/',
  'extension/.github/',
  'extension/.vscode/',
  'extension/.vscode-test',
  'extension/.tmp',
];
const forbiddenSuffixes = ['.map', '.ts', '.tsx', '.vsix', '.log'];
const forbiddenNames = ['.env', '.npmrc', '.netrc', '.pypirc'];

for (const prefix of forbiddenPrefixes) {
  assert(!names.some((name) => name.startsWith(prefix)), `no ${prefix}`);
}
for (const suffix of forbiddenSuffixes) {
  assert(!names.some((name) => name.endsWith(suffix)), `no *${suffix} files`);
}
for (const name of forbiddenNames) {
  assert(!names.some((entry) => entry.split('/').pop() === name), `no ${name}`);
}
for (const devPackage of ['typescript', 'eslint', 'mocha', 'chai', 'sinon', '@vscode']) {
  assert(
    !names.some((name) => name.startsWith(`extension/node_modules/${devPackage}/`)),
    `no dev dependency ${devPackage}`,
  );
}

console.log('\nManifest');
let manifest;
try {
  manifest = JSON.parse(textOf(archive, 'extension/package.json') ?? '{}');
} catch (error) {
  fail(`package.json is not valid JSON: ${error instanceof Error ? error.message : error}`);
  manifest = {};
}

assert(manifest.name === 'quantsmind-vscode-ai-coder', 'name is quantsmind-vscode-ai-coder');
assert(manifest.publisher === 'quantsmind', 'publisher is quantsmind');
assert(manifest.version === '0.3.2', 'version is 0.3.2');
assert(typeof manifest.engines?.vscode === 'string', 'declares an engines.vscode range');
assert(manifest.main === './out/src/extension.js', 'main points at the compiled entry point');
assert(manifest.preview === true, 'is marked as preview, not GA');
assert(manifest.license === 'MIT', 'license is MIT');

assert(names.includes(`extension/${manifest.main.replace(/^\.\//, '')}`), 'main file exists in archive');

const commands = manifest.contributes?.commands;
assert(Array.isArray(commands) && commands.length === 17, 'contributes 17 commands');
assert(
  manifest.contributes?.views?.quantsmind?.[0]?.id === 'quantsmind.chatView',
  'contributes the chat webview',
);
assert(
  manifest.contributes?.configuration?.properties?.['quantsmind.provider.baseUrl']?.scope ===
    'application',
  'provider settings remain application-scoped',
);

const dependencies = Object.keys(manifest.dependencies ?? {});
assert(
  dependencies.length === 1 && dependencies[0] === 'minimatch',
  'ships only minimatch as a runtime dependency',
);

const packagedMinimatchNames = names.filter((name) =>
  /^extension\/node_modules\/(?:.+\/)?minimatch\/package\.json$/.test(name),
);
let packagedMinimatchOk = packagedMinimatchNames.length === 1;
for (const name of packagedMinimatchNames) {
  try {
    const version = JSON.parse(textOf(archive, name)).version;
    const parts = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version));
    const patched =
      parts !== null &&
      (Number(parts[1]) > 11 ||
        (Number(parts[1]) === 11 && Number(parts[2]) > 0) ||
        (Number(parts[1]) === 11 && Number(parts[2]) === 0 && Number(parts[3]) >= 1));
    if (patched) {
      ok(`packaged minimatch ${version} is at or above 11.0.1`);
    } else {
      fail(`packaged minimatch ${version} is below the patched 11.0.1 release`);
      packagedMinimatchOk = false;
    }
  } catch (error) {
    fail(`cannot read ${name}: ${error instanceof Error ? error.message : error}`);
    packagedMinimatchOk = false;
  }
}
if (!packagedMinimatchOk) {
  fail('expected exactly one patched minimatch runtime package');
}
assert(
  !Object.keys(manifest.contributes?.configuration?.properties ?? {}).some((key) =>
    /api.?key|password|client.?secret/i.test(key),
  ),
  'defines no credential setting',
);

console.log('\nSecret scan');
const scannedSuffixes = ['.json', '.js', '.md', '.css', '.svg', '.xml'];
let secretFinding = false;
for (const [name, data] of Object.entries(archive)) {
  if (name.endsWith('package-lock.json')) {
    continue;
  }
  if (!scannedSuffixes.some((suffix) => name.endsWith(suffix))) {
    continue;
  }
  const text = Buffer.from(data).toString('utf8');
  if (text.includes('sk-demo-not-a-real-key') || text.includes('this-is-a-fixture-not-a-real-secret')) {
    fail(`fixture secret found in ${name}`);
    secretFinding = true;
  }
  if (text.includes('BEGIN RSA PRIVATE KEY') || text.includes('BEGIN OPENSSH PRIVATE KEY')) {
    fail(`private key material found in ${name}`);
    secretFinding = true;
  }
}
if (!secretFinding) {
  ok('no fixture credentials or private keys in packaged text files');
}

const identity = textOf(archive, 'extension.vsixmanifest');
if (identity === undefined) {
  fail('extension.vsixmanifest is present');
} else {
  ok('extension.vsixmanifest is present');
  assert(/<Identity[^>]*Publisher="quantsmind"/.test(identity), 'vsix identity publisher is quantsmind');
  assert(/<Identity[^>]*Version="0\.3\.2"/.test(identity), 'vsix identity version is 0.3.2');
}

if (failures.length > 0) {
  console.error(`\n${failures.length} VSIX check(s) failed.`);
  process.exit(1);
}

console.log('\nAll VSIX checks passed.');
