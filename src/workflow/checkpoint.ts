/**
 * Workflow checkpoints: coarse, user-meaningful lifecycle phases with
 * validated transitions, persisted as ordinary session note events under a
 * `workflow:<phase>` prefix. Parsing those events after a crash gives an
 * honest restoration hint instead of silently re-running work.
 *
 * These complement the in-memory agent state machine — they do not replace it,
 * and no phase here triggers any automatic action.
 */
import type { WorkflowPhase } from './model';
import { WORKFLOW_PHASES } from './model';

export const WORKFLOW_PHASE_TRANSITIONS: Readonly<Record<WorkflowPhase, readonly WorkflowPhase[]>> = {
  created: ['planned', 'cancelled', 'blocked'],
  planned: ['awaiting-review', 'cancelled', 'blocked'],
  'awaiting-review': ['approved', 'cancelled', 'blocked'],
  approved: ['editing', 'cancelled', 'blocked'],
  editing: ['changes-applied', 'cancelled', 'blocked'],
  'changes-applied': ['validation-pending', 'cancelled', 'blocked'],
  'validation-pending': ['validation-complete', 'cancelled', 'blocked'],
  'validation-complete': ['completed', 'blocked', 'cancelled'],
  blocked: ['planned', 'cancelled', 'completed'],
  cancelled: ['cancelled'],
  completed: ['completed'],
};

const TERMINAL_PHASES: readonly WorkflowPhase[] = ['blocked', 'cancelled', 'completed'];

export function isWorkflowPhase(value: unknown): value is WorkflowPhase {
  return typeof value === 'string' && (WORKFLOW_PHASES as readonly string[]).includes(value);
}

export function canTransitionWorkflowPhase(from: WorkflowPhase, to: WorkflowPhase): boolean {
  return WORKFLOW_PHASE_TRANSITIONS[from]?.includes(to) ?? false;
}

export function isTerminalWorkflowPhase(phase: WorkflowPhase): boolean {
  return TERMINAL_PHASES.includes(phase);
}

export function makeCheckpointMessage(phase: WorkflowPhase, detail?: string): string {
  const trimmed = typeof detail === 'string' ? detail.trim().slice(0, 200) : '';
  return trimmed.length > 0 ? `workflow:${phase} ${trimmed}` : `workflow:${phase}`;
}

const CHECKPOINT_PATTERN = /^workflow:([a-z-]+)(?:\s+(.*))?$/;

export function parseCheckpointMessage(message: unknown): { phase: WorkflowPhase; detail?: string } | undefined {
  if (typeof message !== 'string') {
    return undefined;
  }
  const match = CHECKPOINT_PATTERN.exec(message.trim());
  if (match === null) {
    return undefined;
  }
  const phase = match[1] as WorkflowPhase;
  if (!isWorkflowPhase(phase)) {
    return undefined;
  }
  const detail = match[2]?.trim();
  return detail !== undefined && detail.length > 0 ? { phase, detail: detail.slice(0, 200) } : { phase };
}

export interface WorkflowRestoration {
  /** The latest phase seen in the event log, if any checkpoint was recorded. */
  readonly phase?: WorkflowPhase;
  /** True when the last checkpoint shows an edit that may be half-applied. */
  readonly requiresInspection: boolean;
  /** True when a terminal phase (blocked/cancelled/completed) was reached. */
  readonly terminal: boolean;
  readonly note?: string;
}

export interface CheckpointEventLike {
  readonly type: string;
  readonly message?: string;
}

/**
 * Reconstructs workflow state from the persisted note events. Later events win;
 * phases outside the lifecycle are ignored. An interrupted edit always requires
 * inspection before any further editing is attempted.
 */
export function computeWorkflowRestoration(events: readonly CheckpointEventLike[]): WorkflowRestoration {
  let latest: { phase: WorkflowPhase; detail?: string } | undefined;
  for (const event of events) {
    if (event.type !== 'note') {
      continue;
    }
    const parsed = parseCheckpointMessage(event.message);
    if (parsed !== undefined) {
      latest = parsed;
    }
  }
  if (latest === undefined) {
    return { requiresInspection: false, terminal: false };
  }
  const { phase, detail } = latest;
  const requiresInspection = phase === 'editing' || phase === 'changes-applied';
  const terminal = isTerminalWorkflowPhase(phase);
  const note = requiresInspection
    ? `A previous session may have applied changes (last checkpoint: ${phase}). Verify the files on disk before editing again.`
    : terminal
      ? detail === undefined
        ? `Last workflow checkpoint: ${phase}.`
        : `Last workflow checkpoint: ${phase} — ${detail}`
      : undefined;
  return { phase, requiresInspection, terminal, ...(note !== undefined ? { note } : {}) };
}
