import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// GHSA-g3hv-75wg-m249 affects every minimatch release below 11.0.1. The
// extension ships minimatch as its only runtime dependency, so this check is
// deliberately offline and lockfile-based rather than relying on npm audit.
const FLOOR = [11, 0, 1];
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function readJson(name) {
  return JSON.parse(readFileSync(resolve(root, name), 'utf8'));
}

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value);
  return match === null ? undefined : match.slice(1).map(Number);
}

function atLeastFloor(value) {
  const version = parseVersion(value);
  if (version === undefined) {
    return false;
  }
  for (let index = 0; index < FLOOR.length; index += 1) {
    if (version[index] !== FLOOR[index]) {
      return version[index] > FLOOR[index];
    }
  }
  return true;
}

function isMinimatchPath(path) {
  return path === 'node_modules/minimatch' || path.endsWith('/node_modules/minimatch');
}

const manifest = readJson('package.json');
const lock = readJson('package-lock.json');
const entries = Object.entries(lock.packages ?? {})
  .filter(([path]) => isMinimatchPath(path))
  .map(([path, entry]) => ({ path, version: entry.version, dev: entry.dev === true }));

const failures = [];
const runtimeEntries = entries.filter((entry) => !entry.dev);
const devEntries = entries.filter((entry) => entry.dev);
const rootEntry = entries.find((entry) => entry.path === 'node_modules/minimatch');

if (rootEntry === undefined) {
  failures.push('package-lock.json has no root minimatch entry');
} else if (rootEntry.dev) {
  failures.push('the root minimatch entry is marked development-only');
}

for (const entry of runtimeEntries) {
  if (!atLeastFloor(entry.version)) {
    failures.push(`runtime minimatch at ${entry.path} (${entry.version}) is below 11.0.1`);
  }
}

const declared = manifest.dependencies?.minimatch;
if (typeof declared !== 'string' || parseVersion(declared) === undefined) {
  failures.push('package.json must pin minimatch to an exact verified version');
} else if (rootEntry !== undefined && declared !== rootEntry.version) {
  failures.push(`package.json pins minimatch ${declared} but the lockfile installs ${rootEntry.version}`);
} else if (!atLeastFloor(declared)) {
  failures.push(`package.json pins minimatch ${declared}, which is below 11.0.1`);
}

console.log('Runtime minimatch');
if (rootEntry === undefined) {
  console.log('  fail node_modules/minimatch is missing');
} else {
  const status = atLeastFloor(rootEntry.version) && !rootEntry.dev ? 'ok  ' : 'fail';
  console.log(`  ${status} node_modules/minimatch ${rootEntry.version}${rootEntry.dev ? ' (dev)' : ''}`);
}
const declaredPinned =
  typeof declared === 'string' &&
  rootEntry !== undefined &&
  declared === rootEntry.version &&
  atLeastFloor(declared);
console.log(`  ${declaredPinned ? 'ok  ' : 'fail'} package.json pins ${declared ?? 'nothing'}`);

console.log('\nDevelopment minimatch');
if (devEntries.length === 0) {
  console.log('  ok  no development minimatch entries');
} else {
  const versions = new Map();
  for (const entry of devEntries) {
    versions.set(entry.version, (versions.get(entry.version) ?? 0) + 1);
  }
  const summary = [...versions.entries()]
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([version, count]) => `${version} x${count}`)
    .join(', ');
  console.log(`  info ${devEntries.length} development-only entries: ${summary}`);
  const affected = devEntries.filter((entry) => !atLeastFloor(entry.version));
  console.log(
    `  ok  ${affected.length} development-only entries fall below 11.0.1 and are documented as non-shipped`,
  );
}

if (failures.length > 0) {
  console.error('\nDependency check failed:');
  for (const failure of failures) {
    console.error(`  fail ${failure}`);
  }
  process.exit(1);
}

console.log('\nOK: the shipped runtime contains only patched minimatch releases.');
