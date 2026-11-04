/**
 * Version bump for releases. Updates package.json and package-lock.json in one
 * step and prints the follow-up commands. It deliberately does not commit, tag,
 * push or publish: those stay explicit, separately authorised actions.
 *
 *   node scripts/release.mjs --bump patch|minor|major [--dry-run]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectRoot, version as currentVersion, vsixFileName } from './project-meta.mjs';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const bumpIndex = args.indexOf('--bump');
const bump = bumpIndex === -1 ? undefined : args[bumpIndex + 1];

if (!['patch', 'minor', 'major'].includes(String(bump))) {
  console.error('Usage: node scripts/release.mjs --bump patch|minor|major [--dry-run]');
  process.exit(1);
}

function assertCleanTree() {
  const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: projectRoot })
    .toString()
    .trim();
  if (dirty !== '') {
    console.error('Working tree must be committed before a release bump. Uncommitted:');
    console.error(dirty);
    process.exit(1);
  }
}

assertCleanTree();

const [major, minor, patch] = currentVersion.split('.').map(Number);
const nextVersion =
  bump === 'major'
    ? `${major + 1}.0.0`
    : bump === 'minor'
      ? `${major}.${minor + 1}.0`
      : `${major}.${minor}.${patch + 1}`;

console.log(`${currentVersion} -> ${nextVersion}${dryRun ? ' (dry run)' : ''}`);

const packageJsonPath = join(projectRoot, 'package.json');
const packageLockPath = join(projectRoot, 'package-lock.json');

const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
packageJson.version = nextVersion;

const packageLock = JSON.parse(readFileSync(packageLockPath, 'utf8'));
packageLock.version = nextVersion;
if (packageLock.packages?.[''] !== undefined) {
  packageLock.packages[''].version = nextVersion;
}

if (!dryRun) {
  writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');
  writeFileSync(packageLockPath, `${JSON.stringify(packageLock, null, 2)}\n`, 'utf8');
}

console.log(`
Next steps (each is a separate, explicit action):
  1. npm run verify                 # full chain: lint, tests, package, VSIX checks, install check
  2. git add package.json package-lock.json CHANGELOG.md
     git commit -m "chore(release): ${nextVersion}"
  3. git tag v${nextVersion}
  4. node scripts/sha256.mjs ${vsixFileName}
`);
