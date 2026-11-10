import type { Diagnostic, DiagnosticSource } from '../agent/models';

export interface ParsedDiagnostic {
  readonly file?: string;
  readonly line?: number;
  readonly column?: number;
  readonly severity: 'error' | 'warning' | 'info';
  readonly message: string;
}

const TS_PATTERN = /^(.+?)\((\d+),(\d+)\)?[:,]\s*(error|warning|info)\s*(TS\d+|[A-Z]{2}\d+)?:?\s*(.+)$/;
const JC_PATTERN = /^(?:\[ERROR\]\s*)?((?:\S|\s(?!\s))+?\.(?:java|kt|kts|dsc|groovy)):(?:\[)?(\d+)(?::|,)(\d+)(?:\])?\s*error:?\s*(.+)$/;
const CC_PATTERN = /^([^\s:][^:\n]*\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx|rs|go|m|mm))[:,](\d+)(?::|,)(\d+)\s*(?:[-:]\s*)?(error|warning|info)\s*:?\s*(.*)$/;
const GENERIC_COLON = /^([^\s:][^:\n]*\.[A-Za-z0-9]{1,12}):(\d+)(?::(\d+))?\s*[-:]\s*(error|warning|info)\s*:?\s*(.*)$/i;
const GOMODE = /^\.?[/\\]?([^\s:]+\.go)[:,](\d+)(?::|,)(\d+)\s*[-:]\s*(.+)$/;
const PY_LINE = /File "([^"]+)", line (\d+)/;
const PY_ERR = /(?:^|\b)(\w*(?:Error|Exception)|error)[:\s]+(.+)$/;
const KARKAIN_LOC = /^([^\s:][^:\n]+\.kark)[:,](\d+)(?::(\d+))?\s*[-:]\s*(error|warning|info)\s*:?\s*(.*)$/i;
const KARKAIN_LINE = /^\[(error|warning|info)[^\]]*\]\s*(?:line\s*)?(\d+)[:\]]\s*(.*)$/i;
const RUST_HEADER = /^(error|warning)(?:\[E\d+\])?:\s*(.+)$/;
const RUST_LOC = /^\s*-->\s*(\S+):(\d+):(\d+)/;
const XCOLON = /^([^\s:][^:\n]*\.[A-Za-z0-9]{1,12}):(\d+)(?::(\d+))?\s*[-:]\s*(.*)$/;

function severityOf(word: string | undefined): 'error' | 'warning' | 'info' {
  const value = (word ?? '').toLowerCase();
  if (value === 'warning') {
    return 'warning';
  }
  if (value === 'info' || value === 'note') {
    return 'info';
  }
  return 'error';
}

function lineOf(value: string | undefined): number | undefined {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function bounded(value: string): string {
  return value.trim().slice(0, 500);
}

/**
 * Best-effort extraction of `file:line:column` diagnostics from compiler and
 * test output. Confirmed matches become `Diagnostic`s; anything unparsable is
 * skipped rather than guessed.
 */
export function parseSourceDiagnostics(output: string, source: DiagnosticSource = 'build'): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const lines = output.split(/\r?\n/).slice(0, 4_000);
  let sequence = 0;
  const push = (parsed: ParsedDiagnostic): void => {
    if (diagnostics.length >= 100 || parsed.message.length === 0) {
      return;
    }
    sequence += 1;
    diagnostics.push({
      id: `diag-${sequence}`,
      severity: parsed.severity,
      source,
      message: bounded(parsed.message),
      ...(parsed.file !== undefined ? { file: parsed.file } : {}),
      ...(parsed.line !== undefined ? { line: parsed.line } : {}),
      ...(parsed.column !== undefined ? { column: parsed.column } : {}),
    });
  };

  const pendingRust: { severity: 'error' | 'warning' | 'info'; message: string }[] = [];

  for (const rawLine of lines) {
    const line = rawLine.slice(0, 2_000);

    // Rust uses a header line followed by a location line.
    const rust = RUST_HEADER.exec(line.trim());
    if (rust !== null) {
      pendingRust.push({ severity: severityOf(rust[1]), message: rust[2] ?? '' });
      continue;
    }
    const rustLoc = RUST_LOC.exec(line);
    if (rustLoc !== null && pendingRust.length > 0) {
      const pending = pendingRust.shift() as { severity: 'error' | 'warning' | 'info'; message: string };
      push({
        file: rustLoc[1],
        line: lineOf(rustLoc[2]),
        column: lineOf(rustLoc[3]),
        severity: pending.severity,
        message: pending.message,
      });
      continue;
    }

    let match = TS_PATTERN.exec(line);
    if (match !== null) {
      push({
        file: match[1],
        line: lineOf(match[2]),
        column: lineOf(match[3]),
        severity: severityOf(match[4]),
        message: match[6] ?? '',
      });
      continue;
    }

    match = JC_PATTERN.exec(line);
    if (match !== null) {
      push({
        file: match[1].replace(/^\/?/, ''),
        line: lineOf(match[2]),
        column: lineOf(match[3]),
        severity: 'error',
        message: match[4] ?? '',
      });
      continue;
    }

    match = CC_PATTERN.exec(line);
    if (match !== null) {
      push({ file: match[1], line: lineOf(match[2]), column: lineOf(match[3]), severity: severityOf(match[4]), message: match[5] ?? '' });
      continue;
    }

    match = KARKAIN_LOC.exec(line);
    if (match !== null) {
      push({ file: match[1], line: lineOf(match[2]), column: lineOf(match[3]), severity: severityOf(match[4]), message: match[5] ?? '' });
      continue;
    }

    match = KARKAIN_LINE.exec(line);
    if (match !== null) {
      push({ line: lineOf(match[2]), severity: severityOf(match[1]), message: match[3] ?? '' });
      continue;
    }

    match = GOMODE.exec(line);
    if (match !== null) {
      push({ file: match[1], line: lineOf(match[2]), column: lineOf(match[3]), severity: 'error', message: match[4] ?? '' });
      continue;
    }

    match = GENERIC_COLON.exec(line);
    if (match !== null) {
      push({ file: match[1], line: lineOf(match[2]), column: lineOf(match[3]), severity: severityOf(match[4]), message: match[5] ?? '' });
      continue;
    }

    match = XCOLON.exec(line);
    if (match !== null && /\berror\b|\bwarning\b|\bfail|\bexception/i.test(match[4] ?? '')) {
      push({ file: match[1], line: lineOf(match[2]), column: lineOf(match[3]), severity: 'error', message: match[4] ?? '' });
      continue;
    }

    const pyLine = PY_LINE.exec(line);
    if (pyLine !== null) {
      // The message lives on the next non-empty line; handle it greedily.
      push({ file: pyLine[1], line: lineOf(pyLine[2]), severity: 'error', message: 'Python traceback frame (see following lines)' });
      continue;
    }

    const pyErr = PY_ERR.exec(line);
    if (pyErr !== null) {
      push({ severity: 'error', message: `${pyErr[1]}: ${pyErr[2] ?? ''}` });
    }
  }

  return diagnostics;
}
