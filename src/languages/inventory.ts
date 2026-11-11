/**
 * Bounded, deterministic workspace language inventory.
 *
 * Pure function over the entries the rest of the extension already indexes
 * (never reads file contents). Unknown files are ignored, manifest markers
 * are reported by path (never content), and detection quality is reported as
 * confident/partial/unknown rather than guessed.
 *
 * A tiny content-keyed cache is provided for callers that repeatedly ask
 * about the same workspace state; it invalidates automatically whenever the
 * entries signature changes (paths or sizes), which happens on file add/
 * remove/rename/resize.
 */
import {
  LANGUAGE_REGISTRY,
  detectLanguageForPath,
  type LanguageCapability,
  type LanguageKind,
  type LanguageQualification,
} from './registry';
import type { WorkspaceEntry } from '../workspace/analyze';

export type LanguageDetection = 'confident' | 'partial' | 'unknown';

export type LanguageConfidence = 'confirmed' | 'heuristic';

export interface InventoryLanguage {
  readonly id: string;
  readonly displayName: string;
  readonly kind: LanguageKind;
  readonly qualification: LanguageQualification;
  readonly files: number;
  readonly confidence: LanguageConfidence;
}

export interface InventoryMarker {
  readonly name: string;
  readonly path: string;
  readonly kind: 'manifest';
}

export interface LanguageInventory {
  /** How much of the workspace we can speak about. */
  readonly detection: LanguageDetection;
  /** The dominant source/query language, or undefined when none was found. */
  readonly primary?: InventoryLanguage;
  /** All detected languages, source-like families first, then others. */
  readonly languages: readonly InventoryLanguage[];
  /** Detected languages other than the primary one (bounded). */
  readonly supporting: readonly InventoryLanguage[];
  /** Manifest markers by path, capped; content is never read here. */
  readonly markers: readonly InventoryMarker[];
  /** Entries contributing a registry match. */
  readonly recognizedFiles: number;
  /** Entries considered before bounds were applied. */
  readonly consideredEntries: number;
  /** True when the entries bound was exceeded and the scan was cut off. */
  readonly truncated: boolean;
}

export const DEFAULT_INVENTORY_LIMITS = Object.freeze({
  maxEntries: 10_000,
  maxLanguages: 32,
  maxMarkers: 24,
  maxFileSizeBytes: 5_000_000,
});

const DEFAULT_SKIP_SEGMENTS = new Set([
  'node_modules',
  'bower_components',
  'jspm_packages',
  '.yarn',
  '.pnpm-store',
  'vendor',
  'third_party',
  'dist',
  'out',
  'build',
  'target',
  'bin',
  'obj',
  'coverage',
  '.nyc_output',
  '.git',
  '.hg',
  '.svn',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.venv',
  'venv',
  '__pycache__',
  '.mypy_cache',
]);

const SKIP_DIRECTORY_PREFIXES = ['.git/', '.hg/', '.svn/'];

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '');
}

