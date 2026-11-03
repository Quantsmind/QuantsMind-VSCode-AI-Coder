import { minimatch } from 'minimatch';

export interface IgnoreRule {
  readonly pattern: string;
  readonly negated: boolean;
  readonly directoryOnly: boolean;
  readonly anchored: boolean;
}

const MATCH_OPTIONS = {
  dot: true,
  nocase: false,
  nonegate: true,
  nocomment: true,
} as const;

/**
 * Parses root-level gitignore syntax. Nested .gitignore files are not merged;
 * the workspace root file and .git/info/exclude are supported.
 */
export function parseIgnoreFile(text: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.replace(/\s+$/, '');
    if (line.length === 0 || line.startsWith('#')) {
      continue;
    }

    let negated = false;
    if (line.startsWith('!')) {
      negated = true;
      line = line.slice(1);
    }
    if (line.startsWith('\\#')) {
      line = line.slice(1);
    }
    if (line.length === 0) {
      continue;
    }

    let directoryOnly = false;
    if (line.endsWith('/')) {
      directoryOnly = true;
      line = line.replace(/\/+$/, '');
    }
    if (line.length === 0) {
      continue;
    }

    const anchored = line.startsWith('/') || line.replace(/\/+$/, '').includes('/');
    if (line.startsWith('/')) {
      line = line.replace(/^\/+/, '');
    }
    if (line.length === 0 || line.length > 300) {
      continue;
    }

    rules.push({ pattern: line, negated, directoryOnly, anchored });
  }

  return rules;
}

export function mergeIgnoreFiles(texts: readonly (string | undefined | null)[]): IgnoreRule[] {
  return texts
    .filter((text): text is string => typeof text === 'string' && text.length > 0)
    .flatMap((text) => parseIgnoreFile(text));
}

function ruleMatches(rule: IgnoreRule, path: string, isDirectory: boolean): boolean {
  const options = { ...MATCH_OPTIONS, matchBase: !rule.anchored };

  if (!rule.directoryOnly) {
    return minimatch(path, rule.pattern, options);
  }

  if (isDirectory && minimatch(path, rule.pattern, options)) {
    return true;
  }

  const segments = path.split('/');
  for (let index = 1; index < segments.length; index += 1) {
    const ancestor = segments.slice(0, index).join('/');
    if (minimatch(ancestor, rule.pattern, options)) {
      return true;
    }
  }
  return false;
}

/**
 * Returns true when the path is ignored. Evaluation is ordered so the last
 * matching rule wins, which mirrors gitignore negation semantics.
 */
export function isIgnored(
  path: string,
  isDirectory: boolean,
  rules: readonly IgnoreRule[],
): boolean {
  const normalized = path.replace(/\\/g, '/').replace(/^\.?\/+/, '');
  if (normalized.length === 0) {
    return false;
  }

  let ignored = false;
  for (const rule of rules) {
    if (ruleMatches(rule, normalized, isDirectory)) {
      ignored = !rule.negated;
    }
  }
  return ignored;
}

export function createIgnoreMatcher(
  texts: readonly (string | undefined | null)[],
): (path: string, isDirectory: boolean) => boolean {
  const rules = mergeIgnoreFiles(texts);
  return (path, isDirectory) => isIgnored(path, isDirectory, rules);
}
