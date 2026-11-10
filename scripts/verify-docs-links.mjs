#!/usr/bin/env node
/**
 * Repository documentation link verification.
 *
 * Validates Markdown-internal links, relative images and heading anchors
 * across the repository. External links are inventoried but never fetched.
 * Exits 1 when any broken link, undefined reference, missing anchor or stale
 * repository URL is found.
 *
 * Usage: node scripts/verify-docs-links.mjs [path-to-repo-root]
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = process.argv[2] ? process.argv[2] : join(here, '..');
const { checkDocsLinks } = await import('./lib/docs-links.mjs');

const result = checkDocsLinks(root);
const issueCount = result.broken.length + result.staleRepoUrls.length;

console.log(`Markdown files scanned: ${result.files}`);
console.log(`Links checked (internal + same-file anchors): ${result.checked}`);
console.log(`External links (not fetched): ${result.external}`);

if (result.broken.length > 0) {
  console.error(`\nBroken links (${result.broken.length}):`);
  for (const issue of result.broken) {
    console.error(`  ${issue.file}:${issue.line}: ${issue.target} — ${issue.reason}`);
  }
}

if (result.staleRepoUrls.length > 0) {
  console.error(`\nStale repository URLs (${result.staleRepoUrls.length}):`);
  for (const issue of result.staleRepoUrls) {
    console.error(`  ${issue.file}:${issue.line}: ${issue.target} — ${issue.reason}`);
  }
}

if (issueCount > 0) {
  console.error(`\nFAIL: ${issueCount} documentation link issue(s) found.`);
  process.exit(1);
}

console.log('\nAll Markdown links resolve.');
