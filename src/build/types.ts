import type { TestOutputFormat } from './testOutput';
import type { WorkspaceEntry } from '../workspace/analyze';

export interface ToolchainProbe {
  readonly name: string;
  readonly executable: string;
  readonly versionArgs: readonly string[];
}

export interface ToolchainInfo {
  readonly available: boolean;
  readonly name: string;
  readonly version?: string;
  readonly path?: string;
  readonly detail?: string;
}

export interface BuildCommandContext {
  /** Resolved `.kark` entry file for Karkain projects (e.g. `main.kark`). */
  readonly karkainEntry?: string;
}

export interface BuildAdapter {
  readonly id: string;
  readonly ecosystem: string;
  readonly languages: readonly string[];
  /** Path suffixes that identify this build system. */
  readonly configFiles: readonly string[];
  /** Localized detection over the collected index. */
  detect(entries: readonly WorkspaceEntry[], configContents: Readonly<Record<string, string>>): boolean;
  /** Commands that build the project, in execution order. */
  buildCommands(context?: BuildCommandContext): readonly string[];
  /** Commands that run the project's test suite, in execution order. */
  testCommands(context?: BuildCommandContext): readonly string[];
  testOutputFormat: TestOutputFormat;
  toolchain?: ToolchainProbe;
}

export interface BuildAdapterDetection {
  readonly adapter: BuildAdapter;
  readonly configFile: string;
}

export interface DetectedFramework {
  readonly id: string;
  readonly ecosystem: string;
  readonly languages: readonly string[];
  readonly configFile: string;
}

export function isDetection(detection: BuildAdapterDetection | undefined): detection is BuildAdapterDetection {
  return detection !== undefined;
}
