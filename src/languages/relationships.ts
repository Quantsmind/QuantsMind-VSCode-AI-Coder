/**
 * Deterministic cross-language relationships.
 *
 * Identifies pairs of files that are likely to change together across
 * languages, with a reason and a confidence for each pair. The rules are
 * deliberately explicit and bounded; anything ambiguous is labelled
 * `heuristic` — nothing here silently triggers edits.
 *
 * Rules (all deterministic):
 * 1. shared-contract — `.proto`/`.graphql`/`.thrift`/`.wsdl`/`.xsd` or
 *    openapi/swagger manifests and the files bound to them (import or
 *    co-location in the same directory in another source language).
 * 2. schema-model — SQL schema/table names matched to model symbols in
 *    application languages (CREATE TABLE extraction when contents are
 *    provided; path-token pairing otherwise).
 * 3. client-server — client-side API layers and server-side route/handler
 *    directories sharing meaningful path tokens.
 * 4. build-config — C/C++ sources in directories lacking build manifests,
 *    paired with the build files that drive them.
 */
import type { FileAnalysis } from '../repository/symbols';
import { detectLanguageForPath } from './registry';
import type { WorkspaceEntry } from '../workspace/analyze';

export type RelationKind = 'shared-contract' | 'schema-model' | 'client-server' | 'build-config';

export type RelationConfidence = 'confirmed' | 'heuristic';

export interface LanguageRelation {
  readonly from: string;
  readonly to: string;
  readonly kind: RelationKind;
  readonly reason: string;
  readonly confidence: RelationConfidence;
}

export interface RelationOptions {
  readonly maxRelations?: number;
  /** Optional file contents (bounded reads) for CREATE TABLE extraction. */
  readonly fileContents?: Readonly<Record<string, string>>;
}

const RELATION_LIMITS = Object.freeze({
  maxRelations: 20,
  maxPerGroup: 6,
});

const TOKEN_STOPWORDS = new Set([
  'index',
  'main',
  'src',
  'lib',
  'app',
  'test',
  'tests',
  'spec',
  'api',
  'client',
  'server',
  'shared',
  'common',
  'utils',
  'types',
  'types.d',
  'schema',
  'schemas',
  'contract',
  'contracts',
  'openapi',
  'swagger',
  'generated',
  'gen',
]);

const GENERIC_STEMS = new Set(['schema', 'api', 'openapi', 'swagger', 'contract', 'index', 'main', 'data']);

const CONTRACT_EXTENSIONS = new Set(['proto', 'thrift', 'wsdl', 'xsd', 'graphql', 'gql']);
const CONTRACT_NAME_PATTERN = /(?:^|\/)(openapi|swagger)(?:[._-][a-z0-9_-]*)?\.(?:json|ya?ml)$|\.(openapi|swagger)\.(?:json|ya?ml)$/i;

const BUILD_FILE_NAMES = new Set([
  'cmakelists.txt',
  'makefile',
  'build.gradle',
  'build.gradle.kts',
  'settings.gradle',
  'settings.gradle.kts',
  'pom.xml',
  'justfile',
  'taskfile.yml',
  'taskfile.yaml',
]);

