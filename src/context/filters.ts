import { minimatch } from 'minimatch';
import { redactSecrets } from '../security/redact';

export const CONTEXT_TRUNCATION_MARKER =
  '\n\n[QuantsMind: content truncated to fit the configured context budget]';

export interface ContextCandidate {
  readonly path: string;
  readonly content: string;
  readonly languageId?: string;
  readonly isSelection?: boolean;
  readonly startLine?: number;
  readonly endLine?: number;
}

export interface ContextItem extends ContextCandidate {
  readonly sizeBytes: number;
}

export interface RedactedContextItem extends ContextItem {
  readonly redactions: number;
}

export type ContextSkipReason =
  | 'excluded'
  | 'empty'
  | 'binary'
  | 'too_large'
  | 'duplicate'
  | 'limit_files'
  | 'limit_chars';

export interface SkippedContextItem {
  readonly path: string;
  readonly reason: ContextSkipReason;
}

export interface ContextFilterOptions {
  readonly excludeGlobs: readonly string[];
  readonly maxFileSizeBytes: number;
  readonly maxTotalChars: number;
  readonly maxFiles: number;
}

export interface ContextFilterResult {
  readonly included: ContextItem[];
  readonly skipped: SkippedContextItem[];
}

export interface BuildContextResult {
  readonly items: RedactedContextItem[];
  readonly skipped: SkippedContextItem[];
}

export function normalizeContextPath(value: string): string {
  return value
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/\/{2,}/g, '/')
    .trim();
}

export function isPathExcluded(path: string, excludeGlobs: readonly string[]): boolean {
  const normalized = normalizeContextPath(path);
  if (normalized.length === 0) {
    return false;
  }

  return excludeGlobs.some((rawPattern) => {
    const pattern = rawPattern.trim();
    if (pattern.length === 0) {
      return false;
    }
    try {
      return minimatch(normalized, pattern, {
        dot: true,
        nocase: true,
        matchBase: true,
        nonegate: true,
        nocomment: true,
      });
    } catch {
      return false;
    }
  });
}

function attachmentKey(candidate: ContextCandidate): string {
  return [
    normalizeContextPath(candidate.path),
    candidate.isSelection === true ? 'selection' : 'file',
    candidate.startLine ?? '',
    candidate.endLine ?? '',
  ].join(':');
}

export function filterContextCandidates(
  candidates: readonly ContextCandidate[],
  options: ContextFilterOptions,
): ContextFilterResult {
  const included: ContextItem[] = [];
  const skipped: SkippedContextItem[] = [];
  const seen = new Set<string>();
  let totalChars = 0;

  for (const candidate of candidates) {
    const path = normalizeContextPath(candidate.path) || 'untitled';
    const key = attachmentKey(candidate);

    if (seen.has(key)) {
      skipped.push({ path, reason: 'duplicate' });
      continue;
    }
    seen.add(key);

    if (isPathExcluded(path, options.excludeGlobs)) {
      skipped.push({ path, reason: 'excluded' });
      continue;
    }

    const content = typeof candidate.content === 'string' ? candidate.content : '';
    if (content.length === 0) {
      skipped.push({ path, reason: 'empty' });
      continue;
    }
    if (content.includes('\u0000')) {
      skipped.push({ path, reason: 'binary' });
      continue;
    }

    const sizeBytes = Buffer.byteLength(content, 'utf8');
    if (sizeBytes > options.maxFileSizeBytes) {
      skipped.push({ path, reason: 'too_large' });
      continue;
    }

    if (included.length >= options.maxFiles) {
      skipped.push({ path, reason: 'limit_files' });
      continue;
    }

    let finalContent = content;
    const remaining = options.maxTotalChars - totalChars;
    if (finalContent.length > remaining) {
      if (remaining < 500) {
        skipped.push({ path, reason: 'limit_chars' });
        continue;
      }
      finalContent =
        finalContent.slice(0, remaining - CONTEXT_TRUNCATION_MARKER.length) +
        CONTEXT_TRUNCATION_MARKER;
    }

    included.push({ ...candidate, path, content: finalContent, sizeBytes });
    totalChars += finalContent.length;
  }

  return { included, skipped };
}

/**
 * Applies path exclusions, size and budget limits, and redacts detected
 * secrets before any content can reach a provider. The secret is passed here
 * so an exact API-key match is always removed, even if it has no recognizable
 * prefix.
 */
export function buildContext(
  candidates: readonly ContextCandidate[],
  options: ContextFilterOptions,
  secret?: string,
): BuildContextResult {
  const filtered = filterContextCandidates(candidates, options);
  const items = filtered.included.map((item) => {
    const redacted = redactSecrets(item.content, [secret]);
    return { ...item, content: redacted.text, redactions: redacted.count };
  });
  return { items, skipped: filtered.skipped };
}
