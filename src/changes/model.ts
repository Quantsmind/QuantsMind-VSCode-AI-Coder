import { createHash } from 'node:crypto';

export const CHANGE_KINDS = ['create', 'modify', 'delete', 'rename'] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

export const MAX_CHANGES_PER_PLAN = 20;
export const MAX_CHANGE_CONTENT_CHARS = 1_000_000;
export const MAX_PLAN_CONTENT_CHARS = 4_000_000;
export const MAX_CHANGE_PATH_LENGTH = 500;

export interface ChangePlan {
  readonly id: string;
  readonly summary: string;
  readonly changes: readonly FileChange[];
  readonly notes?: string;
}

export interface FileChange {
  readonly id: string;
  readonly kind: ChangeKind;
  readonly path: string;
  readonly fromPath?: string;
  readonly content?: string;
  readonly summary: string;
  readonly expectedHash?: string;
}

export interface FileChangeInput {
  readonly kind: ChangeKind;
  readonly path: string;
  readonly fromPath?: string;
  readonly content?: string;
  readonly summary?: string;
  readonly expectedHash?: string;
}

export function isChangeKind(value: unknown): value is ChangeKind {
  return typeof value === 'string' && (CHANGE_KINDS as readonly string[]).includes(value);
}

/**
 * Normalizes a workspace-relative path and rejects traversal, absolute paths,
 * and Windows-specific escape forms. This is the single gate used before any
 * file is read or written.
 */
export function normalizeChangePath(raw: unknown): string | undefined {
  if (typeof raw !== 'string') {
    return undefined;
  }
  const value = raw.trim().replace(/\\/g, '/');
  if (value.length === 0 || value.length > MAX_CHANGE_PATH_LENGTH) {
    return undefined;
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    return undefined;
  }
  if (value.startsWith('/') || /^[A-Za-z]:\//.test(value) || value.startsWith('//')) {
    return undefined;
  }
  // Colons enable Windows drive-relative paths and alternate data streams.
  if (value.includes(':')) {
    return undefined;
  }
  const segments: string[] = [];
  for (const segment of value.split('/')) {
    if (segment.length === 0 || segment === '.') {
      continue;
    }
    if (segment === '..') {
      return undefined;
    }
    segments.push(segment);
  }
  if (segments.length === 0) {
    return undefined;
  }
  return segments.join('/');
}

export function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export function makeChangeId(index: number): string {
  return `change-${index + 1}`;
}

export interface ChangeValidation {
  readonly changes: FileChange[];
  readonly errors: string[];
}

/**
 * Validates the shape of a proposed change list. It does not touch the disk;
 * expected content hashes are attached later by the workspace service.
 */
export function validateChangeInputs(inputs: readonly FileChangeInput[]): ChangeValidation {
  const errors: string[] = [];
  const changes: FileChange[] = [];

  if (inputs.length === 0) {
    errors.push('The plan did not contain any changes.');
  }
  if (inputs.length > MAX_CHANGES_PER_PLAN) {
    errors.push(`The plan exceeds the ${MAX_CHANGES_PER_PLAN}-file limit.`);
  }

  let totalChars = 0;
  const paths = new Set<string>();

  inputs.slice(0, MAX_CHANGES_PER_PLAN).forEach((input, index) => {
    const id = makeChangeId(index);
    const path = normalizeChangePath(input.path);
    if (path === undefined) {
      errors.push(`Change ${id} has an invalid or unsafe path.`);
      return;
    }
    if (!isChangeKind(input.kind)) {
      errors.push(`Change ${id} has an unsupported kind.`);
      return;
    }
    if (paths.has(path)) {
      errors.push(`Change ${id} targets a path that appears more than once.`);
      return;
    }
    paths.add(path);

    let fromPath: string | undefined;
    if (input.kind === 'rename') {
      fromPath = normalizeChangePath(input.fromPath);
      if (fromPath === undefined) {
        errors.push(`Change ${id} renames without a safe source path.`);
        return;
      }
      if (paths.has(fromPath)) {
        errors.push(`Change ${id} renames from a path that appears elsewhere in the plan.`);
        return;
      }
      paths.add(fromPath);
    }

    let content: string | undefined;
    if (input.kind === 'create' || input.kind === 'modify') {
      if (typeof input.content !== 'string') {
        errors.push(`Change ${id} requires full file content.`);
        return;
      }
      if (input.content.length > MAX_CHANGE_CONTENT_CHARS) {
        errors.push(`Change ${id} exceeds the per-file content limit.`);
        return;
      }
      totalChars += input.content.length;
      content = input.content;
    }

    if (input.kind === 'delete' || input.kind === 'rename') {
      if (typeof input.content === 'string' && input.content.length > 0) {
        errors.push(`Change ${id} must not include content for ${input.kind}.`);
        return;
      }
    }

    changes.push({
      id,
      kind: input.kind,
      path,
      fromPath,
      content,
      summary: typeof input.summary === 'string' ? input.summary.trim().slice(0, 500) : '',
      expectedHash:
        typeof input.expectedHash === 'string' && /^[a-f0-9]{64}$/.test(input.expectedHash)
          ? input.expectedHash
          : undefined,
    });
  });

  if (totalChars > MAX_PLAN_CONTENT_CHARS) {
    errors.push('The plan exceeds the total content limit.');
  }

  return { changes, errors };
}

export function withExpectedHash(change: FileChange, expectedHash: string | undefined): FileChange {
  return { ...change, expectedHash };
}

export function describeChange(change: FileChange): string {
  switch (change.kind) {
    case 'create':
      return `Create ${change.path}`;
    case 'delete':
      return `Delete ${change.path}`;
    case 'rename':
      return `Rename ${change.fromPath ?? '?'} to ${change.path}`;
    default:
      return `Modify ${change.path}`;
  }
}
