/**
 * Shared typed execution contract between the two agent entry paths (WP4):
 *
 * - `chat-agent`: the chat agent path, backed by `runAgentEngine`.
 * - `orchestrator`: the approval-oriented task orchestrator.
 *
 * Both produce the same `EngineeringOutcome`; no path silently elevates its
 * authority through the contract. The renderer is used for bounded session
 * notes so outcomes are visible without a new UI subsystem.
 */
import type { AgentExecutionLimits } from './limits';
import { AGENT_LIMIT_BOUNDS, AGENT_LIMIT_DEFAULTS } from './limits';
import type { AgentEngineResult } from './engine';
import type { ResolvedAgenticEngineSettings } from '../config/resolve';
import type { AgentSession } from './models';
import { isTerminalTaskStatus } from './models';

export type ExecutionPath = 'chat-agent' | 'orchestrator';

export type EngineeringStatus =
  | 'completed'
  | 'partial'
  | 'blocked'
  | 'failed'
  | 'paused'
  | 'cancelled'
  | 'recovery-required'
  | 'inconclusive';

export interface EngineeringOutcome {
  readonly path: ExecutionPath;
  readonly status: EngineeringStatus;
  readonly evaluation: 'complete' | 'partial' | 'failed' | 'inconclusive';
  readonly iterations: number;
  readonly providerRequests: number;
  readonly toolCalls: number;
  /** Calls refused before dispatch (authorization gate). */
  readonly refusedToolCalls: number;
  readonly revisions: number;
  readonly filesChanged: readonly string[];
  readonly validationOutcome?: string;
  readonly limitReached?: string;
  readonly recoveryRequired: boolean;
  readonly failureSummary?: string;
}

/** Maps the resolved (already bounded) settings into the engine's full limit bundle. */
export function settingsToEngineLimits(resolved: ResolvedAgenticEngineSettings): AgentExecutionLimits {
  const d = AGENT_LIMIT_DEFAULTS;
  const b = AGENT_LIMIT_BOUNDS;
  const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, Math.round(value)));
  return {
    maxIterations: clamp(resolved.maxIterations, b.maxIterations.min, b.maxIterations.max),
    maxToolCalls: clamp(resolved.maxToolCalls, b.maxToolCalls.min, b.maxToolCalls.max),
    maxPlanRevisions: clamp(resolved.maxPlanRevisions, b.maxPlanRevisions.min, b.maxPlanRevisions.max),
    maxProviderRequests: clamp(d.maxProviderRequests, b.maxProviderRequests.min, b.maxProviderRequests.max),
    maxDurationMs: clamp(resolved.maxDurationMs, b.maxDurationMs.min, b.maxDurationMs.max),
    maxToolOutputChars: d.maxToolOutputChars,
    maxPatchSizeChars: d.maxPatchSizeChars,
    maxChangedFiles: clamp(resolved.maxChangedFiles, b.maxChangedFiles.min, b.maxChangedFiles.max),
    maxConsecutiveFailures: d.maxConsecutiveFailures,
  };
}

/** Maps an engine outcome to the shared contract. */
export function engineResultToOutcome(result: AgentEngineResult): EngineeringOutcome {
  const status: EngineeringStatus =
    result.status === 'completed'
      ? result.evaluation === 'complete'
        ? 'completed'
        : result.evaluation === 'partial'
          ? 'partial'
          : 'failed'
      : result.status === 'blocked'
        ? 'blocked'
        : result.status === 'recovery-required'
          ? 'recovery-required'
          : result.status === 'paused'
            ? 'paused'
            : result.status === 'cancelled'
              ? 'cancelled'
              : result.status === 'limit'
                ? 'blocked'
                : 'failed';
  return {
    path: 'chat-agent',
    status,
    evaluation: result.evaluation,
    iterations: result.iterations,
    providerRequests: result.providerRequests,
    toolCalls: result.toolCalls,
    refusedToolCalls: result.refusedToolCalls,
    revisions: result.revisions,
    filesChanged: [...result.filesChanged],
    limitReached: result.limitReached,
    recoveryRequired: result.status === 'recovery-required',
    ...(result.status === 'error' || result.status === 'blocked' || result.status === 'limit'
      ? { failureSummary: result.finalText.slice(0, 300) }
      : {}),
  };
}

function firstLine(text: string | undefined, max = 200): string | undefined {
  const trimmed = text?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed.split('\n')[0]?.slice(0, max) : undefined;
}