function isSkippedPath(path: string): boolean {
  const normalized = normalizePath(path).toLowerCase();
  for (const segment of normalized.split('/')) {
    if (DEFAULT_SKIP_SEGMENTS.has(segment)) {
      return true;
    }
  }
  return SKIP_DIRECTORY_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function extensionOf(path: string): string {
  const name = path.split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

const manifestNames = new Set(LANGUAGE_REGISTRY.flatMap((entry) => entry.manifests));
function markerNameFor(path: string): string | undefined {
  const name = path.split('/').pop() ?? '';
  if (manifestNames.has(name)) {
    return name;
  }
  const ext = extensionOf(path);
  if (manifestNames.has(`*.${ext}`)) {
    return `*.${ext}`;
  }
  // Directory-style manifests (e.g. workflow directories).
  for (const candidate of manifestNames) {
    if (candidate.includes('/') && (path.includes(`/${candidate}/`) || path.startsWith(`${candidate}/`))) {
      return candidate;
    }
  }
  return undefined;
}

export interface InventoryOptions {
  readonly maxEntries?: number;
  readonly maxLanguages?: number;
  readonly maxMarkers?: number;
  readonly maxFileSizeBytes?: number;
}

const KIND_ORDER: Record<LanguageKind, number> = {
  source: 0,
  query: 1,
  script: 2,
  markup: 3,
  config: 4,
};

export function buildLanguageInventory(
  entries: readonly WorkspaceEntry[],
  options: InventoryOptions = {},
): LanguageInventory {
  const maxEntries = Math.max(1, Math.min(options.maxEntries ?? DEFAULT_INVENTORY_LIMITS.maxEntries, 50_000));
  const maxLanguages = Math.max(1, Math.min(options.maxLanguages ?? DEFAULT_INVENTORY_LIMITS.maxLanguages, 64));
  const maxMarkers = Math.max(0, Math.min(options.maxMarkers ?? DEFAULT_INVENTORY_LIMITS.maxMarkers, 64));
  const maxFileSizeBytes = Math.max(0, options.maxFileSizeBytes ?? DEFAULT_INVENTORY_LIMITS.maxFileSizeBytes);

  const counts = new Map<string, { capability: LanguageCapability; files: number; confirmed: boolean }>();
  const markers: InventoryMarker[] = [];
  let consideredEntries = 0;
  let recognizedFiles = 0;
  let truncated = false;

  for (const entry of entries) {
    if (consideredEntries >= maxEntries) {
      truncated = true;
      break;
    }
    consideredEntries += 1;
    const path = normalizePath(entry.path);
    if (path.length === 0 || isSkippedPath(path)) {
      continue;
    }
    if (typeof entry.size === 'number' && entry.size > maxFileSizeBytes) {
      continue;
    }
    const capability = detectLanguageForPath(path);
    if (capability !== undefined) {
      recognizedFiles += 1;
      const current = counts.get(capability.id) ?? { capability, files: 0, confirmed: false };
      current.files += 1;
      // Extensions are unambiguous for most families; compound `d.ts` and
      // config families stay heuristic because they are indistinguishable.
      if (capability.qualification === 'analysis') {
        current.confirmed = true;
      }
      counts.set(capability.id, current);
    }
    if (markers.length < maxMarkers) {
      const marker = markerNameFor(path);
      if (marker !== undefined) {
        markers.push({ name: marker, path, kind: 'manifest' });
      }
    }
  }

  const languages: InventoryLanguage[] = [...counts.values()]
    .map(({ capability, files, confirmed }) => ({
      id: capability.id,
      displayName: capability.displayName,
      kind: capability.kind,
      qualification: capability.qualification,
      files,
      confidence: confirmed ? ('confirmed' as const) : ('heuristic' as const),
    }))
    .sort((left, right) => {
      const kindOrder = KIND_ORDER[left.kind] - KIND_ORDER[right.kind];
      if (kindOrder !== 0) {
        return kindOrder;
      }
      return right.files - left.files || left.id.localeCompare(right.id);
    })
    .slice(0, maxLanguages);

  const primary = languages.find((language) => language.kind === 'source' || language.kind === 'query');
  const detection: LanguageDetection =
    primary !== undefined
      ? primary.files >= 3
        ? 'confident'
        : 'partial'
      : recognizedFiles > 0
        ? 'partial'
        : 'unknown';

  return {
    detection,
    ...(primary !== undefined ? { primary } : {}),
    languages,
    supporting: languages.filter((language) => language.id !== primary?.id).slice(0, 16),
    markers,
    recognizedFiles,
    consideredEntries,
    truncated,
  };
}

/** One-line human summary for diagnostics and prompts; bounded. */
export function inventorySummary(inventory: LanguageInventory, maxChars = 600): string {
  if (inventory.languages.length === 0) {
    return 'No recognized languages.';
  }
  const body = inventory.languages
    .map((language) => `${language.displayName} (${language.files})`)
    .join(', ');
  const suffix = inventory.truncated ? ' (truncated)' : '';
  return `Languages: ${body}${suffix}. Detection: ${inventory.detection}.`.slice(0, maxChars);
}

// ---------------------------------------------------------------------------
// Content-keyed memoization
// ---------------------------------------------------------------------------

const cache = new Map<string, LanguageInventory>();
const CACHE_LIMIT = 8;

function entriesSignature(entries: readonly WorkspaceEntry[]): string {
  let hash = 0;
  let count = 0;
  for (const entry of entries) {
    count += 1;
    const text = `${normalizePath(entry.path)}:${entry.size ?? -1}`;
    for (let index = 0; index < text.length; index += 1) {
      // djb2-style rolling hash; deterministic and cheap.
      hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0;
    }
  }
  return `${count}:${hash >>> 0}`;
}

/**
 * Memoized inventory lookup. The cache key includes every path and size, so
 * any add/remove/rename/resize invalidates automatically; the cache is
 * bounded to a handful of entries.
 */
export function cachedLanguageInventory(
  entries: readonly WorkspaceEntry[],
  options: InventoryOptions = {},
): LanguageInventory {
  const key = `${entriesSignature(entries)}|${options.maxEntries ?? ''}|${options.maxLanguages ?? ''}|${options.maxFileSizeBytes ?? ''}`;
  const hit = cache.get(key);
  if (hit !== undefined) {
    return hit;
  }
  const inventory = buildLanguageInventory(entries, options);
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) {
      cache.delete(oldest);
    }
  }
  cache.set(key, inventory);
  return inventory;
}

/** Test hook: drops the memoized inventories. */
export function __clearLanguageInventoryCache(): void {
  cache.clear();
}
