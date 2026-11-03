import {
  isFailureTaskStatus,
  isTerminalTaskStatus,
  type AgentTask,
  type TaskStatus,
} from './models';

export interface TaskGraphValidation {
  readonly ok: boolean;
  readonly errors: readonly string[];
}

export type ScheduleReason = 'runnable' | 'waiting' | 'done' | 'deadlock' | 'stopped';

export interface ScheduleDecision {
  readonly reason: ScheduleReason;
  readonly runnable?: AgentTask;
  readonly activeTaskId?: string;
  readonly blockedTaskIds: readonly string[];
  readonly detail?: string;
}

export interface ITaskScheduler {
  validate(tasks: readonly AgentTask[]): TaskGraphValidation;
  refresh(tasks: readonly AgentTask[]): readonly AgentTask[];
  schedule(tasks: readonly AgentTask[]): ScheduleDecision;
  order(tasks: readonly AgentTask[]): readonly AgentTask[];
}

const ACTIVE_STATUSES: readonly TaskStatus[] = [
  'running',
  'awaiting-approval',
  'applied',
  'validation-failed',
  'repairing',
];

export function validateTaskGraph(tasks: readonly AgentTask[]): TaskGraphValidation {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const task of tasks) {
    if (typeof task.id !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(task.id)) {
      errors.push(`Task id "${String(task.id)}" is not a safe identifier.`);
      continue;
    }
    if (ids.has(task.id)) {
      errors.push(`Task id "${task.id}" is used more than once.`);
    }
    ids.add(task.id);
  }

  for (const task of tasks) {
    if (task.dependsOn.length > 20) {
      errors.push(`Task "${task.id}" has too many dependencies.`);
    }
    for (const dependency of task.dependsOn) {
      if (dependency === task.id) {
        errors.push(`Task "${task.id}" depends on itself.`);
      } else if (!ids.has(dependency)) {
        errors.push(`Task "${task.id}" depends on unknown task "${dependency}".`);
      }
    }
  }

  if (errors.length === 0 && detectCycle(tasks) !== undefined) {
    errors.push(`The task graph contains a dependency cycle: ${detectCycle(tasks)?.join(' -> ')}.`);
  }

  return { ok: errors.length === 0, errors };
}

function detectCycle(tasks: readonly AgentTask[]): string[] | undefined {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  const visit = (id: string): string[] | undefined => {
    if (visiting.has(id)) {
      const start = stack.indexOf(id);
      return [...stack.slice(start), id];
    }
    if (visited.has(id)) {
      return undefined;
    }
    const task = byId.get(id);
    if (task === undefined) {
      return undefined;
    }
    visiting.add(id);
    stack.push(id);
    for (const dependency of task.dependsOn) {
      const cycle = visit(dependency);
      if (cycle !== undefined) {
        return cycle;
      }
    }
    stack.pop();
    visiting.delete(id);
    visited.add(id);
    return undefined;
  };

  for (const task of tasks) {
    const cycle = visit(task.id);
    if (cycle !== undefined) {
      return cycle;
    }
  }
  return undefined;
}

function withStatus(task: AgentTask, status: TaskStatus): AgentTask {
  return task.status === status ? task : { ...task, status };
}

/**
 * Re-evaluates pending tasks against their dependencies. A dependency that
 * failed, was skipped or was cancelled blocks the task. A task whose
 * dependencies all completed becomes runnable again.
 */
export function refreshBlockedTasks(tasks: readonly AgentTask[]): AgentTask[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  return tasks.map((task) => {
    if (task.status !== 'pending' && task.status !== 'blocked') {
      return task;
    }
    const dependencies = task.dependsOn
      .map((id) => byId.get(id))
      .filter((dependency): dependency is AgentTask => dependency !== undefined);
    const blocked = dependencies.some((dependency) => isFailureTaskStatus(dependency.status));
    const ready = dependencies.every((dependency) => dependency.status === 'completed');
    if (blocked) {
      return withStatus(task, 'blocked');
    }
    if (ready) {
      return withStatus(task, 'pending');
    }
    return task.status === 'blocked' ? withStatus(task, 'pending') : task;
  });
}

export function nextRunnableTask(tasks: readonly AgentTask[]): AgentTask | undefined {
  return tasks.find(
    (task) =>
      task.status === 'pending' &&
      task.dependsOn.every((id) => tasks.some((other) => other.id === id && other.status === 'completed')),
  );
}

/**
 * Decides what the orchestrator may do next without starting duplicate work.
 * `waiting` means an active task still owns the session; `deadlock` means
 * pending work exists but no task can ever become runnable.
 */
export function schedule(tasks: readonly AgentTask[]): ScheduleDecision {
  const refreshed = refreshBlockedTasks(tasks);
  const blockedTaskIds = refreshed
    .filter((task) => task.status === 'blocked')
    .map((task) => task.id);
  const active = refreshed.find((task) => ACTIVE_STATUSES.includes(task.status));
  if (active !== undefined) {
    return {
      reason: 'waiting',
      activeTaskId: active.id,
      blockedTaskIds,
      detail: `Task "${active.id}" is ${active.status}.`,
    };
  }

  if (refreshed.length === 0 || refreshed.every((task) => task.status === 'completed')) {
    return { reason: 'done', blockedTaskIds };
  }

  const runnable = nextRunnableTask(refreshed);
  if (runnable !== undefined) {
    return { reason: 'runnable', runnable, blockedTaskIds };
  }

  if (refreshed.every((task) => isTerminalTaskStatus(task.status))) {
    return {
      reason: 'stopped',
      blockedTaskIds,
      detail: 'No runnable task remains; one or more tasks failed or were skipped.',
    };
  }

  return {
    reason: 'deadlock',
    blockedTaskIds,
    detail:
      blockedTaskIds.length > 0
        ? `Blocked by failed dependencies: ${blockedTaskIds.join(', ')}.`
        : 'The task graph has no runnable task.',
  };
}

export function orderTasks(tasks: readonly AgentTask[]): AgentTask[] {
  const order = new Map(tasks.map((task, index) => [task.id, index]));
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const remaining = new Set(tasks.map((task) => task.id));
  const completed = new Set<string>();
  const ordered: AgentTask[] = [];

  while (remaining.size > 0) {
    const ready = [...remaining]
      .map((id) => byId.get(id))
      .filter((task): task is AgentTask => task !== undefined)
      .filter((task) => task.dependsOn.every((dependency) => completed.has(dependency)))
      .sort((left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0));
    if (ready.length === 0) {
      return [];
    }
    for (const task of ready) {
      ordered.push(task);
      remaining.delete(task.id);
      completed.add(task.id);
    }
  }
  return ordered;
}

export function updateTask(
  tasks: readonly AgentTask[],
  taskId: string,
  patch: Partial<Omit<AgentTask, 'id'>>,
): AgentTask[] {
  return tasks.map((task) => (task.id === taskId ? { ...task, ...patch } : task));
}

export function findTask(tasks: readonly AgentTask[], taskId: string): AgentTask | undefined {
  return tasks.find((task) => task.id === taskId);
}

export class TaskScheduler implements ITaskScheduler {
  validate(tasks: readonly AgentTask[]): TaskGraphValidation {
    return validateTaskGraph(tasks);
  }

  refresh(tasks: readonly AgentTask[]): readonly AgentTask[] {
    return refreshBlockedTasks(tasks);
  }

  schedule(tasks: readonly AgentTask[]): ScheduleDecision {
    return schedule(tasks);
  }

  order(tasks: readonly AgentTask[]): readonly AgentTask[] {
    return orderTasks(tasks);
  }
}
