/**
 * Workspace trust is the only authority that may let this extension act on
 * workspace code's behalf. Restricted Mode still allows the user's own prompts
 * and the files they attach, but nothing the extension discovers by itself.
 *
 * This module stays free of the `vscode` import so the decision logic can be
 * unit tested; callers that run inside the extension default `TrustCheck` to
 * `vscode.workspace.isTrusted`, which is the authoritative API.
 */

export type TrustCheck = () => boolean;

/**
 * How content entered the composer. `user` means an explicit action (an editor
 * selection, the active file, or files the user picked). `workspace` means the
 * extension selected the files itself through indexing or relevance ranking.
 */
export type AttachmentOrigin = 'user' | 'workspace';

/**
 * Missing checks fail open so services that are constructed outside the
 * extension host (tests, tooling) keep their previous behaviour; every
 * production call site supplies the authoritative check.
 */
export function isTrusted(check: TrustCheck | undefined): boolean {
  return check === undefined || check() === true;
}

export const RESTRICTED_MODE_FEATURE_NOTICE =
  'Restricted Mode is active for this workspace. QuantsMind will not scan the workspace, discover relevant files, or read files on its own. Chat still works with prompts and files you attach yourself. Trust the workspace to enable workspace summaries, relevant-file matching, the file picker, agent sessions, file changes, repairs, and validation commands.';

export const RESTRICTED_MODE_ACTION_NOTICE =
  'This action needs a trusted workspace. QuantsMind does not scan or read workspace files in Restricted Mode; chat and files you attach yourself still work.';

export const RESTRICTED_MODE_REPLAY_NOTICE =
  'Restricted Mode is active, so attachment content that QuantsMind discovered automatically is withheld from restored requests. File content you attached yourself is replayed unchanged.';
