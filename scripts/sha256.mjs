/**
 * Checksum helper for release artifacts: node scripts/sha256.mjs <file> [...files]
 */
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('Usage: node scripts/sha256.mjs <file> [...more]');
  process.exit(1);
}

for (const file of files) {
  const data = readFileSync(file);
  console.log(`${file}  ${(statSync(file).size / 1024).toFixed(1)} KiB`);
  console.log(`  sha256 ${createHash('sha256').update(data).digest('hex')}`);
}
