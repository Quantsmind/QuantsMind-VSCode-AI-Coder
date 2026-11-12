/**
 * Builds a bounded, language-aware guidance block for the agent system
 * prompt from the workspace language inventory. Only languages actually
 * detected in the workspace are mentioned — nothing is invented. Unknown
 * languages degrade to generic behavior; detection quality is surfaced.
 */
import type { LanguageInventory } from '../languages/inventory';
import { buildLanguageGuidance } from '../languages/prompts';

export interface StackGuidanceInput {
  /** Pre-built workspace language inventory (bounded, deterministic). */
  readonly inventory: LanguageInventory;
  readonly packageManager?: string;
  readonly hasKarkain?: boolean;
  /** Active document's language id (VS Code languageId), when available. */
  readonly activeLanguageId?: string;
}

const MAX_CHARS = 2_400;
const KARKAIN_SECTION =
  'This is a Karkain (.kark) project: use get_karkain_project and get_karkain_context before editing; ' +
  'respect the module system, import relationships and compiler-verified grammar reported there; ' +
  'module imports (including std.*) and cross-file type/enum usage must stay consistent with the fixture-verified rules ' +
  'already present in this repository. The real Karkain toolchain may not be available on this machine.';

export function buildStackGuidance(input: StackGuidanceInput): string {
  const sections: string[] = [];

  const guidance = buildLanguageGuidance(input.inventory, {
    ...(input.packageManager !== undefined ? { packageManager: input.packageManager } : {}),
    ...(input.activeLanguageId !== undefined ? { activeLanguageId: input.activeLanguageId } : {}),
  });
  if (guidance.length > 0) {
    sections.push(guidance);
  }
  if (input.hasKarkain === true) {
    sections.push(KARKAIN_SECTION);
  }

  if (sections.length === 0) {
    return '';
  }
  return `\n\n${sections.join('\n')}`.slice(0, MAX_CHARS);
}
