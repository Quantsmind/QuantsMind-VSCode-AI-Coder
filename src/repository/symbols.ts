/**
 * Lightweight, dependency-free source analysis.
 *
 * This is intentionally not a compiler. Declarations and import statements are
 * extracted with conservative, line-oriented patterns; every result records
 * whether it was read directly from syntax (`confirmed`) or inferred from
 * shape and indentation (`heuristic`). Callers must not present heuristic
 * findings as certain.
 */

export type Confidence = 'confirmed' | 'heuristic';

export type SupportedLanguage =
  | 'typescript'
  | 'javascript'
  | 'python'
  | 'java'
  | 'go'
  | 'c'
  | 'cpp'
  | 'karkain';

export const SUPPORTED_LANGUAGES: readonly SupportedLanguage[] = [
  'typescript',
  'javascript',
  'python',
  'java',
  'go',
  'c',
  'cpp',
  'karkain',
];

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, SupportedLanguage>> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  java: 'java',
  go: 'go',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  hxx: 'cpp',
  kark: 'karkain',
};

const BINARY_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'bmp',
  'ico',
  'webp',
  'tif',
  'tiff',
  'pdf',
  'zip',
  'gz',
  'tar',
  'bz2',
  '7z',
  'rar',
  'exe',
  'dll',
  'so',
  'dylib',
  'class',
  'jar',
  'war',
  'o',
  'obj',
  'a',
  'lib',
  'pdb',
  'map',
  'mp3',
  'mp4',
  'mov',
  'avi',
  'wav',
  'woff',
  'woff2',
  'ttf',
  'eot',
  'wasm',
  'bin',
  'dat',
  'db',
  'sqlite',
  'lockb',
]);

export type SymbolKind =
  | 'class'
  | 'interface'
  | 'function'
  | 'method'
  | 'variable'
  | 'enum'
  | 'type'
  | 'struct'
  | 'trait'
  | 'module'
  | 'package';

export type ImportKind =
  | 'import'
  | 'require'
  | 'dynamic-import'
  | 'export-from'
  | 'include'
  | 'using'
  | 'package';

export type ExportKind = 'named' | 'default' | 're-export';

export interface SymbolInfo {
  readonly name: string;
  readonly kind: SymbolKind;
  readonly line: number;
  readonly container?: string;
  readonly exported: boolean;
  readonly confidence: Confidence;
}

export interface ImportReference {
  readonly specifier: string;
  readonly kind: ImportKind;
  readonly line: number;
  readonly names?: readonly string[];
  /** For C/C++ includes, true for quoted workspace-relative includes. */
  readonly local?: boolean;
  readonly confidence: Confidence;
}

export interface ExportInfo {
  readonly name: string;
  readonly kind: ExportKind;
  readonly line: number;
  readonly confidence: Confidence;
}

export interface FileAnalysis {
  readonly path: string;
  readonly language: SupportedLanguage;
  readonly symbols: readonly SymbolInfo[];
  readonly imports: readonly ImportReference[];
  readonly exports: readonly ExportInfo[];
  /** True for conventional public entry points and files that export symbols. */
  readonly publicApi: boolean;
  readonly contentChars: number;
  readonly truncated: boolean;
  readonly error?: string;
}

export interface AnalyzeFileOptions {
  readonly maxFileChars?: number;
  readonly maxSymbols?: number;
  readonly maxImports?: number;
  readonly maxExports?: number;
}

export const DEFAULT_ANALYZE_LIMITS = Object.freeze({
  maxFileChars: 160_000,
  maxSymbols: 200,
  maxImports: 100,
  maxExports: 100,
});

export function languageForPath(path: string): SupportedLanguage | undefined {
  const normalized = path.replace(/\\/g, '/');
  const name = normalized.split('/').pop() ?? normalized;
  const dot = name.lastIndexOf('.');
  if (dot <= 0) {
    return undefined;
  }
  return LANGUAGE_BY_EXTENSION[name.slice(dot + 1).toLowerCase()];
}

export function isSupportedSourcePath(path: string): boolean {
  return languageForPath(path) !== undefined;
}

export function isBinaryPath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/').toLowerCase();
  const name = normalized.split('/').pop() ?? normalized;
  const dot = name.lastIndexOf('.');
  if (dot <= 0) {
    return false;
  }
  return BINARY_EXTENSIONS.has(name.slice(dot + 1));
}

