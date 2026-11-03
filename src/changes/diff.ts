export interface UnifiedDiff {
  readonly text: string;
  readonly additions: number;
  readonly deletions: number;
  readonly truncated: boolean;
}

export interface DiffOptions {
  readonly contextLines?: number;
  readonly maxChars?: number;
}

interface DiffOp {
  readonly type: 'equal' | 'delete' | 'insert';
  readonly line: string;
  readonly oldLine: number;
  readonly newLine: number;
}

function splitLines(value: string | undefined): string[] {
  if (value === undefined || value.length === 0) {
    return [];
  }
  const lines = value.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

function fallbackOps(before: readonly string[], after: readonly string[]): DiffOp[] {
  const ops: DiffOp[] = [];
  before.forEach((line, index) => {
    ops.push({ type: 'delete', line, oldLine: index + 1, newLine: 0 });
  });
  after.forEach((line, index) => {
    ops.push({ type: 'insert', line, oldLine: 0, newLine: index + 1 });
  });
  return ops;
}

function buildOps(before: readonly string[], after: readonly string[]): DiffOp[] {
  const oldLength = before.length;
  const newLength = after.length;

  let prefix = 0;
  while (prefix < oldLength && prefix < newLength && before[prefix] === after[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < oldLength - prefix &&
    suffix < newLength - prefix &&
    before[oldLength - 1 - suffix] === after[newLength - 1 - suffix]
  ) {
    suffix += 1;
  }

  const oldMiddle = before.slice(prefix, oldLength - suffix);
  const newMiddle = after.slice(prefix, newLength - suffix);

  const ops: DiffOp[] = [];
  for (let index = 0; index < prefix; index += 1) {
    ops.push({
      type: 'equal',
      line: before[index],
      oldLine: index + 1,
      newLine: index + 1,
    });
  }

  if (oldMiddle.length * newMiddle.length > 4_000_000) {
    ops.push(...fallbackOps(oldMiddle, newMiddle));
  } else {
    const rows = oldMiddle.length;
    const cols = newMiddle.length;
    const table: Uint32Array[] = Array.from(
      { length: rows + 1 },
      () => new Uint32Array(cols + 1),
    );
    for (let row = rows - 1; row >= 0; row -= 1) {
      for (let col = cols - 1; col >= 0; col -= 1) {
        table[row][col] =
          oldMiddle[row] === newMiddle[col]
            ? table[row + 1][col + 1] + 1
            : Math.max(table[row + 1][col], table[row][col + 1]);
      }
    }

    let row = 0;
    let col = 0;
    while (row < rows && col < cols) {
      if (oldMiddle[row] === newMiddle[col]) {
        ops.push({
          type: 'equal',
          line: oldMiddle[row],
          oldLine: prefix + row + 1,
          newLine: prefix + col + 1,
        });
        row += 1;
        col += 1;
      } else if (table[row + 1][col] >= table[row][col + 1]) {
        ops.push({
          type: 'delete',
          line: oldMiddle[row],
          oldLine: prefix + row + 1,
          newLine: 0,
        });
        row += 1;
      } else {
        ops.push({
          type: 'insert',
          line: newMiddle[col],
          oldLine: 0,
          newLine: prefix + col + 1,
        });
        col += 1;
      }
    }
    while (row < rows) {
      ops.push({
        type: 'delete',
        line: oldMiddle[row],
        oldLine: prefix + row + 1,
        newLine: 0,
      });
      row += 1;
    }
    while (col < cols) {
      ops.push({
        type: 'insert',
        line: newMiddle[col],
        oldLine: 0,
        newLine: prefix + col + 1,
      });
      col += 1;
    }
  }

  for (let index = 0; index < suffix; index += 1) {
    ops.push({
      type: 'equal',
      line: after[newLength - suffix + index],
      oldLine: oldLength - suffix + index + 1,
      newLine: newLength - suffix + index + 1,
    });
  }

  return ops;
}

function hunkHeader(ops: readonly DiffOp[], start: number, end: number): string {
  let oldStart = 0;
  let newStart = 0;
  let oldCount = 0;
  let newCount = 0;

  for (let index = start; index < end; index += 1) {
    const op = ops[index];
    if (op.type !== 'insert') {
      oldCount += 1;
      if (oldStart === 0) {
        oldStart = op.oldLine;
      }
    }
    if (op.type !== 'delete') {
      newCount += 1;
      if (newStart === 0) {
        newStart = op.newLine;
      }
    }
  }

  if (oldCount === 0) {
    oldStart = start > 0 ? ops[start - 1].oldLine : 0;
  }
  if (newCount === 0) {
    newStart = start > 0 ? ops[start - 1].newLine : 0;
  }

  return `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`;
}

/**
 * Produces a standard unified diff without external dependencies. Very large
 * edits fall back to a whole-file replacement so diffing stays bounded.
 */
export function createUnifiedDiff(
  path: string,
  before: string | undefined,
  after: string | undefined,
  beforePath = path,
  options: DiffOptions = {},
): UnifiedDiff {
  const context = Math.max(0, Math.min(12, options.contextLines ?? 3));
  const maxChars = Math.max(1_000, options.maxChars ?? 200_000);
  const oldLines = splitLines(before);
  const newLines = splitLines(after);
  const ops = buildOps(oldLines, newLines);

  let additions = 0;
  let deletions = 0;
  for (const op of ops) {
    if (op.type === 'insert') {
      additions += 1;
    } else if (op.type === 'delete') {
      deletions += 1;
    }
  }

  const changed = ops
    .map((op, index) => (op.type === 'equal' ? -1 : index))
    .filter((index) => index >= 0);

  const sections: string[] = [
    before === undefined ? '--- /dev/null' : `--- a/${beforePath}`,
    after === undefined ? '+++ /dev/null' : `+++ b/${path}`,
  ];

  if (changed.length > 0) {
    const ranges: { start: number; end: number }[] = [];
    for (const index of changed) {
      const start = Math.max(0, index - context);
      const end = Math.min(ops.length, index + context + 1);
      const previous = ranges[ranges.length - 1];
      if (previous !== undefined && start <= previous.end) {
        previous.end = Math.max(previous.end, end);
      } else {
        ranges.push({ start, end });
      }
    }

    for (const range of ranges) {
      sections.push(hunkHeader(ops, range.start, range.end));
      for (let index = range.start; index < range.end; index += 1) {
        const op = ops[index];
        if (op.type === 'equal') {
          sections.push(` ${op.line}`);
        } else if (op.type === 'delete') {
          sections.push(`-${op.line}`);
        } else {
          sections.push(`+${op.line}`);
        }
      }
    }
  }

  let text = sections.join('\n');
  let truncated = false;
  if (text.length > maxChars) {
    text = `${text.slice(0, maxChars)}\n[QuantsMind: diff truncated at ${maxChars} characters]`;
    truncated = true;
  }

  return { text, additions, deletions, truncated };
}
