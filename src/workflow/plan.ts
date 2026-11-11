/**
 * Builds a structured, evidence-grounded coding plan (the v2.5.5 envelope)
 * around an already-validated development plan.
 *
 * Evidence is generated locally from what the workspace actually shows;
 * assumptions are explicitly labelled as model proposals. Nothing here
 * touches the provider again, and nothing edits the workspace.
 */
import { normalizeChangePath } from '../changes/model';
import type { ProjectContext } from '../agent/models';
import type { DevelopmentPlan } from '../agent/models';
import type { LanguageInventory } from '../languages/inventory';
import type { LanguageRelation } from '../languages/relationships';
import type { BuildAdapterDetection } from '../build/types';
import type { CodingTaskPlan, WorkflowEvidence } from './model';
import { MAX_ASSUMPTIONS, MAX_COMPLETION_CRITERIA, MAX_EVIDENCE_ITEMS, MAX_EXPECTED_FILES, MAX_SCOPE_ITEMS } from './model';
import { classifyTaskCategory } from './classify';

export interface CodingTaskPlanInput {
  /** The already-validated development plan (parseDevelopmentPlan output). */
  readonly plan: DevelopmentPlan;
  readonly requirementText: string;
  /** Local projection evidence; when absent, no evidence items are invented. */
  readonly inventory?: LanguageInventory;
  readonly detections?: readonly BuildAdapterDetection[];
  readonly context?: ProjectContext;
  readonly relations?: readonly LanguageRelation[];
  readonly now?: () => string;
}

function pushEvidence(evidence: WorkflowEvidence[], kind: WorkflowEvidence['kind'], text: string): void {
  const trimmed = text.trim();
  if (trimmed.length > 0 && evidence.length < MAX_EVIDENCE_ITEMS) {
    evidence.push({ kind, text: trimmed.slice(0, 300) });
  }
}

/** Validates, normalizes and bounds the set of files the plan expects to touch. */
export function expectedFilesOf(plan: DevelopmentPlan): string[] {
  const files: string[] = [];
  const seen = new Set<string>();
  for (const task of plan.tasks) {
    for (const raw of task.suggestedFiles) {
      const normalized = normalizeChangePath(raw);
      if (normalized === undefined) {
        continue;
      }
      const key = normalized.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      files.push(normalized);
      if (files.length >= MAX_EXPECTED_FILES) {
        return files;
      }
    }
  }
  return files;
}

