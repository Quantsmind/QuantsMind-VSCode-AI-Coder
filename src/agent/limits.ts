/**
 * Hard execution limits for the agentic engine (WP5).
 *
 * Validated independently of the model: invalid, negative, non-finite or
 * excessively large configured values clamp to safe bounds; nothing here can
 * disable the engine. Defaults are conservative and documented in
 * `docs/AGENTIC_ENGINEERING.md`.
 */
export interface AgentExecutionLimits {
  /** Maximum model turns per task. */
  readonly maxIterations: number;
  /** Maximum tool dispatches per task (including refused ones). */
  readonly maxToolCalls: number;
  /** Maximum evidence-triggered re-plan injections per task. */
  readonly maxPlanRevisions: number;
  /** Maximum model requests per task (normally equals maxIterations). */
  readonly maxProviderRequests: number;
  /** Maximum wall-clock duration for the whole run. */
  readonly maxDurationMs: number;
  /** Maximum characters kept from a single tool result before truncation. */
  readonly maxToolOutputChars: number;
  /** Maximum cumulative bytes of content carried by patch-like tool arguments. */
  readonly maxPatchSizeChars: number;
  /** Maximum distinct mutating-tool targets (files) per task. */
  readonly maxChangedFiles: number;
  /** Maximum consecutive tool failures before the run stops as blocked. */
  readonly maxConsecutiveFailures: number;
}

export const AGENT_LIMIT_DEFAULTS: Readonly<AgentExecutionLimits> = Object.freeze({
  maxIterations: 10,
  maxToolCalls: 40,
  maxPlanRevisions: 2,
  maxProviderRequests: 12,
  maxDurationMs: 10 * 60_000,
  maxToolOutputChars: 100_000,
  maxPatchSizeChars: 250_000,
  maxChangedFiles: 25,
  maxConsecutiveFailures: 3,
});

export const AGENT_LIMIT_BOUNDS: Readonly<Record<keyof AgentExecutionLimits, { min: number; max: number }>> = Object.freeze({
  maxIterations: { min: 1, max: 32 },
  maxToolCalls: { min: 1, max: 200 },
  maxPlanRevisions: { min: 0, max: 5 },
  maxProviderRequests: { min: 1, max: 40 },
  maxDurationMs: { min: 60_000, max: 30 * 60_000 },
  maxToolOutputChars: { min: 1_000, max: 200_000 },
  maxPatchSizeChars: { min: 1_000, max: 2_000_000 },
  maxChangedFiles: { min: 1, max: 100 },
  maxConsecutiveFailures: { min: 1, max: 10 },
});

function clamp(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.round(value)));
}

/** Validates and clamps a limit bundle; any garbage yields defaults, never disables protection. */
export function validateAgentExecutionLimits(raw: Partial<Record<keyof AgentExecutionLimits, unknown>>): AgentExecutionLimits {
  const d = AGENT_LIMIT_DEFAULTS;
  const b = AGENT_LIMIT_BOUNDS;
  return {
    maxIterations: clamp(raw.maxIterations, d.maxIterations, b.maxIterations.min, b.maxIterations.max),
    maxToolCalls: clamp(raw.maxToolCalls, d.maxToolCalls, b.maxToolCalls.min, b.maxToolCalls.max),
    maxPlanRevisions: clamp(raw.maxPlanRevisions, d.maxPlanRevisions, b.maxPlanRevisions.min, b.maxPlanRevisions.max),
    maxProviderRequests: clamp(raw.maxProviderRequests, d.maxProviderRequests, b.maxProviderRequests.min, b.maxProviderRequests.max),
    maxDurationMs: clamp(raw.maxDurationMs, d.maxDurationMs, b.maxDurationMs.min, b.maxDurationMs.max),
    maxToolOutputChars: clamp(raw.maxToolOutputChars, d.maxToolOutputChars, b.maxToolOutputChars.min, b.maxToolOutputChars.max),
    maxPatchSizeChars: clamp(raw.maxPatchSizeChars, d.maxPatchSizeChars, b.maxPatchSizeChars.min, b.maxPatchSizeChars.max),
    maxChangedFiles: clamp(raw.maxChangedFiles, d.maxChangedFiles, b.maxChangedFiles.min, b.maxChangedFiles.max),
    maxConsecutiveFailures: clamp(raw.maxConsecutiveFailures, d.maxConsecutiveFailures, b.maxConsecutiveFailures.min, b.maxConsecutiveFailures.max),
  };
}