export function isIndexLikePath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/').toLowerCase();
  return (
    /(^|\/)index\.(?:[cm]?[jt]sx?)$/.test(normalized) ||
    /(^|\/)__init__\.py$/.test(normalized) ||
    /(^|\/)main\.(?:py|go|rs|c|cc|cpp|kark)$/.test(normalized) ||
    /(^|\/)extension\.[cm]?ts$/.test(normalized)
  );
}

function splitLines(content: string): string[] {
  return content.split(/\r?\n/);
}

function lineStarts(content: string): number[] {
  const starts = [0];
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === '\n') {
      starts.push(index + 1);
    }
  }
  return starts;
}

function lineAt(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const start = starts[middle] ?? 0;
    const next = starts[middle + 1] ?? Number.MAX_SAFE_INTEGER;
    if (offset < start) {
      high = middle - 1;
    } else if (offset >= next) {
      low = middle + 1;
    } else {
      return middle + 1;
    }
  }
  return Math.max(1, starts.length);
}

/**
 * Replaces comment characters with spaces while leaving strings and line
 * breaks intact, so line numbers and quoted import specifiers stay correct.
 */
function maskComments(source: string): string {
  let result = '';
  let state: 'normal' | 'line' | 'block' | 'single' | 'double' | 'template' = 'normal';
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? '';
    const next = source[index + 1];
    if (state === 'normal') {
      if (character === '/' && next === '/') {
        state = 'line';
        result += '  ';
        index += 1;
      } else if (character === '/' && next === '*') {
        state = 'block';
        result += '  ';
        index += 1;
      } else {
        if (character === "'") {
          state = 'single';
        } else if (character === '"') {
          state = 'double';
        } else if (character === '`') {
          state = 'template';
        }
        result += character;
      }
      continue;
    }
    if (state === 'line') {
      if (character === '\n') {
        state = 'normal';
        result += character;
      } else {
        result += ' ';
      }
      continue;
    }
    if (state === 'block') {
      if (character === '*' && next === '/') {
        state = 'normal';
        result += '  ';
        index += 1;
      } else {
        result += character === '\n' ? '\n' : ' ';
      }
      continue;
    }
    // String state: keep escapes and let the closing quote return to code.
    result += character;
    if (character === '\\') {
      const escaped = source[index + 1];
      if (escaped !== undefined) {
        result += escaped;
        index += 1;
      }
    } else if (
      (state === 'single' && character === "'") ||
      (state === 'double' && character === '"') ||
      (state === 'template' && character === '`')
    ) {
      state = 'normal';
    }
  }
  return result;
}

function pushSymbol(
  symbols: SymbolInfo[],
  max: number,
  symbol: SymbolInfo,
): void {
  if (symbols.length < max) {
    symbols.push(symbol);
  }
}

function pushImport(
  imports: ImportReference[],
  max: number,
  reference: ImportReference,
): void {
  if (imports.length < max) {
    imports.push(reference);
  }
}

function pushExport(
  exportsList: ExportInfo[],
  max: number,
  item: ExportInfo,
): void {
  if (exportsList.length < max) {
    exportsList.push(item);
  }
}

interface AnalysisAccumulator {
  readonly symbols: SymbolInfo[];
  readonly imports: ImportReference[];
  readonly exports: ExportInfo[];
  readonly maxSymbols: number;
  readonly maxImports: number;
  readonly maxExports: number;
}

const CONTROL_WORDS = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'return',
  'sizeof',
  'typeof',
  'new',
  'delete',
  'throw',
  'else',
  'do',
  'try',
  'finally',
  'with',
]);

function addImport(
  accumulator: AnalysisAccumulator,
  specifier: string,
  kind: ImportKind,
  line: number,
  confidence: Confidence,
  names?: readonly string[],
  local?: boolean,
): void {
  pushImport(accumulator.imports, accumulator.maxImports, {
    specifier,
    kind,
    line,
    names,
    local,
    confidence,
  });
}

function addSymbol(
  accumulator: AnalysisAccumulator,
  name: string,
  kind: SymbolKind,
  line: number,
  exported: boolean,
  confidence: Confidence,
  container?: string,
): void {
  if (name.length === 0 || name.length > 120 || CONTROL_WORDS.has(name)) {
    return;
  }
  pushSymbol(accumulator.symbols, accumulator.maxSymbols, {
    name,
    kind,
    line,
    exported,
    confidence,
    container,
  });
}

