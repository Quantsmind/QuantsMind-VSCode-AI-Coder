import type { TaskStatus } from './models';

export interface ContinuationTaskInput {
  readonly id: string;
  readonly status: TaskStatus;
  readonly dependencies?: readonly string[];
}

export interface ContinuationPlan {
  /** Task ids that finished successfully; never re-run. */
  readonly done: readonly string[];
  /** Task ids that failed and need attention before resuming. */
  readonly failed: readonly string[];
  /** Task ids that were in flight (or blocked by a failed/interrupted dependency) when interrupted. */
  readonly interrupted: readonly string[];
  /** Task ids ready to run in dependency order when the session resumes. */
  readonly resumable: readonly string[];
  /** Task ids that cannot start until a prerequisite is resolved. */
  readonly blocked: readonly string[];
  readonly reasons: Readonly<Record<string, string>>;
}

/**
 * Computes an honest continuation plan from persisted task states. Nothing
 * is assumed restartable: only tasks whose dependencies are all completed
 * become resumable, and failed tasks must be reviewed or retried first.
 */
export function computeContinuationPlan(tasks: readonly ContinuationTaskInput[]): ContinuationPlan {
  const done: string[] = [];
  const failed: string[] = [];
  const interrupted: string[] = [];
  const pendingSet = new Set<string>();

  for (const task of tasks) {
    if (task.status === 'completed' || task.status === 'applied') {
      done.push(task.id);
    } else if (task.status === 'failed' || task.status === 'validation-failed' || task.status === 'cancelled') {
      failed.push(task.id);
    } else if (task.status === 'skipped') {
      // Skipped tasks are treated as intentionally finished by the user.
      done.push(task.id);
    } else {
      // pending, blocked, running, awaiting-approval, repairing: all were in-flight or queued.
      pendingSet.add(task.id);
      interrupted.push(task.id);
    }
  }

  const doneSet = new Set(done);
  const failedSet = new Set(failed);

  const reasons: Record<string, string> = {};
  for (const taskId of failed) {
    reasons[taskId] = 'The task failed; review it or retry it before resuming the session.';
  }

  const resumable: string[] = [];
  const blocked: string[] = [];
  const remaining = [...pendingSet];
  let progressed = true;
  while (progressed && remaining.length > 0) {
    progressed = false;
    for (let index = remaining.length - 1; index >= 0; index -= 1) {
      const taskId = remaining[index];
      if (doneSet.has(taskId)) {
        continue;
      }
      const input = tasks.find((task) => task.id === taskId);
      const dependencies = input?.dependencies ?? [];
      const dependencyStatus = dependencies.map((dependency) => {
        if (doneSet.has(dependency)) {
          return 'done' as const;
        }
        if (failedSet.has(dependency)) {
          return 'failed' as const;
        }
        return 'pending' as const;
      });
      if (dependencyStatus.some((status) => status === 'failed')) {
        blocked.push(taskId);
        reasons[taskId] = 'Blocked by a failed dependency.';
        remaining.splice(index, 1);
        progressed = true;
        continue;
      }
      if (dependencyStatus.every((status) => status === 'done')) {
        resumable.push(taskId);
        doneSet.add(taskId); // treat as schedulable for this pass
        remaining.splice(index, 1);
        progressed = true;
        continue;
      }
    }
  }
  for (const taskId of remaining) {
    blocked.push(taskId);
    reasons[taskId] = 'Blocked by unresolved dependencies.';
  }

  return { done, failed, interrupted, resumable, blocked, reasons };
}
