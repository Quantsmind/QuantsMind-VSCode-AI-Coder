import { probeToolchain } from '../build/toolchain';
import { detectBuildAdapters, resolveKarkainEntry } from '../build/adapters';
import { parseTestOutput, type TestOutputFormat } from '../build/testOutput';
import { parseSourceDiagnostics } from '../diagnostics/sourceDiagnostics';
import type { BuildAdapterDetection } from '../build/types';
import type { CommandTools } from './commandTools';
import type { AgentTool, AgentToolResult } from './codingAgent';
import type { WorkspaceEntry } from '../workspace/analyze';
import type { ExecutionService } from '../execution/service';

export interface BuildToolEnvironment {
  readonly trusted: () => boolean;
  readonly entries: () => Promise<readonly WorkspaceEntry[]>;
  readonly configContents?: () => Promise<Readonly<Record<string, string>>>;
  readonly commandTools: CommandTools;
  readonly executionService?: ExecutionService;
}

interface DetectedAdapterView {
  readonly id: string;
  readonly ecosystem: string;
  readonly configFile: string;
  readonly languages: readonly string[];
  readonly buildCommands: readonly string[];
  readonly testCommands: readonly string[];
  readonly toolchainAvailable: boolean;
  readonly toolchainVersion?: string;
}

function fail(tool: string, error: string): AgentToolResult {
  return { ok: false, tool, error, durationMs: 0 };
}

function stepOutput(raw: string | undefined): string {
  if (typeof raw !== 'string') {
    return '';
  }
  try {
    const parsed = JSON.parse(raw) as { output?: string };
    return typeof parsed.output === 'string' ? parsed.output : raw;
  } catch {
    return raw;
  }
}

function stepExitCode(raw: string | undefined): number | null {
  if (typeof raw !== 'string') {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as { exitCode?: number | null };
    return typeof parsed.exitCode === 'number' ? parsed.exitCode : null;
  } catch {
    return null;
  }
}

/**
 * Bridges the model to the build-system adapters. Execution always flows
 * through the shared command tools (allowlist + approval + runner + history);
 * this class only detects, recommends and sequences — it never shells out
 * directly or bypasses the permission model.
 */
export class BuildTools {
  constructor(private readonly env: BuildToolEnvironment) {}

  private async detect(): Promise<{
    views: DetectedAdapterView[];
    detections: readonly BuildAdapterDetection[];
  }> {
    const entries = await this.env.entries();
    const configContents = (await this.env.configContents?.()) ?? {};
    const detections = detectBuildAdapters(entries, configContents);
    const karkainEntry = resolveKarkainEntry(entries);
    const views: DetectedAdapterView[] = [];
    for (const { adapter, configFile } of detections) {
      const toolchain = adapter.toolchain === undefined ? undefined : await probeToolchain(adapter.toolchain);
      views.push({
        id: adapter.id,
        ecosystem: adapter.ecosystem,
        configFile,
        languages: adapter.languages,
        buildCommands: adapter.buildCommands({ karkainEntry }),
        testCommands: adapter.testCommands({ karkainEntry }),
        toolchainAvailable: toolchain?.available ?? true,
        ...(toolchain?.version !== undefined ? { toolchainVersion: toolchain.version } : {}),
      });
    }
    return { views, detections };
  }

  async detectBuildSystem(): Promise<AgentToolResult> {
    if (!this.env.trusted()) {
      return fail('detect_build_system', 'Workspace trust is required to inspect build systems.');
    }
    try {
      const { views } = await this.detect();
      return {
        ok: true,
        tool: 'detect_build_system',
        output: JSON.stringify({ detected: views, count: views.length }, null, 2),
        durationMs: 0,
      };
    } catch (error) {
      return fail('detect_build_system', error instanceof Error ? error.message : 'Build detection failed.');
    }
  }

  async getToolchain(): Promise<AgentToolResult> {
    if (!this.env.trusted()) {
      return fail('get_toolchain', 'Workspace trust is required to probe toolchains.');
    }
    try {
      const { views } = await this.detect();
      const toolchains = views.map(({ id, toolchainAvailable, toolchainVersion }) => ({
        adapter: id,
        available: toolchainAvailable,
        ...(toolchainVersion !== undefined ? { version: toolchainVersion } : {}),
        detail: toolchainAvailable ? 'available' : 'not found on PATH',
      }));
      return {
        ok: true,
        tool: 'get_toolchain',
        output: JSON.stringify({ toolchains }, null, 2),
        durationMs: 0,
      };
    } catch (error) {
      return fail('get_toolchain', error instanceof Error ? error.message : 'Toolchain probe failed.');
    }
  }

