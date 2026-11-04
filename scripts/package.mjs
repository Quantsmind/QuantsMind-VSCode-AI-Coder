/**
 * Wraps `vsce package` so the artefact name comes from package.json instead of a
 * version string duplicated in the npm script.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { projectRoot, vsixFileName } from './project-meta.mjs';

const vsceEntry = join(projectRoot, 'node_modules', '@vscode', 'vsce', 'vsce');

const result = spawnSync(
  process.execPath,
  [vsceEntry, 'package', '--out', vsixFileName],
  { cwd: projectRoot, stdio: 'inherit' },
);

if (result.error !== undefined) {
  console.error(`Failed to run vsce: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