export function buildCodingTaskPlan(input: CodingTaskPlanInput): CodingTaskPlan {
  const classification = classifyTaskCategory(input.requirementText);
  const evidence: WorkflowEvidence[] = [];
  const assumptions: string[] = [];

  // ------------------------------------------------------------
  // Local evidence: what the workspace actually shows
  // ------------------------------------------------------------
  const inventory = input.inventory;
  if (inventory?.primary !== undefined) {
    pushEvidence(
      evidence,
      'language',
      `Primary language: ${inventory.primary.displayName} (${inventory.primary.files} file(s), detection ${inventory.detection}).`,
    );
  } else if (inventory !== undefined) {
    pushEvidence(evidence, 'language', `Language detection: ${inventory.detection}; no source language dominates.`);
  }
  for (const language of inventory?.supporting.slice(0, 4) ?? []) {
    pushEvidence(evidence, 'language', `Supporting language: ${language.displayName} (${language.files} file(s)).`);
  }
  for (const detection of input.detections ?? []) {
    pushEvidence(
      evidence,
      'build',
      `Build system: ${detection.adapter.ecosystem} (detected from ${detection.configFile}).`,
    );
  }
  const relationKinds = new Map<string, number>();
  for (const relation of input.relations ?? []) {
    relationKinds.set(relation.kind, (relationKinds.get(relation.kind) ?? 0) + 1);
  }
  for (const [kind, count] of relationKinds) {
    pushEvidence(evidence, 'repo', `${count} cross-language relation(s) of kind ${kind} (heuristic unless marked otherwise).`);
  }
  for (const fact of input.context?.facts ?? []) {
    if (evidence.length >= MAX_EVIDENCE_ITEMS) {
      break;
    }
    pushEvidence(evidence, 'repo', fact.fact);
  }
  pushEvidence(evidence, 'task', `Requirement: ${input.requirementText.trim().slice(0, 200)}`);

  // ------------------------------------------------------------
  // Assumptions: model proposals that remain unverified
  // ------------------------------------------------------------
  assumptions.push('The provider proposed this plan; treat every step and file suggestion as a hypothesis to verify.');
  if (inventory?.detection !== 'confident' && inventory !== undefined) {
    assumptions.push(`Language detection is ${inventory.detection}; the primary language or tooling may be misjudged.`);
  }
  const suggestedFiles = input.plan.tasks.reduce((count, task) => count + task.suggestedFiles.length, 0);
  if (suggestedFiles > 0) {
    assumptions.push(`${suggestedFiles} suggested file path(s) came from the model; verify before editing.`);
  }

  // ------------------------------------------------------------
  // Envelope assembly
  // ------------------------------------------------------------
  const scope = input.plan.tasks.map((task) => task.title).slice(0, MAX_SCOPE_ITEMS);
  const expectedFiles = expectedFilesOf(input.plan);
  const criterionKeys = new Set<string>();
  const completionCriteria: string[] = [];
  for (const task of input.plan.tasks) {
    for (const criterion of task.acceptanceCriteria) {
      const key = criterion.text.trim().toLowerCase();
      if (criterionKeys.has(key) || completionCriteria.length >= MAX_COMPLETION_CRITERIA) {
        continue;
      }
      criterionKeys.add(key);
      completionCriteria.push(criterion.text.trim().slice(0, 200));
    }
  }

  const detected = (input.detections ?? []).map((detection) => detection.adapter.ecosystem);
  const validationStrategy = detected.length > 0
    ? `Run the project's own commands (${detected.slice(0, 3).join(', ')}) scoped to the changed files where possible, then broader tests. Execution requires explicit approval and user-allowlisted commands.`
    : 'No build detection was computed for this plan; run detect_build_system to see the exact build/test commands before choosing one. Do not guess commands.';

  return {
    id: input.plan.id,
    category: classification.category,
    objective: input.plan.summary.trim().slice(0, 500),
    scope,
    evidence,
    assumptions: assumptions.slice(0, MAX_ASSUMPTIONS),
    risks: input.plan.risks.slice(0, 10).map((risk) => risk.slice(0, 300)),
    expectedFiles,
    completionCriteria,
    validationStrategy,
    createdAt: (input.now ?? (() => new Date().toISOString()))(),
  };
}

/** Renders the envelope as a compact, user-facing block for approval surfaces; never contains file contents. */
export function formatCodingTaskPlan(plan: CodingTaskPlan, maxChars = 2_000): string {
  const lines: string[] = [
    `Category: ${plan.category}. Expected changes: ${plan.expectedFiles.length} file(s).`,
    `Objective: ${plan.objective}`,
  ];
  if (plan.evidence.length > 0) {
    lines.push('Evidence (local):');
    for (const item of plan.evidence.slice(0, 8)) {
      lines.push(`- [${item.kind}] ${item.text}`);
    }
  }
  if (plan.assumptions.length > 0) {
    lines.push('Assumptions (verify):');
    for (const item of plan.assumptions.slice(0, MAX_ASSUMPTIONS)) {
      lines.push(`- ${item}`);
    }
  }
  lines.push(`Validation: ${plan.validationStrategy}`);
  if (plan.completionCriteria.length > 0) {
    lines.push('Completion criteria:');
    for (const criterion of plan.completionCriteria) {
      lines.push(`- ${criterion}`);
    }
  }
  return lines.join('\n').slice(0, maxChars);
}
