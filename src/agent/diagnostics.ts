import { redactSecrets } from '../security/redact';
import {
  clampText,
  type Diagnostic,
  type DiagnosticSource,
  type ValidationRun,
} from './models';

export interface IDiagnosticsService {
  analyze(run: ValidationRun): readonly Diagnostic[];
}

const MAX_DIAGNOSTICS = 20;
const MAX_WARNINGS = 5;

function sourceFor(command: string): DiagnosticSource {
  const lower = command.toLowerCase();
  if (/\blint\b|eslint|biome|ruff/.test(lower)) {
    return 'lint';
  }
  if (/\btypecheck\b|\btype-check\b|\btsc\b|\bmypy\b/.test(lower)) {
    return 'typecheck';
  }
  if (/\btest\b|\bspec\b|mocha|jest|vitest|pytest/.test(lower)) {
    return 'test';
  }
  if (/\bbuild\b|\bcompile\b|\bverify\b/.test(lower)) {
    return 'build';
  }
  return 'runtime';
}

function clean(line: string): string {
  return clampText(redactSecrets(line, []).text.trim(), 2_000);
}

interface ParsedLine {
  readonly message: string;
  readonly file?: string;
  readonly line?: number;
}

function parseLine(raw: string): ParsedLine | undefined {
  const line = raw.trim();
  if (line.length === 0) {
    return undefined;
  }

  const typescript = /^(.+?\.(?:ts|tsx|js|jsx|mts|cts))\((\d+),\d+\):\s+error\s+(TS\d+:\s+.+)$/i.exec(line);
  if (typescript !== null) {
    return {
      file: clean(typescript[1]),
      line: Number(typescript[2]),
      message: clean(typescript[3]),
    };
  }

  const compact = /^(.+?\.(?:[A-Za-z0-9]+)):(\d+):(\d+)\s+error\s+(.+)$/i.exec(line);
  if (compact !== null) {
    return {
      file: clean(compact[1]),
      line: Number(compact[2]),
      message: clean(compact[4]),
    };
  }

  const withLine = /^((?:[A-Za-z]:)?[^:\n]+?\.\w+):(\d+)(?::\d+)?:?\s+(?:error|failed)\b\s*:?\s*(.+)$/i.exec(
    line,
  );
  if (withLine !== null) {
    return {
      file: clean(withLine[1]),
      line: Number(withLine[2]),
      message: clean(withLine[3]),
    };
  }

  const assertion = /AssertionError(?::\s*(.+))?/i.exec(line);
  if (assertion !== null && assertion[1] !== undefined) {
    return { message: clean(assertion[1]) };
  }

  const fail = /^FAIL\s+(.+)$/.exec(line);
  if (fail !== null) {
    return { file: clean(fail[1]), message: 'The test file failed.' };
  }

  return undefined;
}

/**
 * Converts real command evidence into diagnostics. It never asks a model what
 * the failure might be and never invents a file or line number.
 */
export function analyzeValidationFailure(run: ValidationRun): Diagnostic[] {
  const evidence = run.evidence;
  if (evidence === undefined || evidence.passed || evidence.cancelled) {
    return [];
  }

  const source = sourceFor(evidence.command);
  const diagnostics: Diagnostic[] = [];
  const seen = new Set<string>();

  const push = (diagnostic: Omit<Diagnostic, 'id' | 'source' | 'command'>): void => {
    const key = `${diagnostic.file ?? ''}:${diagnostic.line ?? ''}:${diagnostic.message}`;
    if (seen.has(key) || diagnostics.length >= MAX_DIAGNOSTICS) {
      return;
    }
    seen.add(key);
    diagnostics.push({
      id: `diag-${diagnostics.length + 1}`,
      source,
      command: evidence.command,
      ...diagnostic,
    });
  };

  if (evidence.error !== undefined && evidence.error.trim().length > 0) {
    push({ severity: 'error', message: clean(evidence.error) });
  }
  if (evidence.timedOut) {
    push({
      severity: 'error',
      message: `The validation command timed out after ${evidence.durationMs} ms.`,
    });
  }

  const lines = evidence.output.split(/\r?\n/);
  for (const line of lines) {
    const parsed = parseLine(line);
    if (parsed !== undefined) {
      push({ severity: 'error', ...parsed });
    }
  }

  if (diagnostics.length === 0) {
    const tail = lines
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .slice(-5)
      .join(' ');
    push({
      severity: 'error',
      message:
        evidence.exitCode === null
          ? `The validation command did not start.${tail.length > 0 ? ` Output: ${clean(tail)}` : ''}`
          : `The validation command exited with code ${evidence.exitCode}.${
              tail.length > 0 ? ` Output: ${clean(tail)}` : ''
            }`,
    });
  }

  let warnings = 0;
  for (const line of lines) {
    if (warnings >= MAX_WARNINGS || diagnostics.length >= MAX_DIAGNOSTICS) {
      break;
    }
    if (/\bwarning\b/i.test(line) && !/\berror\b/i.test(line)) {
      const message = clean(line);
      if (message.length > 0) {
        push({ severity: 'warning', message });
        warnings += 1;
      }
    }
  }

  return diagnostics;
}

export class DiagnosticsService implements IDiagnosticsService {
  analyze(run: ValidationRun): readonly Diagnostic[] {
    return analyzeValidationFailure(run);
  }
}