function addExport(
  accumulator: AnalysisAccumulator,
  name: string,
  kind: ExportKind,
  line: number,
  confidence: Confidence,
): void {
  pushExport(accumulator.exports, accumulator.maxExports, { name, kind, line, confidence });
}

function analyzeTypeScript(
  masked: string,
  accumulator: AnalysisAccumulator,
): void {
  const starts = lineStarts(masked);
  const importFrom = /^\s*(?:import|export)\b[^;'"]*?\bfrom\s*['"]([^'"]+)['"]/gm;
  let match: RegExpExecArray | null;
  while ((match = importFrom.exec(masked)) !== null) {
    const isExport = /^\s*export\b/.test(match[0]);
    addImport(
      accumulator,
      match[1] ?? '',
      isExport ? 'export-from' : 'import',
      lineAt(starts, match.index),
      'confirmed',
    );
  }
  const sideEffect = /^\s*import\s*['"]([^'"]+)['"]/gm;
  while ((match = sideEffect.exec(masked)) !== null) {
    addImport(accumulator, match[1] ?? '', 'import', lineAt(starts, match.index), 'confirmed');
  }
  const callImport = /\b(require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = callImport.exec(masked)) !== null) {
    addImport(
      accumulator,
      match[2] ?? '',
      match[1] === 'require' ? 'require' : 'dynamic-import',
      lineAt(starts, match.index),
      'confirmed',
    );
  }

  const declaration =
    /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(class|interface|enum|type|namespace|module)\s+([A-Za-z_$][\w$]*)/gm;
  while ((match = declaration.exec(masked)) !== null) {
    const keyword = match[1] ?? '';
    const name = match[2] ?? '';
    const exported = /^\s*export\b/.test(match[0]) || /^\s*export\s+default\b/.test(match[0]);
    const kind: SymbolKind =
      keyword === 'class'
        ? 'class'
        : keyword === 'interface'
          ? 'interface'
          : keyword === 'enum'
            ? 'enum'
            : keyword === 'type'
              ? 'type'
              : 'module';
    addSymbol(accumulator, name, kind, lineAt(starts, match.index), exported, 'confirmed');
    if (exported) {
      addExport(accumulator, name, /^\s*export\s+default\b/.test(match[0]) ? 'default' : 'named', lineAt(starts, match.index), 'confirmed');
    }
  }

  const functions = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/gm;
  while ((match = functions.exec(masked)) !== null) {
    const exported = /^\s*export\b/.test(match[0]);
    addSymbol(accumulator, match[1] ?? '', 'function', lineAt(starts, match.index), exported, 'confirmed');
    if (exported) {
      addExport(accumulator, match[1] ?? '', 'named', lineAt(starts, match.index), 'confirmed');
    }
  }

  const arrow =
    /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*(?:async\s*)?(?:\([^)\n]*\)|[A-Za-z_$][\w$]*)\s*=>/gm;
  while ((match = arrow.exec(masked)) !== null) {
    const exported = /^\s*export\b/.test(match[0]);
    addSymbol(accumulator, match[1] ?? '', 'function', lineAt(starts, match.index), exported, 'heuristic');
    if (exported) {
      addExport(accumulator, match[1] ?? '', 'named', lineAt(starts, match.index), 'confirmed');
    }
  }

  const variables = /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm;
  while ((match = variables.exec(masked)) !== null) {
    const exported = /^\s*export\b/.test(match[0]);
    addSymbol(accumulator, match[1] ?? '', 'variable', lineAt(starts, match.index), exported, 'heuristic');
    if (exported) {
      addExport(accumulator, match[1] ?? '', 'named', lineAt(starts, match.index), 'confirmed');
    }
  }

  const methods =
    /^\s{2,}(?:(?:public|private|protected|static|readonly|async|override|abstract|get|set|declare)\s+)*(?:#?([A-Za-z_$][\w$]*))\s*(?:<[^>\n]+>\s*)?\([^;\n]*\)\s*(?::[^{\n]+)?\{/gm;
  while ((match = methods.exec(masked)) !== null) {
    addSymbol(accumulator, match[1] ?? '', 'method', lineAt(starts, match.index), false, 'heuristic');
  }

  const namedExport = /^\s*export\s*\{([^}]*)\}/gm;
  while ((match = namedExport.exec(masked)) !== null) {
    for (const part of (match[1] ?? '').split(',')) {
      const name = part
        .trim()
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/)
        .pop()
        ?.trim();
      if (name !== undefined && /^[A-Za-z_$][\w$]*$/.test(name)) {
        addExport(accumulator, name, /from\s*['"]/.test(match[0]) ? 're-export' : 'named', lineAt(starts, match.index), 'confirmed');
      }
    }
  }

  const defaultExport = /^\s*export\s+default\b/gm;
  while ((match = defaultExport.exec(masked)) !== null) {
    addExport(accumulator, 'default', 'default', lineAt(starts, match.index), 'confirmed');
  }

  const commonJs = /^\s*module\.exports\s*=/gm;
  while ((match = commonJs.exec(masked)) !== null) {
    addExport(accumulator, 'module.exports', 'default', lineAt(starts, match.index), 'heuristic');
  }
  const commonJsNamed = /^\s*exports\.([A-Za-z_$][\w$]*)\s*=/gm;
  while ((match = commonJsNamed.exec(masked)) !== null) {
    addExport(accumulator, match[1] ?? '', 'named', lineAt(starts, match.index), 'heuristic');
  }
}