  private async runSequence(
    tool: string,
    kind: 'build' | 'test',
    requestedAdapter: unknown,
    signal?: AbortSignal,
  ): Promise<AgentToolResult> {
    if (!this.env.trusted()) {
      return fail(tool, 'Workspace trust is required to run commands.');
    }
    let detections: readonly BuildAdapterDetection[];
    try {
      const detected = await this.detect();
      detections = detected.detections;
    } catch (error) {
      return fail(tool, error instanceof Error ? error.message : 'Build detection failed.');
    }
    const requestedId = typeof requestedAdapter === 'string' && requestedAdapter.trim().length > 0
      ? requestedAdapter.trim().toLowerCase()
      : undefined;
    const selected = requestedId === undefined
      ? detections[0]
      : detections.find((candidate) => candidate.adapter.id === requestedId);
    if (selected === undefined) {
      const ids = detections.map((candidate) => candidate.adapter.id).join(', ') || '(none)';
      return fail(
        tool,
        requestedId === undefined
          ? `No build system detected in this workspace. Detected: ${ids}.`
          : `Build adapter "${requestedId}" is not detected here. Detected: ${ids}.`,
      );
    }

    const entries = await this.env.entries();
    const karkainEntry = resolveKarkainEntry(entries);
    const adapter = selected.adapter;
    const commands = kind === 'build'
      ? adapter.buildCommands({ karkainEntry })
      : adapter.testCommands({ karkainEntry });
    if (commands.length === 0) {
      return fail(tool, `The ${adapter.id} adapter does not define ${kind} commands.`);
    }
    const format: TestOutputFormat = adapter.testOutputFormat;

    const steps: { command: string; ok: boolean; exitCode: number | null; durationMs: number; output: string }[] = [];
    let combined = '';
    let totalDuration = 0;
    for (const command of commands) {
      if (signal?.aborted === true) {
        return fail(tool, 'The operation was cancelled before a command started.');
      }
      const step = await this.env.commandTools.runCommand(command, undefined, signal, {
        kind,
        ...(kind === 'test' ? { testFormat: format } : {}),
      });
      const output = stepOutput(step.output);
      combined += `\n$ ${command}\n${output}`;
      const exitCode = stepExitCode(step.output);
      steps.push({ command, ok: step.ok, exitCode, durationMs: step.durationMs, output });
      totalDuration += step.durationMs;
      if (!step.ok) {
        const diagnostics = parseSourceDiagnostics(combined, kind === 'build' ? 'build' : 'test');
        const tests = kind === 'test' ? parseTestOutput(combined, format) : undefined;
        return {
          ok: false,
          tool,
          error: step.error ?? `Step failed for ${adapter.id}: ${command}`,
          output: JSON.stringify(
            { adapter: adapter.id, steps, diagnostics, ...(tests !== undefined ? { tests } : {}) },
            null,
            2,
          ),
          durationMs: totalDuration,
        };
      }
    }

    const diagnostics = parseSourceDiagnostics(combined, kind === 'build' ? 'build' : 'test');
    const tests = kind === 'test' ? parseTestOutput(combined, format) : undefined;
    return {
      ok: true,
      tool,
      output: JSON.stringify(
        { adapter: adapter.id, steps, diagnostics, ...(tests !== undefined ? { tests } : {}) },
        null,
        2,
      ),
      durationMs: totalDuration,
    };
  }

  async runBuild(args: { adapter?: unknown }, signal?: AbortSignal): Promise<AgentToolResult> {
    return this.runSequence('run_build', 'build', args.adapter, signal);
  }

  async runTests(args: { adapter?: unknown }, signal?: AbortSignal): Promise<AgentToolResult> {
    return this.runSequence('run_tests', 'test', args.adapter, signal);
  }

  toAgentTools(): readonly AgentTool[] {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return [
      {
        name: 'detect_build_system',
        description:
          'Detect the build system from project files (package.json, pom.xml, go.mod, CMakeLists.txt, karkain.toml, ...) and report toolchain availability without running anything.',
        parameters: { type: 'object', properties: {} },
        async execute() {
          return self.detectBuildSystem();
        },
      },
      {
        name: 'get_toolchain',
        description: 'Probe toolchain executables and report versions or honest unavailability.',
        parameters: { type: 'object', properties: {} },
        async execute() {
          return self.getToolchain();
        },
      },
      {
        name: 'run_build',
        description:
          'Run the detected build adapter (npm, mvn, go, cmake, dotnet, cargo, karkain, ...) after per-command approval. Pass adapter when several are detected.',
        parameters: {
          type: 'object',
          properties: { adapter: { type: 'string' } },
        },
        async execute(args, context) {
          return self.runBuild({ adapter: args.adapter }, context?.signal);
        },
      },
      {
        name: 'run_tests',
        description:
          'Run the detected adapter test command (npm test, pytest, go test, ctest, karkain test, ...) after per-command approval. Pass adapter when several are detected.',
        parameters: {
          type: 'object',
          properties: { adapter: { type: 'string' } },
        },
        async execute(args, context) {
          return self.runTests({ adapter: args.adapter }, context?.signal);
        },
      },
    ];
  }
}

export const BUILD_TOOL_NAMES = ['detect_build_system', 'get_toolchain', 'run_build', 'run_tests'];
