import {
  isTerminalAgentState,
  type AgentSession,
  type CompletionReport,
  type CompletionTaskSummary,
  type Diagnostic,
} from './models';
import { describeValidationCoverage, isValidationBound } from './validation';

export interface ICompletionReportService {
  build(session: AgentSession, at: string): CompletionReport;
}

function filesForTask(session: AgentSession, taskId: string): string[] {
  const paths = new Set<string>();
  for (const execution of session.executions) {
    if (execution.taskId === taskId) {
      for (const file of execution.appliedFiles) {
        paths.add(file.path);
      }
    }
  }
  return [...paths];
}

function outcomeFor(session: AgentSession): CompletionReport['outcome'] {
  switch (session.state) {
    case 'completed':
      return 'completed';
    case 'rejected':
      return 'rejected';
    case 'cancelled':
      return 'cancelled';
    case 'failed':
      return 'failed';
    default:
      throw new Error('A completion report requires a terminal session.');
  }
}

function unresolvedFor(
  session: AgentSession,
  diagnostics: readonly Diagnostic[],
  outcome: CompletionReport['outcome'],
): string[] {
  if (outcome === 'completed') {
    return [];
  }
  const messages = new Set<string>();
  for (const diagnostic of diagnostics) {
    if (diagnostic.severity === 'error') {
      messages.add(diagnostic.message);
    }
  }
  if (session.error !== undefined && session.error.trim().length > 0) {
    messages.add(session.error.trim());
  }
  if (messages.size === 0) {
    messages.add(`The session ended in state "${session.state}".`);
  }
  return [...messages].slice(0, 20);
}

/**
 * Builds the report from recorded state only. A command is reported as passed
 * only when a ValidationRun with real evidence says so.
 */
export function buildCompletionReport(session: AgentSession, at: string): CompletionReport {
  const outcome = outcomeFor(session);
  const tasks: CompletionTaskSummary[] = session.tasks.map((task) => ({
    taskId: task.id,
    title: task.title,
    status: task.status,
    files: filesForTask(session, task.id),
  }));
  const repairs = session.tasks.reduce((total, task) => total + task.repairAttempts, 0);
  const evidence: string[] = [];

  evidence.push(`Requirement: ${session.requirement.text.split(/\r?\n/)[0]?.slice(0, 300) ?? ''}`);
  if (session.plan !== undefined) {
    evidence.push(`Plan "${session.plan.id}" contains ${session.plan.tasks.length} task(s).`);
    if (session.plan.risks.length > 0) {
      evidence.push(`Plan risk(s): ${session.plan.risks.slice(0, 5).join(' ')}`);
    }
  }
  const planDecision = session.approvals.find((decision) => decision.kind === 'plan');
  if (planDecision !== undefined) {
    evidence.push(
      `Plan decision: ${planDecision.outcome} at ${planDecision.decidedAt} (request ${planDecision.requestId}).`,
    );
  }
  const appliedExecutions = session.executions.filter(
    (execution) => execution.appliedFiles.length > 0,
  );
  if (appliedExecutions.length === 0) {
    evidence.push('No files were applied.');
  } else {
    for (const execution of appliedExecutions) {
      const task = session.tasks.find((candidate) => candidate.id === execution.taskId);
      evidence.push(
        `Applied ${execution.appliedFiles.length} file(s) for task "${task?.title ?? execution.taskId}": ${execution.appliedFiles
          .map((file) => file.path)
          .join(', ')}.`,
      );
    }
  }
  if (session.validationRuns.length === 0) {
    evidence.push('No validation command was executed.');
  } else {
    evidence.push(
      `Validation coverage: ${describeValidationCoverage(
        session.validationRuns,
        session.changeSets,
        session.repairProposals,
      )}.`,
    );
    for (const run of session.validationRuns) {
      const bound = isValidationBound(run, session.changeSets, session.repairProposals);
      const subject =
        run.changeSetId === undefined
          ? ' without a change set binding'
          : ` for change set "${run.changeSetId}"` +
            (run.repairProposalId === undefined ? '' : ` after repair "${run.repairProposalId}"`) +
            (bound ? '' : ' (binding no longer matches the stored change set)');
      const evidenceOfRun = run.evidence;
      if (evidenceOfRun === undefined) {
        evidence.push(
          `Validation ${run.outcome}${subject}: ${run.detail ?? 'No command was executed.'}`,
        );
        continue;
      }
      const status =
        run.outcome === 'passed'
          ? 'passed'
          : evidenceOfRun.cancelled
            ? 'cancelled'
            : evidenceOfRun.timedOut
              ? 'timed out'
              : 'failed';
      evidence.push(
        `Command "${run.command}" ${status} with exit code ${
          evidenceOfRun.exitCode ?? 'null'
        } in ${evidenceOfRun.durationMs} ms at ${run.finishedAt}${subject}.`,
      );
    }
  }
  for (const proposal of session.repairProposals) {
    evidence.push(
      `Repair attempt ${proposal.attempt} for task "${proposal.taskId}" proposed ${proposal.plan.changes.length} change(s) at ${proposal.createdAt}.`,
    );
  }
  evidence.push(`Final state: ${session.state}.`);

  return {
    sessionId: session.id,
    requirement: session.requirement.text,
    outcome,
    planSummary: session.plan?.summary,
    tasks,
    validationRuns: [...session.validationRuns],
    diagnostics: [...session.diagnostics],
    repairs,
    unresolved: unresolvedFor(session, session.diagnostics, outcome),
    evidence,
    generatedAt: at,
  };
}

export class CompletionReportService implements ICompletionReportService {
  build(session: AgentSession, at: string): CompletionReport {
    if (!isTerminalAgentState(session.state)) {
      throw new Error('A completion report requires a terminal session.');
    }
    return buildCompletionReport(session, at);
  }
}
