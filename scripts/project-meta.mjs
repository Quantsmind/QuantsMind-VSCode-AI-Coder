/**
 * Single source of truth for the values that used to be duplicated as literal
 * `0.3.4` strings across the verification scripts. Reading package.json keeps a
 * version bump from silently breaking the release chain.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const manifest = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'));

export const extensionName = manifest.name;
export const publisher = manifest.publisher;
export const version = manifest.version;
export const extensionId = `${publisher}.${manifest.name}`;
export const vsixFileName = `${extensionName}-${version}.vsix`;
export const vsixPath = join(projectRoot, vsixFileName);