/** Maps an orchestrator session to the shared contract. */
export function orchestratorSessionToOutcome(
  session: AgentSession,
  toolAccounting?: { readonly dispatched: number; readonly refused: number },
): EngineeringOutcome {
  const total = session.tasks.length;
  const completed = session.tasks.filter((task) => task.status === 'completed').length;
  const filesChanged = [...new Set(
    (session.executions ?? []).flatMap((execution) =>
      (execution.appliedFiles ?? []).map((file) => file.path.replace(/\\/g, '/')),
    ),
  )].slice(0, 100);
  const validationOutcome = session.validationRuns.length > 0
    ? session.validationRuns[session.validationRuns.length - 1]?.outcome
    : undefined;
  const accounting = toolAccounting ?? { dispatched: 0, refused: 0 };

  if (session.state === 'completed') {
    const allDone = total === 0 || completed === total;
    return {
      path: 'orchestrator',
      status: allDone ? 'completed' : 'partial',
      evaluation: allDone ? 'complete' : 'partial',
      iterations: session.tasks.reduce((sum, task) => sum + task.attempts, 0),
      providerRequests: session.providerCalls,
      toolCalls: accounting.dispatched,
      refusedToolCalls: accounting.refused,
      revisions: session.tasks.reduce((sum, task) => sum + task.repairAttempts, 0),
      filesChanged,
      ...(validationOutcome !== undefined ? { validationOutcome } : {}),
      recoveryRequired: false,
    };
  }

  const failedTasks = session.tasks.filter((task) => !isTerminalTaskStatus(task.status) || task.status === 'failed');
  const failureSummary =
    firstLine(session.error) ??
    firstLine(failedTasks[0]?.error) ??
    (session.state === 'cancelled' ? 'Cancelled.' : undefined);

  if (session.state === 'cancelled') {
    return {
      path: 'orchestrator',
      status: 'cancelled',
      evaluation: 'inconclusive',
      iterations: session.tasks.reduce((sum, task) => sum + task.attempts, 0),
      providerRequests: session.providerCalls,
      toolCalls: accounting.dispatched,
      refusedToolCalls: accounting.refused,
      revisions: session.tasks.reduce((sum, task) => sum + task.repairAttempts, 0),
      filesChanged,
      ...(validationOutcome !== undefined ? { validationOutcome } : {}),
      recoveryRequired: session.needsReview,
      ...(failureSummary !== undefined ? { failureSummary } : {}),
    };
  }

  if (session.state === 'paused') {
    return {
      path: 'orchestrator',
      status: 'paused',
      evaluation: 'inconclusive',
      iterations: session.tasks.reduce((sum, task) => sum + task.attempts, 0),
      providerRequests: session.providerCalls,
      toolCalls: accounting.dispatched,
      refusedToolCalls: accounting.refused,
      revisions: session.tasks.reduce((sum, task) => sum + task.repairAttempts, 0),
      filesChanged,
      ...(validationOutcome !== undefined ? { validationOutcome } : {}),
      recoveryRequired: session.needsReview,
      ...(failureSummary !== undefined ? { failureSummary } : {}),
    };
  }

  return {
    path: 'orchestrator',
    status: 'failed',
    evaluation: 'failed',
    iterations: session.tasks.reduce((sum, task) => sum + task.attempts, 0),
    providerRequests: session.providerCalls,
    toolCalls: accounting.dispatched,
    refusedToolCalls: accounting.refused,
    revisions: session.tasks.reduce((sum, task) => sum + task.repairAttempts, 0),
    filesChanged,
    ...(validationOutcome !== undefined ? { validationOutcome } : {}),
    recoveryRequired: session.needsReview,
    ...(failureSummary !== undefined ? { failureSummary } : {}),
  };
}

/** One bounded, human-readable outcome line for the session timeline. */
export function renderOutcome(outcome: EngineeringOutcome): string {
  const parts: string[] = [`Outcome: ${outcome.status} (${outcome.evaluation})`];
  parts.push(`${outcome.filesChanged.length} file(s) changed`);
  parts.push(`${outcome.providerRequests} provider call(s), ${outcome.toolCalls + outcome.refusedToolCalls} tool call(s) (${outcome.refusedToolCalls} refused)`);
  if (outcome.limitReached !== undefined) {
    parts.push(`limit: ${outcome.limitReached}`);
  }
  if (outcome.recoveryRequired) {
    parts.push('recovery required');
  }
  if (outcome.failureSummary !== undefined) {
    parts.push(`note: ${outcome.failureSummary}`);
  }
  return parts.join(' Ã‚Â· ').slice(0, 500);
}