import { evaluateCommand } from '../commands/policy';
import { runApprovedCommand, type CommandResult } from '../commands/runner';
import { analyzeValidationFailure } from './diagnostics';
import { parseTestOutput, type TestOutputFormat } from '../build/testOutput';
import type { AgentTool, AgentToolResult } from './codingAgent';
import type { Diagnostic, ValidationEvidence } from './models';
import { hashContent, type ChangePlan } from '../changes/model';
import type { ExecutionKind, ExecutionService } from '../execution/service';

export interface CommandToolApproval {
  (request: { readonly command: string; readonly cwd: string; readonly risk: string }): Promise<boolean>;
}

/** A fixed value, or a resolver read at execution time so settings stay live. */
export type LiveValue<T> = T | (() => T);

export function resolveLive<T>(value: LiveValue<T>): T {
  return typeof value === 'function' ? (value as () => T)() : value;
}

export interface CommandToolEnvironment {
  readonly cwd: LiveValue<string>;
  readonly workspaceRoot: LiveValue<string>;
  readonly allowlist: LiveValue<readonly string[]>;
  readonly timeoutMs: LiveValue<number>;
  readonly maxOutputChars?: LiveValue<number | undefined>;
  readonly secret?: string | (() => Promise<string | undefined>);
  readonly trusted: LiveValue<boolean>;
  readonly approval: CommandToolApproval;
  /** Optional execution tracker; when present every run is recorded for the current task. */
  readonly executionService?: ExecutionService;
}

interface CommandToolSnapshot {
  readonly cwd: string;
  readonly workspaceRoot: string;
  readonly allowlist: readonly string[];
  readonly timeoutMs: number;
  readonly maxOutputChars: number | undefined;
  readonly trusted: boolean;
}

export class CommandTools {
  constructor(private readonly env: CommandToolEnvironment) {}

  /**
   * Read at execution time, never at construction: workspace trust can be
   * granted or revoked and the allowlist edited without a window reload.
   */
  private snapshot(): CommandToolSnapshot {
    return {
      cwd: resolveLive(this.env.cwd),
      workspaceRoot: resolveLive(this.env.workspaceRoot),
      allowlist: resolveLive(this.env.allowlist),
      timeoutMs: resolveLive(this.env.timeoutMs),
      maxOutputChars: resolveLive(this.env.maxOutputChars),
      trusted: resolveLive(this.env.trusted),
    };
  }

  async checkCommand(command: unknown): Promise<AgentToolResult> {
    if (typeof command !== 'string') {
      return { ok: false, tool: 'check_command', error: 'Command must be text.', durationMs: 0 };
    }
    const policy = evaluateCommand(command, this.snapshot().allowlist);
    return {
      ok: policy.allowed,
      tool: 'check_command',
      output: JSON.stringify(policy, null, 2),
      durationMs: 0,
    };
  }

