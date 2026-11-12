/**
 * Language-adaptive prompt guidance.
 *
 * Builds a short, bounded section naming the workspace's primary language,
 * the relevant secondary languages and the detected tooling — only what is
 * actually evidenced, plus an explicit uncertainty note when detection is
 * partial or unknown. Provider-agnostic: nothing here assumes a vendor.
 */
import { getLanguageCapability } from './registry';
import { inventorySummary, type LanguageInventory } from './inventory';

export interface LanguageGuidanceOptions {
  /** Maximum characters for the section (default 2,000). */
  readonly maxChars?: number;
  /** Maximum secondary languages to describe (default 3). */
  readonly maxSupporting?: number;
  /** Active document's language id (VS Code), or undefined. */
  readonly activeLanguageId?: string;
  /** Detected package manager, when known. */
  readonly packageManager?: string;
}

const DEFAULT_MAX_CHARS = 2_000;
const DEFAULT_MAX_SUPPORTING = 3;

function guidanceBullets(id: string): readonly string[] {
  return getLanguageCapability(id)?.guidance.slice(0, 3) ?? [];
}

function line(items: readonly string[]): string {
  return items.join('\n');
}

/**
 * Bounded guidance block for the agent system prompt. Returns an empty
 * string when there is no useful, non-invented evidence — callers append
 * only when non-empty.
 */
export function buildLanguageGuidance(
  inventory: LanguageInventory,
  options: LanguageGuidanceOptions = {},
): string {
  const maxChars = Math.max(200, options.maxChars ?? DEFAULT_MAX_CHARS);
  const maxSupporting = Math.max(0, Math.min(options.maxSupporting ?? DEFAULT_MAX_SUPPORTING, 5));

  const sections: string[] = ['Project languages (local evidence only):'];

  const active = options.activeLanguageId?.trim().toLowerCase();
  if (active !== undefined && active.length > 0) {
    const capability = getLanguageCapability(active);
    if (capability !== undefined) {
      sections.push(`- Active file language: ${capability.displayName}.`);
    } else {
      sections.push(`- Active file language: ${active} (unrecognized; treat conventions as unknown).`);
    }
  }

  const primary = inventory.primary;
  if (primary === undefined) {
    sections.push('- No recognized source languages were detected in this workspace.');
    sections.push('- Detection confidence: unknown. Do not assume a language, framework or build tool; ask if the task depends on one.');
    return line(sections).slice(0, maxChars);
  }

  sections.push(`- Primary language: ${primary.displayName} (${primary.files} file${primary.files === 1 ? '' : 's'}).`);
  for (const bullet of guidanceBullets(primary.id)) {
    sections.push(`  - ${bullet}`);
  }

  const supporting = inventory.supporting
    .filter((language) => language.kind === 'source' || language.kind === 'query' || language.kind === 'script')
    .slice(0, maxSupporting);
  for (const language of supporting) {
    sections.push(`- Also present: ${language.displayName} (${language.files} file${language.files === 1 ? '' : 's'}).`);
    for (const bullet of guidanceBullets(language.id).slice(0, 1)) {
      sections.push(`  - ${bullet}`);
    }
  }

  const testHints = [primary, ...supporting]
    .map((language) => getLanguageCapability(language.id)?.testHint)
    .filter((hint): hint is string => hint !== undefined);
  if (testHints.length > 0) {
    sections.push(`- Testing: ${testHints[0]}`);
  }

  if (options.packageManager !== undefined && options.packageManager.trim().length > 0) {
    sections.push(`- Package manager: ${options.packageManager.trim()}.`);
  }

  if (inventory.detection !== 'confident') {
    sections.push(
      `- Detection confidence: ${inventory.detection}. If you cannot reliably identify the framework or convention from the evidence given, say so explicitly instead of guessing.`,
    );
  }

  return line(sections).slice(0, maxChars);
}

/** Single-language section for the chat prompt; bounded to a few lines. */
export function buildChatLanguageGuidance(activeLanguageId: string | undefined, maxChars = 600): string {
  const id = activeLanguageId?.trim().toLowerCase();
  if (id === undefined || id.length === 0) {
    return '';
  }
  const capability = getLanguageCapability(id);
  if (capability === undefined) {
    return `Active language: ${id} (unrecognized). If the task depends on language-specific behavior, ask or state the uncertainty.`
      .slice(0, maxChars);
  }
  const bullets = capability.guidance.slice(0, 2).map((bullet) => `\n- ${bullet}`).join('');
  return `Active language: ${capability.displayName}.${bullets}`.slice(0, maxChars);
}

/** Multi-line inventory diagnostics for output channels; never contains file contents or secrets. */
export function buildLanguageDiagnostics(inventory: LanguageInventory): string {
  const lines: string[] = [];
  lines.push(`Language detection: ${inventory.detection}`);
  lines.push(`Recognized files: ${inventory.recognizedFiles} of ${inventory.consideredEntries} considered${inventory.truncated ? ' (scan truncated)' : ''}`);
  if (inventory.primary !== undefined) {
    lines.push(`Primary language: ${inventory.primary.displayName} (${inventory.primary.files} files, ${inventory.primary.confidence}, qualification: ${inventory.primary.qualification})`);
  } else {
    lines.push('Primary language: (none detected)');
  }
  if (inventory.supporting.length > 0) {
    lines.push(`Supporting languages: ${inventory.supporting.map((language) => `${language.displayName} (${language.files}, ${language.kind})`).join(', ')}`);
  } else {
    lines.push('Supporting languages: none');
  }
  if (inventory.markers.length > 0) {
    lines.push(`Project markers: ${inventory.markers.map((marker) => `${marker.name} (${marker.path})`).slice(0, 12).join(', ')}`);
  } else {
    lines.push('Project markers: none');
  }
  lines.push(inventorySummary(inventory));
  return lines.join('\n');
}
