import { evaluateCommand } from '../commands/policy';
import { runApprovedCommand, type CommandResult } from '../commands/runner';
import { analyzeValidationFailure } from './diagnostics';
import type { AgentTool, AgentToolResult } from './codingAgent';
import type { Diagnostic, ValidationEvidence } from './models';
import { hashContent, type ChangePlan } from '../changes/model';

export interface CommandToolApproval {
  (request: { readonly command: string; readonly cwd: string; readonly risk: string }): Promise<boolean>;
}

export interface CommandToolEnvironment {
  readonly cwd: string;
  readonly workspaceRoot: string;
  readonly allowlist: readonly string[];
  readonly timeoutMs: number;
  readonly maxOutputChars?: number;
  readonly secret?: string | (() => Promise<string | undefined>);
  readonly trusted: boolean;
  readonly approval: CommandToolApproval;
}

export class CommandTools {
  constructor(private readonly env: CommandToolEnvironment) {}

  async checkCommand(command: unknown): Promise<AgentToolResult> {
    if (typeof command !== 'string') {
      return { ok: false, tool: 'check_command', error: 'Command must be text.', durationMs: 0 };
    }
    const policy = evaluateCommand(command, this.env.allowlist);
    return {
      ok: policy.allowed,
      tool: 'check_command',
      output: JSON.stringify(policy, null, 2),
      durationMs: 0,
    };
  }

  async runCommand(command: unknown, boundPlan?: ChangePlan): Promise<AgentToolResult> {
    if (typeof command !== 'string') {
      return { ok: false, tool: 'run_command', error: 'Command must be text.', durationMs: 0 };
    }
    const policy = evaluateCommand(command, this.env.allowlist);
    if (!policy.allowed || policy.normalized === undefined) {
      return { ok: false, tool: 'run_command', error: policy.reason, output: JSON.stringify(policy, null, 2), durationMs: 0 };
    }
    const approved = await this.env.approval({ command: policy.normalized, cwd: this.env.cwd, risk: policy.risk });
    if (!approved) {
      return {
        ok: false,
        tool: 'run_command',
        error: 'Command execution requires explicit approval.',
        output: JSON.stringify({ command: policy.normalized, approved: false }, null, 2),
        durationMs: 0,
      };
    }
    const secret = typeof this.env.secret === 'function' ? await this.env.secret() : this.env.secret;
    const result: CommandResult = await runApprovedCommand(policy.normalized, {
      cwd: this.env.cwd,
      workspaceRoot: this.env.workspaceRoot,
      allowlist: this.env.allowlist,
      timeoutMs: this.env.timeoutMs,
      maxOutputChars: this.env.maxOutputChars,
      secret,
      trusted: this.env.trusted,
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

  async runValidationCommand(command: unknown): Promise<AgentToolResult> {
    const result = await this.runCommand(command);
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
        async execute(args) {
          return self.runCommand(args.command);
        },
      },
      {
        name: 'run_validation_command',
        description: 'Run an allowlisted validation command after explicit approval and return structured validation evidence.',
        parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
        async execute(args) {
          return self.runValidationCommand(args.command);
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
