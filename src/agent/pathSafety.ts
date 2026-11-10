import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { normalizeChangePath } from '../changes/model';

export interface ResolvedWorkspacePath {
  /** Workspace-relative normalized path, safe to echo back to a model. */
  readonly relative: string;
  /** Absolute path resolved against the workspace root. */
  readonly absolute: string;
  /** Real (symlink-resolved) workspace root. */
  readonly rootReal: string;
}

/**
 * Resolves a workspace-relative path and proves it stays inside the workspace,
 * including through symbolic links. This mirrors the containment rules used by
 * the change filesystem so every agent mutation shares one boundary policy.
 */
export async function resolveWorkspacePath(
  rootFsPath: string,
  relativePath: string,
): Promise<ResolvedWorkspacePath> {
  const normalized = normalizeChangePath(relativePath);
  if (normalized === undefined) {
    throw new Error('The path is invalid or escapes the workspace.');
  }

  let rootReal: string;
  try {
    rootReal = await fsp.realpath(rootFsPath);
  } catch {
    throw new Error('The workspace root could not be resolved.');
  }

  const targetAbs = path.resolve(rootFsPath, normalized);

  const lexical = path.relative(rootFsPath, targetAbs);
  if (lexical !== '' && (lexical.startsWith('..') || path.isAbsolute(lexical))) {
    throw new Error('Path escapes the workspace.');
  }

  // Walk up to the nearest existing ancestor and verify it is inside the root.
  let ancestor = targetAbs;
  for (;;) {
    try {
      await fsp.lstat(ancestor);
      break;
    } catch {
      const parent = path.dirname(ancestor);
      if (parent === ancestor) {
        break;
      }
      ancestor = parent;
    }
  }
  const ancestorLexical = path.relative(rootFsPath, ancestor);
  if (ancestorLexical.startsWith('..') || path.isAbsolute(ancestorLexical)) {
    ancestor = rootFsPath;
  }

  let realAncestor: string;
  try {
    realAncestor = await fsp.realpath(ancestor);
  } catch {
    throw new Error('The target path could not be resolved.');
  }
  const ancestorRelative = path.relative(rootReal, realAncestor);
  if (ancestorRelative.startsWith('..') || path.isAbsolute(ancestorRelative)) {
    throw new Error('Path escapes the workspace through a link.');
  }

  // Verify the target itself when it exists.
  try {
    const realTarget = await fsp.realpath(targetAbs);
    const targetRelative = path.relative(rootReal, realTarget);
    if (targetRelative.startsWith('..') || path.isAbsolute(targetRelative)) {
      throw new Error('Path escapes the workspace through a link.');
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('escapes the workspace')) {
      throw error;
    }
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT' && code !== undefined) {
      throw error;
    }
  }

  // Verify every existing path segment so a symlinked folder cannot carry the
  // mutation outside the workspace.
  const parts = normalized.split('/');
  let current = rootFsPath;
  for (const part of parts) {
    current = path.join(current, part);
    if (current === targetAbs) {
      break;
    }
    try {
      const stat = await fsp.lstat(current);
      if (stat.isSymbolicLink()) {
        const real = await fsp.realpath(current);
        const rel = path.relative(rootReal, real);
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
          throw new Error('Path escapes the workspace through a link.');
        }
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('escapes the workspace')) {
        throw error;
      }
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== 'ENOENT' && code !== undefined) {
        throw error;
      }
    }
  }

  return { relative: normalized, absolute: targetAbs, rootReal };
}

/** True when the resolved path is the workspace root itself. */
export function isWorkspaceRoot(resolved: ResolvedWorkspacePath): boolean {
  return resolved.relative.length === 0;
}