  async runCommand(
    command: unknown,
    boundPlan?: ChangePlan,
    signal?: AbortSignal,
    execution?: { readonly kind?: ExecutionKind; readonly testFormat?: TestOutputFormat },
  ): Promise<AgentToolResult> {
    if (typeof command !== 'string') {
      return { ok: false, tool: 'run_command', error: 'Command must be text.', durationMs: 0 };
    }
    const isAborted = (): boolean => signal?.aborted === true;
    const requested = this.snapshot();
    const policy = evaluateCommand(command, requested.allowlist);
    if (!policy.allowed || policy.normalized === undefined) {
      return { ok: false, tool: 'run_command', error: policy.reason, output: JSON.stringify(policy, null, 2), durationMs: 0 };
    }
    if (isAborted()) {
      return { ok: false, tool: 'run_command', error: 'The command was cancelled before it started.', durationMs: 0 };
    }
    const approved = await this.env.approval({ command: policy.normalized, cwd: requested.cwd, risk: policy.risk });
    if (!approved) {
      return {
        ok: false,
        tool: 'run_command',
        error: 'Command execution requires explicit approval.',
        output: JSON.stringify({ command: policy.normalized, approved: false }, null, 2),
        durationMs: 0,
      };
    }
    if (isAborted()) {
      return { ok: false, tool: 'run_command', error: 'The command was cancelled while awaiting approval.', durationMs: 0 };
    }
    // The approval modal can stay open while trust is revoked or the allowlist
    // changes, so a fresh fail-closed snapshot is taken right before running.
    // If the directory the user approved moved in the meantime, the approval no
    // longer matches the command about to run — refuse instead of drifting.
    const current = this.snapshot();
    if (current.cwd !== requested.cwd || current.workspaceRoot !== requested.workspaceRoot) {
      return {
        ok: false,
        tool: 'run_command',
        error: 'The working directory changed while approval was pending; the command was not run. Approve it again.',
        durationMs: 0,
      };
    }
    const recheck = evaluateCommand(command, current.allowlist);
    if (!recheck.allowed || recheck.normalized === undefined) {
      // The allowlist was narrowed underneath us; refuse with the same
      // canonical reason the runner itself would have produced.
      return {
        ok: false,
        tool: 'run_command',
        error: recheck.reason ?? 'The command is not in the configured validation allowlist.',
        output: JSON.stringify(recheck, null, 2),
        durationMs: 0,
      };
    }
    const secret = typeof this.env.secret === 'function' ? await this.env.secret() : this.env.secret;
    const executionKind: ExecutionKind = execution?.kind ?? 'command';

    if (this.env.executionService !== undefined) {
      const finished = await this.env.executionService.run(recheck.normalized, {
        cwd: current.cwd,
        workspaceRoot: current.workspaceRoot,
        allowlist: current.allowlist,
        timeoutMs: current.timeoutMs,
        maxOutputChars: current.maxOutputChars,
        secret,
        trusted: current.trusted,
        signal,
        kind: executionKind,
      });
      const diagnostics: readonly Diagnostic[] =
        finished.status === 'succeeded'
          ? []
          : analyzeValidationFailure({
              id: 'validation-1',
              taskId: 'coding-agent',
              command: finished.command,
              startedAt: finished.startedAt,
              finishedAt: finished.finishedAt ?? new Date().toISOString(),
              outcome: 'failed',
              evidence: {
                command: finished.command,
                exitCode: finished.exitCode,
                passed: false,
                timedOut: finished.timedOut,
                cancelled: finished.cancelled,
                truncated: finished.truncated,
                durationMs: finished.durationMs ?? 0,
                output: finished.output,
                error: finished.error,
              } as ValidationEvidence,
            });
      const tests =
        executionKind === 'test'
          ? parseTestOutput(finished.output, execution?.testFormat ?? 'node')
          : undefined;
      this.env.executionService.update(finished.id, {
        diagnostics,
        ...(tests !== undefined ? { tests } : {}),
      });
      const binding =
        boundPlan !== undefined
          ? { planId: boundPlan.id, planHash: hashContent(JSON.stringify(boundPlan)) }
          : undefined;
      const enriched = {
        ...finished,
        diagnostics,
        ...(tests !== undefined ? { tests } : {}),
        binding,
      };
      return {
        ok: finished.status === 'succeeded',
        tool: 'run_command',
        output: JSON.stringify(enriched, null, 2),
        error: finished.error,
        durationMs: finished.durationMs ?? 0,
      };
    }

    const result: CommandResult = await runApprovedCommand(recheck.normalized, {
      cwd: current.cwd,
      workspaceRoot: current.workspaceRoot,
      allowlist: current.allowlist,
      timeoutMs: current.timeoutMs,
      maxOutputChars: current.maxOutputChars,
      secret,
      trusted: current.trusted,
      signal,
    });
    const diagnostics: readonly Diagnostic[] =
      result.exitCode === 0 && result.error === undefined
        ? []
        : analyzeValidationFailure({
            id: 'validation-1',
            taskId: 'coding-agent',
            command: result.command,
            startedAt: new Date(Date.now() - result.durationMs).toISOString(),
            finishedAt: new Date().toISOString(),
            outcome: 'failed',
            evidence: {
              command: result.command,
              exitCode: result.exitCode,
              passed: false,
              timedOut: result.timedOut,
              cancelled: result.cancelled,
              truncated: result.truncated,
              durationMs: result.durationMs,
              output: result.output,
              error: result.error,
            } as ValidationEvidence,
          });
    const binding =
      boundPlan !== undefined
        ? { planId: boundPlan.id, planHash: hashContent(JSON.stringify(boundPlan)) }
        : undefined;
    const enriched = { ...result, diagnostics, binding };
    return {
      ok: result.exitCode === 0 && result.error === undefined,
      tool: 'run_command',
      output: JSON.stringify(enriched, null, 2),
      error: result.error,
      durationMs: result.durationMs,
    };
  }

  async runValidationCommand(command: unknown, signal?: AbortSignal): Promise<AgentToolResult> {
    const result = await this.runCommand(command, undefined, signal);
    return { ...result, tool: 'run_validation_command' };
  }

  async diagnoseValidationFailure(output: unknown): Promise<AgentToolResult> {
    const text = typeof output === 'string' ? output : '';
    const diagnostics = analyzeValidationFailure({
      id: 'validation-diagnosis',
      taskId: 'coding-agent',
      command: 'validation',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      outcome: 'failed',
      evidence: {
        command: 'validation',
        exitCode: 1,
        passed: false,
        timedOut: false,
        cancelled: false,
        truncated: false,
        durationMs: 0,
        output: text,
      } as ValidationEvidence,
    });
    return {
      ok: diagnostics.length > 0,
      tool: 'diagnose_validation_failure',
      output: JSON.stringify(diagnostics, null, 2),
      durationMs: 0,
    };
  }

  toAgentTools(): readonly AgentTool[] {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return [
      {
        name: 'check_command',
        description: 'Check whether a command is allowlisted and classify its risk. Does not execute it.',
        parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
        async execute(args) {
          return self.checkCommand(args.command);
        },
      },
      {
        name: 'run_command',
        description: 'Run an allowlisted validation command after explicit approval.',
        parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
        get timeoutMs() {
          return resolveLive(self.env.timeoutMs);
        },
        async execute(args, context) {
          return self.runCommand(args.command, undefined, context?.signal);
        },
      },
      {
        name: 'run_validation_command',
        description: 'Run an allowlisted validation command after explicit approval and return structured validation evidence.',
        parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
        get timeoutMs() {
          return resolveLive(self.env.timeoutMs);
        },
        async execute(args, context) {
          return self.runValidationCommand(args.command, context?.signal);
        },
      },
      {
        name: 'diagnose_validation_failure',
        description: 'Analyze validation output and return structured diagnostics without running another command.',
        parameters: { type: 'object', properties: { output: { type: 'string' } } },
        async execute(args) {
          return self.diagnoseValidationFailure(args.output);
        },
      },
    ];
  }
}
