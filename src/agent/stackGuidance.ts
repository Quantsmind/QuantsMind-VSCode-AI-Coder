/**
 * Builds a bounded, language-aware guidance block for the agent system
 * prompt from project-intelligence evidence. Only languages and frameworks
 * actually detected in the workspace are mentioned — nothing is invented.
 */
export interface StackGuidanceInput {
  readonly languages?: readonly { readonly name: string; readonly files: number }[];
  readonly packageManager?: string;
  readonly hasKarkain?: boolean;
}

const MAX_LANGUAGE_NAMES = 8;
const MAX_CHARS = 1200;

export function buildStackGuidance(input: StackGuidanceInput): string {
  const sections: string[] = [];

  const languages = (input.languages ?? []).slice(0, MAX_LANGUAGE_NAMES);
  if (languages.length > 0) {
    sections.push(`Detected languages: ${languages.map((language) => `${language.name} (${language.files})`).join(', ')}.`);
  }
  if (input.packageManager !== undefined && input.packageManager.length > 0) {
    sections.push(`Package manager: ${input.packageManager}.`);
  }
  if (input.hasKarkain === true) {
    sections.push(
      'This is a Karkain (.kark) project: use get_karkain_project and get_karkain_context before editing; ' +
        'respect the module system, import relationships and compiler-verified grammar reported there; ' +
        'module imports (including std.*) and cross-file type/enum usage must stay consistent with the fixture-verified rules ' +
        'already present in this repository. The real Karkain toolchain may not be available on this machine.',
    );
  }

  if (sections.length === 0) {
    return '';
  }
  const guidance = `\n\nProject stack (local evidence only):\n- ${sections.join('\n- ')}`;
  return guidance.slice(0, MAX_CHARS);
}