function normalize(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

function baseName(path: string): string {
  const normalized = normalize(path);
  return normalized.split('/').pop() ?? normalized;
}

function extensionOf(path: string): string {
  const name = baseName(path);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

function stemOf(path: string): string {
  const name = baseName(path).replace(/\.[^.]*$/, '');
  return normalizeToken(name);
}

function normalizeToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function pathTokens(path: string): string[] {
  const withoutExtension = normalize(path).replace(/\.[^./]*$/, '');
  const tokens = withoutExtension
    .split(/[^A-Za-z0-9]+/)
    .map((token) => token.toLowerCase())
    .filter((token) => token.length >= 4 && !TOKEN_STOPWORDS.has(token) && !/^\d+$/.test(token));
  return [...new Set(tokens)].slice(0, 6);
}

function isContractPath(path: string): boolean {
  const normalized = normalize(path).toLowerCase();
  if (CONTRACT_EXTENSIONS.has(extensionOf(normalized))) {
    return true;
  }
  return CONTRACT_NAME_PATTERN.test(normalized);
}

function isBuildFile(path: string): boolean {
  const name = baseName(path).toLowerCase();
  if (BUILD_FILE_NAMES.has(name)) {
    return true;
  }
  return name.endsWith('.csproj') || name.endsWith('.vcxproj') || name.endsWith('.sln');
}

function isCompiledLanguagePath(path: string): boolean {
  const extension = extensionOf(path);
  return ['c', 'h', 'cc', 'cpp', 'cxx', 'hh', 'hpp', 'hxx'].includes(extension);
}

function isClientPath(path: string): boolean {
  const normalized = normalize(path).toLowerCase();
  const name = baseName(normalized);
  if (/\.(client|api|sdk)\.[cm]?[jt]sx?$/.test(name)) {
    return true;
  }
  return /(^|\/)(client|clients|sdk|generated|frontend|web|api)\//.test(normalized);
}

function isServerPath(path: string): boolean {
  const normalized = normalize(path).toLowerCase();
  const name = baseName(normalized);
  if (/\.(controller|route|routes|handler|endpoint)\./.test(name)) {
    return true;
  }
  return /(^|\/)(routes?|controllers?|handlers?|endpoints?|backend|server|services?)\//.test(normalized);
}

function languageOf(path: string): string | undefined {
  return detectLanguageForPath(path)?.id;
}

function push(relations: LanguageRelation[], seen: Set<string>, relation: LanguageRelation): void {
  if (relation.from === relation.to) {
    return;
  }
  const key = `${relation.from}|${relation.to}|${relation.kind}`;
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  relations.push(relation);
}

/**
 * Symbol-name candidates for a table name: exact and per-part singular forms
 * (tables are commonly plural, models singular), in PascalCase and camelCase.
 */
function symbolCandidates(table: string): string[] {
  const parts = table
    .split(/[^a-z0-9]+/i)
    .filter(Boolean)
    .map((part) => part.toLowerCase());
  if (parts.length === 0) {
    return [];
  }
  const cap = (part: string): string => part.charAt(0).toUpperCase() + part.slice(1);
  const variants: string[][] = [parts];
  const singular = parts.map((part) => (part.endsWith('s') && part.length > 3 ? part.slice(0, -1) : part));
  if (singular.join(' ') !== parts.join(' ')) {
    variants.push(singular);
  }
  const candidates = new Set<string>();
  for (const variant of variants) {
    const pascal = variant.map(cap).join('');
    const camel = variant[0] + variant.slice(1).map(cap).join('');
    candidates.add(pascal);
    candidates.add(camel);
    candidates.add(pascal.toLowerCase());
  }
  return [...candidates];
}

const CREATE_TABLE_PATTERN = /create\s+table\s+(?:if\s+not\s+exists\s+)?([a-zA-Z_][\w$]*(?:\.[a-zA-Z_][\w$]*)?)/gi;

function extractTableNames(content: string): string[] {
  const names = new Set<string>();
  for (const match of content.matchAll(CREATE_TABLE_PATTERN)) {
    const raw = match[1] ?? '';
    const table = raw.split('.').pop() ?? raw;
    if (table.length >= 3) {
      names.add(table.toLowerCase());
    }
    if (names.size >= 24) {
      break;
    }
  }
  return [...names];
}

export function findLanguageRelations(
  entries: readonly WorkspaceEntry[],
  analyses: readonly FileAnalysis[],
  options: RelationOptions = {},
): LanguageRelation[] {
  const relations: LanguageRelation[] = [];
  const seen = new Set<string>();
  const limit = Math.max(1, Math.min(options.maxRelations ?? RELATION_LIMITS.maxRelations, 60));
  const cap = (bucket: number): boolean => relations.length >= limit || bucket >= RELATION_LIMITS.maxPerGroup;

  const paths = entries.map((entry) => normalize(entry.path));
  const tokenCache = new Map<string, string[]>();
  const tokensFor = (path: string): string[] => {
    const cached = tokenCache.get(path);
    if (cached !== undefined) {
      return cached;
    }
    const tokens = pathTokens(path);
    tokenCache.set(path, tokens);
    return tokens;
  };

  // ------------------------------------------------------------------
  // Rule 1 — shared API contracts
  // ------------------------------------------------------------------
  let contractRelations = 0;
  const contracts = paths.filter((path) => isContractPath(path));
  for (const contract of contracts) {
    if (cap(contractRelations)) {
      break;
    }
    const stem = stemOf(contract);
    const contractLanguage = languageOf(contract);
    // (a) Import / file-name binding to the contract.
    if (stem.length >= 4 && !GENERIC_STEMS.has(stem)) {
      for (const analysis of analyses) {
        if (cap(contractRelations)) {
          break;
        }
        const path = normalize(analysis.path);
        if (path === contract) {
          continue;
        }
        const bound = analysis.imports.some((reference) => reference.specifier.toLowerCase().includes(stem));
        if (bound) {
          push(relations, seen, {
            from: contract,
            to: path,
            kind: 'shared-contract',
            reason: `${path} references the shared contract "${stem}"`,
            confidence: 'confirmed',
          });
          contractRelations += 1;
        }
      }
    }
    // (b) Co-located language bindings in the same directory.
    const directory = contract.split('/').slice(0, -1).join('/');
    for (const path of paths) {
      if (cap(contractRelations)) {
        break;
      }
      if (path === contract || !path.startsWith(`${directory}/`)) {
        continue;
      }
      const language = languageOf(path);
      if (language === undefined || language === contractLanguage || language === 'config' || language === 'markup') {
        continue;
      }
      const sameDirectory = path.split('/').length === contract.split('/').length;
      if (!sameDirectory) {
        continue;
      }
      // Prefer language-named bindings (e.g. `user.service.ts` beside `user.proto`).
      const bindingName = pathTokens(path)[0];
      const overlaps =
        bindingName !== undefined &&
        (bindingName === stem ||
          stem.startsWith(bindingName) ||
          bindingName.startsWith(stem) ||
          stem.includes(bindingName) ||
          bindingName.includes(stem));
      if (!overlaps) {
        continue;
      }
      push(relations, seen, {
        from: contract,
        to: path,
        kind: 'shared-contract',
        reason: `${path} sits beside the shared contract "${baseName(contract)}" in another language`,
        confidence: 'heuristic',
      });
      contractRelations += 1;
    }
  }

  // ------------------------------------------------------------------
  // Rule 2 — SQL schema <-> application models
  // ------------------------------------------------------------------
  let schemaRelations = 0;
  const sqlFiles = paths.filter((path) => extensionOf(path) === 'sql');
  for (const sql of sqlFiles) {
    if (cap(schemaRelations)) {
      break;
    }
    // (a) CREATE TABLE extraction when contents were provided.
    const content = options.fileContents?.[sql];
    if (content !== undefined) {
      for (const table of extractTableNames(content)) {
        if (cap(schemaRelations)) {
          break;
        }
        const candidates = symbolCandidates(table);
        for (const analysis of analyses) {
          if (cap(schemaRelations)) {
            break;
          }
          const path = normalize(analysis.path);
          if (path === sql || candidates.length === 0) {
            continue;
          }
          const match = analysis.symbols.find((symbol) =>
            candidates.includes(symbol.name) || candidates.includes(symbol.name.toLowerCase()),
          );
          if (match !== undefined) {
            push(relations, seen, {
              from: sql,
              to: path,
              kind: 'schema-model',
              reason: `${path} declares "${match.name}", matching CREATE TABLE ${table}`,
              confidence: 'confirmed',
            });
            schemaRelations += 1;
          }
        }
      }
      continue;
    }
    // (b) Path-token pairing without contents.
    const sqlTokens = tokensFor(sql).filter((token) => !GENERIC_STEMS.has(token) && token.length >= 4);
    if (sqlTokens.length === 0) {
      continue;
    }
    for (const path of paths) {
      if (cap(schemaRelations)) {
        break;
      }
      if (path === sql || extensionOf(path) === 'sql') {
        continue;
      }
      const language = languageOf(path);
      if (language === undefined || language === 'config') {
        continue;
      }
      const fileTokens = tokensFor(path);
      const shared = sqlTokens.find((token) => fileTokens.includes(token));
      const isModelish = /model|entit|schema|entity|repository|dao|struct|class/.test(path.toLowerCase());
      if (shared !== undefined && isModelish) {
        push(relations, seen, {
          from: sql,
          to: path,
          kind: 'schema-model',
          reason: `${path} shares the "${shared}" token with ${baseName(sql)} and looks like a model definition`,
          confidence: 'heuristic',
        });
        schemaRelations += 1;
      }
    }
  }

  // ------------------------------------------------------------------
  // Rule 3 — frontend API clients <-> backend route/handler layers
  // ------------------------------------------------------------------
  let clientServerRelations = 0;
  const clientFiles = paths.filter((path) => isClientPath(path));
  const serverFiles = paths.filter((path) => isServerPath(path));
  for (const client of clientFiles) {
    if (cap(clientServerRelations)) {
      break;
    }
    const clientTokens = tokensFor(client).filter((token) => token.length >= 4 && !GENERIC_STEMS.has(token));
    if (clientTokens.length === 0) {
      continue;
    }
    for (const server of serverFiles) {
      if (cap(clientServerRelations)) {
        break;
      }
      if (client === server) {
        continue;
      }
      const serverTokens = tokensFor(server);
      const shared = clientTokens.find((token) => serverTokens.includes(token));
      if (shared === undefined) {
        continue;
      }
      push(relations, seen, {
        from: client,
        to: server,
        kind: 'client-server',
        reason: `${client} calls into the API surface handled by ${server} (shared token "${shared}")`,
        confidence: 'heuristic',
      });
      clientServerRelations += 1;
    }
  }

  // ------------------------------------------------------------------
  // Rule 4 — build configuration <-> compiled sources
  // ------------------------------------------------------------------
  let buildRelations = 0;
  const buildFiles = paths.filter((path) => isBuildFile(path));
  const compiled = paths.filter((path) => isCompiledLanguagePath(path));
  for (const build of buildFiles) {
    if (cap(buildRelations)) {
      break;
    }
    const directory = build.split('/').slice(0, -1).join('/');
    const scoped = compiled.filter((path) => path.startsWith(directory.length === 0 ? '' : `${directory}/`));
    for (const source of scoped.slice(0, 2)) {
      if (cap(buildRelations)) {
        break;
      }
      push(relations, seen, {
        from: build,
        to: source,
        kind: 'build-config',
        reason: `${source} is a compiled source built by ${baseName(build)}`,
        confidence: 'heuristic',
      });
      buildRelations += 1;
    }
  }

  return relations.slice(0, limit);
}

/** Bounded, human-readable explanation of the relations; never includes file contents. */
export function explainLanguageRelations(relations: readonly LanguageRelation[], maxChars = 1200): string {
  if (relations.length === 0) {
    return 'No cross-language relationships detected.';
  }
  const lines = relations.map(
    (relation) =>
      `${relation.from} <-> ${relation.to} [${relation.kind}, ${relation.confidence}]: ${relation.reason}`,
  );
  return lines.join('\n').slice(0, maxChars);
}