function analyzePython(
  masked: string,
  accumulator: AnalysisAccumulator,
): void {
  const starts = lineStarts(masked);
  const lines = splitLines(masked);
  const classByIndent: { readonly indent: number; readonly name: string }[] = [];

  const importLine = /^(\s*)import\s+([^\n#]+)/gm;
  let match: RegExpExecArray | null;
  while ((match = importLine.exec(masked)) !== null) {
    for (const part of (match[2] ?? '').split(',')) {
      const specifier = part.trim().split(/\s+as\s+/)[0]?.trim();
      if (specifier !== undefined && specifier.length > 0) {
        addImport(accumulator, specifier, 'import', lineAt(starts, match.index), 'confirmed');
      }
    }
  }
  const fromLine = /^(\s*)from\s+([.\w]+)\s+import\s+([^\n#]+)/gm;
  while ((match = fromLine.exec(masked)) !== null) {
    const specifier = match[2] ?? '';
    const names = (match[3] ?? '')
      .replace(/[()]/g, '')
      .split(',')
      .map((part) => part.trim().split(/\s+as\s+/)[0]?.trim() ?? '')
      .filter((name) => name.length > 0 && name !== '*');
    addImport(accumulator, specifier, 'import', lineAt(starts, match.index), 'confirmed', names);
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const lineNumber = index + 1;
    const indent = (line.match(/^\s*/)?.[0] ?? '').length;
    while (classByIndent.length > 0 && (classByIndent[classByIndent.length - 1]?.indent ?? -1) >= indent) {
      classByIndent.pop();
    }
    const classMatch = /^(\s*)class\s+([A-Za-z_]\w*)/.exec(line);
    if (classMatch !== null) {
      const name = classMatch[2] ?? '';
      const exported = /^[A-Za-z]/.test(name) && !name.startsWith('_');
      addSymbol(accumulator, name, 'class', lineNumber, exported, 'confirmed');
      classByIndent.push({ indent, name });
      if (exported) {
        addExport(accumulator, name, 'named', lineNumber, 'heuristic');
      }
      continue;
    }
    const functionMatch = /^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)/.exec(line);
    if (functionMatch !== null) {
      const name = functionMatch[2] ?? '';
      const container = classByIndent[classByIndent.length - 1]?.name;
      const exported = /^[A-Za-z]/.test(name) && !name.startsWith('_');
      addSymbol(
        accumulator,
        name,
        container === undefined ? 'function' : 'method',
        lineNumber,
        exported,
        'confirmed',
        container,
      );
      if (exported) {
        addExport(accumulator, name, 'named', lineNumber, 'heuristic');
      }
      continue;
    }
    const variableMatch = /^([A-Za-z_]\w*)\s*(?::[^=]+)?=/.exec(line);
    if (variableMatch !== null && indent === 0) {
      const name = variableMatch[1] ?? '';
      const exported = !name.startsWith('_');
      addSymbol(accumulator, name, 'variable', lineNumber, exported, 'heuristic');
      if (exported) {
        addExport(accumulator, name, 'named', lineNumber, 'heuristic');
      }
    }
  }

  const all = /__all__\s*=\s*\[([^\]]*)\]/m.exec(masked);
  if (all !== null) {
    const names = (all[1] ?? '')
      .split(',')
      .map((part) => part.trim().replace(/^['"]|['"]$/g, ''))
      .filter((name) => /^[A-Za-z_]\w*$/.test(name));
    const line = lineAt(starts, all.index);
    for (const name of names) {
      addExport(accumulator, name, 'named', line, 'confirmed');
    }
  }
}

function analyzeJava(
  masked: string,
  accumulator: AnalysisAccumulator,
): void {
  const starts = lineStarts(masked);
  let match: RegExpExecArray | null;
  const imports = /^\s*import\s+(?:static\s+)?([\w.*]+)\s*;/gm;
  while ((match = imports.exec(masked)) !== null) {
    addImport(accumulator, match[1] ?? '', 'import', lineAt(starts, match.index), 'confirmed');
  }
  const declarations =
    /^\s*(?:(public|protected|private)\s+)?(?:(?:abstract|final|sealed|non-sealed|static|strictfp)\s+)*(class|interface|enum|record)\s+([A-Za-z_]\w*)/gm;
  while ((match = declarations.exec(masked)) !== null) {
    const visibility = match[1] ?? '';
    const keyword = match[2] ?? '';
    const name = match[3] ?? '';
    const exported = visibility === 'public';
    addSymbol(
      accumulator,
      name,
      keyword === 'interface' ? 'interface' : keyword === 'enum' ? 'enum' : 'class',
      lineAt(starts, match.index),
      exported,
      'confirmed',
    );
    if (exported) {
      addExport(accumulator, name, 'named', lineAt(starts, match.index), 'confirmed');
    }
  }
  const methods =
    /^\s*(public|protected|private)\s+(?:static\s+|final\s+|abstract\s+|synchronized\s+|native\s+|default\s+)*[\w<>[\],.?]+\s+([A-Za-z_]\w*)\s*\(/gm;
  while ((match = methods.exec(masked)) !== null) {
    const exported = match[1] === 'public';
    addSymbol(accumulator, match[2] ?? '', 'method', lineAt(starts, match.index), exported, 'heuristic');
    if (exported) {
      addExport(accumulator, match[2] ?? '', 'named', lineAt(starts, match.index), 'heuristic');
    }
  }
  const fields =
    /^\s*(public|protected|private)\s+(?:static\s+|final\s+|transient\s+|volatile\s+)*[\w<>[\],.?]+\s+([A-Za-z_]\w*)\s*(?:=|;)/gm;
  while ((match = fields.exec(masked)) !== null) {
    addSymbol(accumulator, match[2] ?? '', 'variable', lineAt(starts, match.index), match[1] === 'public', 'heuristic');
  }
}

function analyzeGo(
  masked: string,
  accumulator: AnalysisAccumulator,
): void {
  const starts = lineStarts(masked);
  const lines = splitLines(masked);
  let inImportBlock = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const lineNumber = index + 1;
    if (/^\s*import\s*\(/.test(line)) {
      inImportBlock = true;
      continue;
    }
    if (inImportBlock) {
      if (/^\s*\)/.test(line)) {
        inImportBlock = false;
        continue;
      }
      const quoted = /["`]([^"`]+)["`]/.exec(line);
      if (quoted !== null) {
        addImport(accumulator, quoted[1] ?? '', 'import', lineNumber, 'confirmed');
      }
      continue;
    }
    const singleImport = /^\s*import\s+(?:[._A-Za-z]\w*\s+)?["`]([^"`]+)["`]/.exec(line);
    if (singleImport !== null) {
      addImport(accumulator, singleImport[1] ?? '', 'import', lineNumber, 'confirmed');
    }
  }
  const startsList = starts;
  let match: RegExpExecArray | null;
  const functions = /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/gm;
  while ((match = functions.exec(masked)) !== null) {
    const name = match[1] ?? '';
    const isMethod = /^func\s+\(/.test(match[0]);
    const exported = /^[A-Z]/.test(name);
    addSymbol(accumulator, name, isMethod ? 'method' : 'function', lineAt(startsList, match.index), exported, 'confirmed');
    if (exported) {
      addExport(accumulator, name, 'named', lineAt(startsList, match.index), 'confirmed');
    }
  }
  const types = /^type\s+([A-Za-z_]\w*)\s+(struct|interface|func|map|\[|chan|string|int|bool|float|\*)/gm;
  while ((match = types.exec(masked)) !== null) {
    const name = match[1] ?? '';
    const kind = match[2] === 'interface' ? 'interface' : match[2] === 'struct' ? 'struct' : 'type';
    const exported = /^[A-Z]/.test(name);
    addSymbol(accumulator, name, kind, lineAt(startsList, match.index), exported, 'confirmed');
    if (exported) {
      addExport(accumulator, name, 'named', lineAt(startsList, match.index), 'confirmed');
    }
  }
  const values = /^(?:var|const)\s+([A-Za-z_]\w*)/gm;
  while ((match = values.exec(masked)) !== null) {
    const name = match[1] ?? '';
    addSymbol(accumulator, name, 'variable', lineAt(startsList, match.index), /^[A-Z]/.test(name), 'heuristic');
  }
}

function analyzeC(
  masked: string,
  accumulator: AnalysisAccumulator,
  isHeader: boolean,
): void {
  const starts = lineStarts(masked);
  let match: RegExpExecArray | null;
  const includes = /^\s*#\s*include\s*([<"])([^>"]+)[>"]/gm;
  while ((match = includes.exec(masked)) !== null) {
    addImport(
      accumulator,
      match[2] ?? '',
      'include',
      lineAt(starts, match.index),
      'confirmed',
      undefined,
      match[1] === '"',
    );
  }
  const declarations =
    /^\s*(?:typedef\s+)?(?:class|struct|union|enum(?:\s+class)?)\s+([A-Za-z_]\w*)/gm;
  while ((match = declarations.exec(masked)) !== null) {
    const name = match[1] ?? '';
    const kind: SymbolKind = /^\s*(?:typedef\s+)?struct\b/.test(match[0])
      ? 'struct'
      : /^\s*(?:typedef\s+)?class\b/.test(match[0])
        ? 'class'
        : /enum\b/.test(match[0])
          ? 'enum'
          : 'type';
    addSymbol(accumulator, name, kind, lineAt(starts, match.index), isHeader, 'confirmed');
    if (isHeader) {
      addExport(accumulator, name, 'named', lineAt(starts, match.index), 'heuristic');
    }
  }
  const functions =
    /^\s*(?!return\b|if\b|for\b|while\b|switch\b|catch\b|sizeof\b|typedef\b|using\b|namespace\b|class\b|struct\b|enum\b|union\b|#)(?:[\w:*&<>,~]+\s+)+([A-Za-z_]\w*)\s*\([^;\n]*\)\s*(?:const\s*)?(?:[{;])?/gm;
  while ((match = functions.exec(masked)) !== null) {
    const name = match[1] ?? '';
    if (CONTROL_WORDS.has(name)) {
      continue;
    }
    addSymbol(accumulator, name, 'function', lineAt(starts, match.index), isHeader, 'heuristic');
    if (isHeader) {
      addExport(accumulator, name, 'named', lineAt(starts, match.index), 'heuristic');
    }
  }
}

/**
 * Breaks Karkain comments and string contents while preserving length and line
 * breaks, so declaration matching never sees commented-out code or braces that
 * belong to a string literal. The rules mirror the language's own lexer:
 * double-slash line comments, nestable block comments, and quoted strings
 * with backslash escapes.
 */
function maskKarkainCommentsAndStrings(source: string): string {
  let result = '';
  let state: 'normal' | 'line' | 'block' | 'string' = 'normal';
  let blockDepth = 0;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? '';
    const next = source[index + 1];
    if (state === 'normal') {
      if (character === '/' && next === '/') {
        state = 'line';
        result += '  ';
        index += 1;
      } else if (character === '/' && next === '*') {
        state = 'block';
        blockDepth = 1;
        result += '  ';
        index += 1;
      } else if (character === '"') {
        state = 'string';
        result += ' ';
      } else {
        result += character;
      }
      continue;
    }
    if (state === 'line') {
      if (character === '\n') {
        state = 'normal';
        result += '\n';
      } else {
        result += ' ';
      }
      continue;
    }
    if (state === 'block') {
      if (character === '/' && next === '*') {
        blockDepth += 1;
        result += '  ';
        index += 1;
      } else if (character === '*' && next === '/') {
        blockDepth -= 1;
        result += '  ';
        index += 1;
        if (blockDepth === 0) {
          state = 'normal';
        }
      } else {
        result += character === '\n' ? '\n' : ' ';
      }
      continue;
    }
    if (character === '\\') {
      result += '  ';
      index += 1;
    } else if (character === '"') {
      state = 'normal';
      result += ' ';
    } else {
      result += character === '\n' ? '\n' : ' ';
    }
  }
  return result;
}

const KARKAIN_FUNCTION =
  /^\s*(public\s+)?func\s+([A-Za-z_]\w*)\s*\(/;
const KARKAIN_KERNEL = /^\s*(public\s+)?kernel\s+([A-Za-z_]\w*)\s*\(/;
const KARKAIN_STRUCT = /^\s*(public\s+)?struct\s+([A-Za-z_]\w*)/;
const KARKAIN_ENUM = /^\s*(public\s+)?enum\s+([A-Za-z_]\w*)/;
const KARKAIN_TYPE = /^\s*(public\s+)?type\s+([A-Za-z_]\w*)/;
const KARKAIN_ACTOR = /^\s*(public\s+)?actor\s+([A-Za-z_]\w*)/;
const KARKAIN_IMPORT = /^\s*import\s+([A-Za-z_][\w.]*)\s*;?/;
const KARKAIN_TYPED_VAR = /^\s*(?:var|let|const)\s+(?:[A-Za-z_][\w.]*\s+)?([A-Za-z_]\w*)\s*(?::[^=]+)?=/;

interface KarkainDeclaration {
  readonly pattern: RegExp;
  readonly kind: SymbolKind;
}

/** The production compiler declares structs as `type Name struct { ... }`. */
const KARKAIN_TYPE_STRUCT = /^\s*(public\s+)?type\s+([A-Za-z_]\w*)\s+struct\b/;

const KARKAIN_DECLARATIONS: readonly KarkainDeclaration[] = [
  { pattern: KARKAIN_TYPE_STRUCT, kind: 'struct' },
  { pattern: KARKAIN_FUNCTION, kind: 'function' },
  { pattern: KARKAIN_KERNEL, kind: 'function' },
  { pattern: KARKAIN_STRUCT, kind: 'struct' },
  { pattern: KARKAIN_ENUM, kind: 'enum' },
  { pattern: KARKAIN_TYPE, kind: 'type' },
  { pattern: KARKAIN_ACTOR, kind: 'class' },
];

function countBraces(line: string): number {
  let delta = 0;
  for (const character of line) {
    if (character === '{') {
      delta += 1;
    } else if (character === '}') {
      delta -= 1;
    }
  }
  return delta;
}

/**
 * Karkain declarations are read from the grammar implemented by the language's
 * own compiler: `public` visibility, `func`/`kernel`/`struct`/`enum`/`type`/
 * `actor` declarations, `var type name = ...`, `let name = ...`, and
 * `import module.path`. C imports (`import "C" { ... }`) are ignored, matching
 * the module resolver.
 */
function analyzeKarkain(masked: string, accumulator: AnalysisAccumulator): void {
  const lines = splitLines(masked);
  let depth = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const lineNumber = index + 1;
    if (depth === 0) {
      const declaration = KARKAIN_DECLARATIONS.find(
        (candidate) => candidate.pattern.test(line),
      );
      if (declaration !== undefined) {
        const match = declaration.pattern.exec(line);
        if (match !== null) {
          const exported = match[1] !== undefined;
          const name = match[2] ?? '';
          addSymbol(accumulator, name, declaration.kind, lineNumber, exported, 'confirmed');
          if (exported) {
            addExport(accumulator, name, 'named', lineNumber, 'confirmed');
          }
        }
      } else {
        const importMatch = KARKAIN_IMPORT.exec(line);
        const variableMatch = importMatch === null ? KARKAIN_TYPED_VAR.exec(line) : null;
        if (importMatch !== null) {
          addImport(accumulator, importMatch[1] ?? '', 'import', lineNumber, 'confirmed');
        } else if (variableMatch !== null) {
          addSymbol(accumulator, variableMatch[1] ?? '', 'variable', lineNumber, false, 'heuristic');
        }
      }
    }
    depth += countBraces(line);
    if (depth < 0) {
      depth = 0;
    }
  }
}

function publicApiOf(path: string, exportsList: readonly ExportInfo[]): boolean {
  const normalized = path.replace(/\\/g, '/').toLowerCase();
  return (
    exportsList.length > 0 ||
    isIndexLikePath(normalized) ||
    /\.d\.ts$/.test(normalized) ||
    /\.h(?:pp|h|xx)?$/.test(normalized)
  );
}

export function analyzeSourceFile(
  path: string,
  content: string,
  options: AnalyzeFileOptions = {},
): FileAnalysis {
  const normalized = path.replace(/\\/g, '/');
  const language = languageForPath(normalized);
  const limits = {
    maxFileChars: options.maxFileChars ?? DEFAULT_ANALYZE_LIMITS.maxFileChars,
    maxSymbols: options.maxSymbols ?? DEFAULT_ANALYZE_LIMITS.maxSymbols,
    maxImports: options.maxImports ?? DEFAULT_ANALYZE_LIMITS.maxImports,
    maxExports: options.maxExports ?? DEFAULT_ANALYZE_LIMITS.maxExports,
  };
  if (language === undefined) {
    return {
      path: normalized,
      language: 'typescript',
      symbols: [],
      imports: [],
      exports: [],
      publicApi: false,
      contentChars: content.length,
      truncated: false,
      error: 'unsupported-language',
    };
  }
  if (content.includes('\u0000')) {
    return {
      path: normalized,
      language,
      symbols: [],
      imports: [],
      exports: [],
      publicApi: false,
      contentChars: content.length,
      truncated: false,
      error: 'binary-content',
    };
  }

  const truncated = content.length > limits.maxFileChars;
  const bounded = truncated ? content.slice(0, limits.maxFileChars) : content;
  const accumulator: AnalysisAccumulator = {
    symbols: [],
    imports: [],
    exports: [],
    maxSymbols: limits.maxSymbols,
    maxImports: limits.maxImports,
    maxExports: limits.maxExports,
  };

  try {
    const masked = language === 'karkain' ? maskKarkainCommentsAndStrings(bounded) : maskComments(bounded);
    switch (language) {
      case 'typescript':
      case 'javascript':
        analyzeTypeScript(masked, accumulator);
        break;
      case 'python':
        analyzePython(masked, accumulator);
        break;
      case 'java':
        analyzeJava(masked, accumulator);
        break;
      case 'go':
        analyzeGo(masked, accumulator);
        break;
      case 'c':
      case 'cpp':
        analyzeC(masked, accumulator, /\.(?:h|hh|hpp|hxx)$/i.test(normalized));
        break;
      case 'karkain':
        analyzeKarkain(masked, accumulator);
        break;
    }
  } catch {
    return {
      path: normalized,
      language,
      symbols: [],
      imports: [],
      exports: [],
      publicApi: false,
      contentChars: content.length,
      truncated,
      error: 'analysis-failed',
    };
  }

  return {
    path: normalized,
    language,
    symbols: accumulator.symbols,
    imports: accumulator.imports,
    exports: accumulator.exports,
    publicApi: publicApiOf(normalized, accumulator.exports),
    contentChars: content.length,
    truncated,
  };
}

/** Public names a file exposes, used for public-API and impact evidence. */
export function exportedNames(analysis: FileAnalysis): string[] {
  const names = new Set<string>();
  for (const item of analysis.exports) {
    if (item.name !== 'default' && item.name !== 'module.exports') {
      names.add(item.name);
    }
  }
  for (const symbol of analysis.symbols) {
    if (symbol.exported) {
      names.add(symbol.name);
    }
  }
  return [...names].slice(0, 100);
}

/** Symbol names offered by a file, capped for display and graph metadata. */
export function symbolNames(analysis: FileAnalysis): string[] {
  return [...new Set(analysis.symbols.map((symbol) => symbol.name))].slice(0, 120);
}

export function graphLanguage(path: string, analyses: readonly FileAnalysis[]): SupportedLanguage {
  return (
    languageForPath(path) ??
    analyses.find((analysis) => analysis.path === path)?.language ??
    'typescript'
  );
}

export function analyzeLimitsFor(path: string): AnalyzeFileOptions | undefined {
  return isSupportedSourcePath(path) ? {} : undefined;
}

export function extensionOf(path: string): string {
  const name = path.replace(/\\/g, '/').split('/').pop() ?? path;
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

export { lineStarts as __testLineStarts, maskComments as __testMaskComments };
