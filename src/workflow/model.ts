/**
 * v2.5.5 coding-workflow model.
 *
 * The workflow layer coordinates the pieces that already exist (task context,
 * planning, change sets, approval, continuation, language intelligence)
 * rather than replacing them. Everything here is bounded, deterministic and
 * reviewable by the user; nothing executes edits or commands by itself.
 */
export const WORKFLOW_CATEGORIES = [
  'bugfix',
  'feature',
  'refactor',
  'test',
  'docs',
  'dependency',
  'cross-language',
  'other',
] as const;

export type WorkflowCategory = (typeof WORKFLOW_CATEGORIES)[number];

/**
 * Coarse lifecycle for a coding task. These are the user-facing states tracked
 * as workflow checkpoints; they deliberately overlap the in-memory
 * AgentState/TaskStatus machine instead of replacing it.
 */
export const WORKFLOW_PHASES = [
  'created',
  'planned',
  'awaiting-review',
  'approved',
  'editing',
  'changes-applied',
  'validation-pending',
  'validation-complete',
  'blocked',
  'cancelled',
  'completed',
] as const;

export type WorkflowPhase = (typeof WORKFLOW_PHASES)[number];

export const MAX_SCOPE_ITEMS = 12;
export const MAX_EVIDENCE_ITEMS = 16;
export const MAX_ASSUMPTIONS = 10;
export const MAX_COMPLETION_CRITERIA = 10;
export const MAX_EXPECTED_FILES = 30;

export type WorkflowEvidenceKind = 'task' | 'language' | 'manifest' | 'build' | 'repo' | 'change';

export interface WorkflowEvidence {
  readonly kind: WorkflowEvidenceKind;
  readonly text: string;
}

/**
 * A structured, evidence-grounded plan for a substantial coding task. The
 * `developmentPlan` payload keeps the existing task/dependency validation and
 * approval flow intact; the envelope adds routing, category classification,
 * evidence vs assumptions and the expected-change set used for scope tracking.
 */
export interface CodingTaskPlan {
  readonly id: string;
  readonly category: WorkflowCategory;
  readonly objective: string;
  readonly scope: readonly string[];
  /** Facts established locally (never attributed to the model alone). */
  readonly evidence: readonly WorkflowEvidence[];
  /** Model-proposed claims that still need verification. */
  readonly assumptions: readonly string[];
  readonly risks: readonly string[];
  /** Files the plan expects to touch; reviewers track applied files against this. */
  readonly expectedFiles: readonly string[];
  readonly completionCriteria: readonly string[];
  readonly validationStrategy: string;
  readonly createdAt: string;
}

export const MAX_CATEGORY_CONFIDENCE = ['confirmed', 'heuristic'] as const;
export type WorkflowCategoryConfidence = (typeof MAX_CATEGORY_CONFIDENCE)[number];

export interface TaskClassification {
  readonly category: WorkflowCategory;
  /** 'confirmed' when a category keyword matched strongly; 'heuristic' otherwise. */
  readonly confidence: WorkflowCategoryConfidence;
  readonly matched: readonly string[];
}

export interface StructuredPlanRouting {
  /** True when this task should produce a structured plan instead of an inline edit. */
  readonly required: boolean;
  readonly reasons: readonly string[];
  /** True when the task involves multiple files or multiple languages. */
  readonly multiFileSignals: readonly string[];
}
