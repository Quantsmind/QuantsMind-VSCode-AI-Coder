/**
 * Pure decision core for the MCP management UI's launch gate. Workspace trust
 * must be present before anything is offered; a user denial must stop the
 * launch. Kept free of `vscode` so the security contract is unit-testable.
 *
 * Contract:
 * - Untrusted workspace  → `{ ok: false, reason: 'untrusted' }` (never prompts).
 * - Trusted + approved   → `{ ok: true }`.
 * - Trusted + denied     → `{ ok: false, reason: 'denied' }`.
 */

export type LaunchGateOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'untrusted' | 'denied' };

export interface McpLaunchGateOptions {
  readonly trusted: () => boolean;
  readonly prompt: () => Promise<boolean>;
}

export async function decideMcpLaunchApproval(
  options: McpLaunchGateOptions,
): Promise<LaunchGateOutcome> {
  let trusted: boolean;
  try {
    trusted = options.trusted() === true;
  } catch {
    // A throwing trust check is not a grant; refuse without prompting.
    return { ok: false, reason: 'untrusted' };
  }
  if (!trusted) {
    return { ok: false, reason: 'untrusted' };
  }
  let approved: boolean;
  try {
    approved = (await options.prompt()) === true;
  } catch {
    // A failed approval modal is not a grant; refuse.
    return { ok: false, reason: 'denied' };
  }
  if (!approved) {
    return { ok: false, reason: 'denied' };
  }
  return { ok: true };
}
