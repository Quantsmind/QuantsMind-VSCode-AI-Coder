import { rm } from 'node:fs/promises';

const targets = ['out', 'dist', 'coverage', '.tmp', '.vscode-test'];

for (const target of targets) {
  await rm(target, { recursive: true, force: true });
}

console.log(`Removed: ${targets.join(', ')}`);
