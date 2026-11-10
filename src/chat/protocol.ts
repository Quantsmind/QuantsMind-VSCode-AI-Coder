import type {
  AgentSessionView,
  AgentState,
  ApprovalKind,
  CompletionReport,
} from '../agent/models';
import type { ProviderStatus } from '../providers/completionService';
import type { SelectedContextFile } from '../repository/contextSelection';
import type { RepositoryOverview } from '../repository/discovery';
import type { ArchitectureAnalysis } from '../project/architecture';
import type { KarkainModuleGraph, KarkainProjectSummary } from '../project/karkain';
import type { AttachmentDisplay } from './attachmentContext';
import { isChatMode, type ChatMode } from './prompts';

/** Sizes of the parts of a request, measured from the messages actually sent. */
export interface RequestBreakdown {
  readonly messages: number;
  readonly systemChars: number;
  readonly historyMessages: number;
  readonly historyChars: number;
  readonly promptChars: number;
  readonly attachmentItems: number;
  readonly attachmentChars: number;
  readonly totalChars: number;
}

/** What the provider-bound session actually holds for the active conversation. */
export interface HistoryState {
  readonly conversationId: string;
  readonly messages: number;
  readonly chars: number;
  readonly restored: boolean;
  readonly transcriptMessages: number;
  readonly attachmentTurns: number;
  readonly unavailableAttachments: number;
}

export interface ConversationSummary {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly messageCount: number;
}

export interface SessionSummary {
  readonly id: string;
  readonly state: AgentState;
  readonly requirement: string;
  readonly updatedAt: string;
  readonly needsReview: boolean;
  readonly pausedFrom?: AgentState;
  readonly taskCount: number;
  readonly completedTasks: number;
  readonly pendingApproval?: ApprovalKind;
  readonly reportOutcome?: CompletionReport['outcome'];
  /** Plain-language description of the current operation, from recorded state. */
  readonly activity: string;
  /** Validation coverage, e.g. `1 passed, 1 skipped`. */
  readonly validation: string;
}

export interface TranscriptMessage {
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly attachments: readonly string[];
  readonly attachmentDetails?: readonly AttachmentDisplay[];
  readonly localOnly?: boolean;
}

export interface AttachmentSummary {
  readonly id: string;
  readonly path: string;
  readonly languageId?: string;
  readonly isSelection: boolean;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly chars: number;
  readonly redactions: number;
  /** `workspace` marks content QuantsMind discovered; `user` marks explicit choices. */
  readonly origin?: 'user' | 'workspace';
}

export interface RepositoryDependencyView {
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly heuristicEdges: number;
  readonly unresolvedCount: number;
  readonly cycleCount: number;
  readonly truncated: boolean;
  readonly hotspots: readonly {
    readonly path: string;
    readonly dependents: number;
    readonly dependencies: number;
    readonly publicApi: boolean;
  }[];
  readonly cycles: readonly (readonly string[])[];
  readonly unresolved: readonly {
    readonly from: string;
    readonly specifier: string;
    readonly reason: string;
    readonly confidence: 'confirmed' | 'heuristic';
  }[];
}

export interface KarkainProjectView {
  readonly summary: KarkainProjectSummary;
  readonly graph: KarkainModuleGraph;
}

export interface RepositoryView {
  readonly overview: RepositoryOverview;
  readonly summary: string;
  readonly dependencies: RepositoryDependencyView;
  readonly architecture?: ArchitectureAnalysis;
  readonly karkain?: KarkainProjectView;
}

export type WebviewToHostMessage =
  | { readonly type: 'ready' }
  | { readonly type: 'send'; readonly prompt: string; readonly mode: ChatMode }
  | { readonly type: 'stop' }
  | { readonly type: 'newChat' }
  | { readonly type: 'attachSelection' }
  | { readonly type: 'attachActiveFile' }
  | { readonly type: 'attachFiles' }
  | { readonly type: 'removeAttachment'; readonly id: string }
  | { readonly type: 'clearAttachments' }
  | { readonly type: 'explainSelection' }
  | { readonly type: 'setApiKey' }
  | { readonly type: 'clearApiKey' }
  | { readonly type: 'openSettings' }
  | { readonly type: 'showLog' }
  | { readonly type: 'refreshStatus' }
  | { readonly type: 'selectProvider' }
  | { readonly type: 'selectModel' }
  | { readonly type: 'startSession'; readonly requirement: string }
  | { readonly type: 'approvePlan'; readonly sessionId: string; readonly requestId: string }
  | { readonly type: 'rejectPlan'; readonly sessionId: string; readonly requestId: string }
  | {
      readonly type: 'approveChangeSet';
      readonly sessionId: string;
      readonly ids: readonly string[];
      readonly requestId: string;
    }
  | { readonly type: 'rejectChangeSet'; readonly sessionId: string; readonly requestId: string }
  | {
      readonly type: 'approveRepair';
      readonly sessionId: string;
      readonly ids: readonly string[];
      readonly requestId: string;
    }
  | { readonly type: 'rejectRepair'; readonly sessionId: string; readonly requestId: string }
  | { readonly type: 'requestValidation'; readonly sessionId: string; readonly command: string }
  | { readonly type: 'approveValidation'; readonly sessionId: string; readonly requestId: string }
  | { readonly type: 'rejectValidation'; readonly sessionId: string; readonly requestId: string }
  | { readonly type: 'generateRepair'; readonly sessionId: string }
  | { readonly type: 'pauseSession'; readonly sessionId: string }
  | { readonly type: 'resumeSession'; readonly sessionId: string }
  | { readonly type: 'cancelSession'; readonly sessionId: string }
  | { readonly type: 'restoreSession'; readonly sessionId: string }
  | { readonly type: 'deleteSession'; readonly sessionId: string }
  | { readonly type: 'focusSession'; readonly sessionId: string }
  | { readonly type: 'undoSession'; readonly sessionId: string }
  | { readonly type: 'refreshSessions' }
  | { readonly type: 'newConversation' }
  | { readonly type: 'clearConversation' }
  | { readonly type: 'restorePreviousConversation'; readonly id?: string }
  | { readonly type: 'switchConversation'; readonly id: string }
  | { readonly type: 'deleteConversation'; readonly id: string }
  | { readonly type: 'summarizeWorkspace' }
  | { readonly type: 'inspectRepository' }
  | { readonly type: 'inspectGitStatus' }
  | { readonly type: 'explainRepositoryContext'; readonly query: string }
  | { readonly type: 'attachRelevantFiles'; readonly query: string };

export interface ExecutionView {
  readonly id: string;
  readonly kind: 'command' | 'build' | 'test';
  readonly command: string;
  readonly cwd: string;
  readonly state: 'running' | 'finished';
  readonly startedAt: string;
  readonly status?: 'succeeded' | 'failed' | 'cancelled' | 'timed-out';
  readonly durationMs?: number;
  readonly exitCode?: number | null;
  readonly output?: string;
  readonly truncated?: boolean;
  readonly timedOut?: boolean;
  readonly cancelled?: boolean;
  readonly diagnostics?: number;
  readonly tests?: { readonly passed?: number; readonly failed?: number; readonly skipped?: number; readonly total?: number };
}

export interface GitCheckpointView {
  readonly id: string;
  readonly taskId: string;
  readonly label?: string;
  readonly fileCount: number;
  readonly createdAt: string;
}

export interface GitStatusView {
  readonly root?: string;
  readonly branch: string;
  readonly headShort?: string;
  readonly remote?: string;
  readonly staged: number;
  readonly modified: number;
  readonly untracked: number;
  readonly deleted: number;
  readonly conflicts: number;
  readonly clean: boolean;
  readonly mergeInProgress: boolean;
  readonly rebaseInProgress: boolean;
  readonly entries: readonly {
    readonly path: string;
    readonly state: 'staged' | 'modified' | 'staged-modified' | 'added' | 'deleted' | 'staged-deleted' | 'renamed' | 'copied' | 'untracked' | 'conflict';
  }[];
  readonly log: readonly { readonly shortSha: string; readonly subject: string; readonly author: string; readonly date: string }[];
  readonly checkpoints: readonly GitCheckpointView[];
  readonly github?: {
    readonly openIssues: number;
    readonly openPullRequests: number;
    readonly connected: boolean;
  };
}

export type HostToWebviewMessage =
  | {
      readonly type: 'init';
      readonly status: ProviderStatus;
      readonly attachments: readonly AttachmentSummary[];
      readonly maxPromptChars: number;
      readonly version: string;
      readonly conversations: readonly ConversationSummary[];
      readonly activeConversationId: string;
      readonly transcript: readonly TranscriptMessage[];
      readonly validationCommands: readonly string[];
      readonly workspaceName?: string;
      readonly sessions: readonly SessionSummary[];
      readonly activeSessionId?: string;
      readonly history: HistoryState;
    }
  | { readonly type: 'status'; readonly status: ProviderStatus }
  | {
      readonly type: 'history';
      readonly history: HistoryState;
      readonly warnings: readonly string[];
    }
  | {
      readonly type: 'requestContext';
      readonly id: string;
      readonly breakdown: RequestBreakdown;
      readonly attachments: readonly AttachmentDisplay[];
    }
  | { readonly type: 'attachments'; readonly attachments: readonly AttachmentSummary[] }
  | {
      readonly type: 'draft';
      readonly prompt: string;
      readonly mode: ChatMode;
      readonly attachments: readonly AttachmentSummary[];
    }
  | {
      readonly type: 'userMessage';
      readonly text: string;
      readonly attachments: readonly AttachmentSummary[];
    }
  | { readonly type: 'assistantStart'; readonly id: string; readonly model: string }
  | { readonly type: 'assistantDelta'; readonly id: string; readonly delta: string }
  | {
      readonly type: 'assistantEnd';
      readonly id: string;
      readonly finishReason?: string;
      readonly usage?: {
        readonly promptTokens?: number;
        readonly completionTokens?: number;
        readonly totalTokens?: number;
      };
    }
  | { readonly type: 'assistantCancelled'; readonly id: string }
  | {
      readonly type: 'error';
      readonly message: string;
      readonly hint?: string;
      readonly code?: string;
    }
  | { readonly type: 'busy'; readonly busy: boolean }
  | { readonly type: 'notice'; readonly level: 'info' | 'warn' | 'error'; readonly message: string }
  | {
      readonly type: 'agentToolResult';
      readonly tool: string;
      readonly ok: boolean;
      readonly message: string;
      readonly output?: string;
    }
  | { readonly type: 'clear' }
  | {
      readonly type: 'conversations';
      readonly conversations: readonly ConversationSummary[];
      readonly activeConversationId: string;
    }
  | {
      readonly type: 'conversation';
      readonly id: string;
      readonly title: string;
      readonly transcript: readonly TranscriptMessage[];
      readonly history?: HistoryState;
    }
  | {
      readonly type: 'sessions';
      readonly sessions: readonly SessionSummary[];
      readonly activeSessionId?: string;
    }
  | { readonly type: 'session'; readonly session: AgentSessionView }
  | { readonly type: 'sessionRemoved'; readonly id: string }
  | {
      readonly type: 'sessionError';
      readonly sessionId?: string;
      readonly message: string;
      readonly hint?: string;
    }
  | {
      readonly type: 'workspaceSummary';
      readonly text: string;
      readonly fileCount: number;
      readonly truncated: boolean;
    }
  | { readonly type: 'repository'; readonly repository: RepositoryView }
  | {
      readonly type: 'contextSelection';
      readonly query: string;
      readonly selections: readonly SelectedContextFile[];
      readonly truncated: boolean;
      readonly text: string;
    }
  | {
      readonly type: 'undoResult';
      readonly taskId: string;
      readonly restored: number;
      readonly conflicts: number;
      readonly messages: readonly string[];
    }
  | {
      readonly type: 'commandOutput';
      readonly command: string;
      readonly cwd: string;
      readonly output: string;
      readonly exitCode: number | null;
      readonly timedOut: boolean;
      readonly cancelled: boolean;
    }
  | { readonly type: 'execution'; readonly execution: ExecutionView }
  | { readonly type: 'executionHistory'; readonly executions: readonly ExecutionView[] }
  | { readonly type: 'gitSnapshot'; readonly snapshot: GitStatusView };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200;
}

/**
 * A decision is only accepted when it names the request the user actually saw.
 * A missing or malformed id drops the whole message: keeping the message but
 * losing the binding would let a stale approval card act on the current
 * request, so there is no fallback to the pending request.
 */
function readRequestId(record: Record<string, unknown>): string | undefined {
  return isId(record.requestId) ? record.requestId : undefined;
}

/**
 * Strictly parses messages received from the webview. Unknown or malformed
 * messages are ignored rather than trusted.
 */
export function parseWebviewMessage(raw: unknown): WebviewToHostMessage | undefined {
  const record = asRecord(raw);
  if (record === undefined) {
    return undefined;
  }

  switch (record.type) {
    case 'ready':
    case 'stop':
    case 'newChat':
    case 'attachSelection':
    case 'attachActiveFile':
    case 'attachFiles':
    case 'clearAttachments':
    case 'explainSelection':
    case 'setApiKey':
    case 'clearApiKey':
    case 'openSettings':
    case 'showLog':
    case 'refreshStatus':
    case 'refreshSessions':
    case 'selectProvider':
    case 'selectModel':
    case 'newConversation':
    case 'clearConversation':
    case 'summarizeWorkspace':
    case 'inspectGitStatus':
    case 'inspectRepository':
      return { type: record.type };
    case 'explainRepositoryContext':
      if (typeof record.query !== 'string') {
        return undefined;
      }
      return { type: 'explainRepositoryContext', query: record.query };
    case 'startSession':
      if (typeof record.requirement !== 'string') {
        return undefined;
      }
      return { type: 'startSession', requirement: record.requirement };
    case 'generateRepair':
    case 'pauseSession':
    case 'resumeSession':
    case 'cancelSession':
    case 'restoreSession':
    case 'deleteSession':
    case 'focusSession':
    case 'undoSession':
      if (!isId(record.sessionId)) {
        return undefined;
      }
      return { type: record.type, sessionId: record.sessionId };
    case 'approvePlan':
    case 'rejectPlan':
    case 'rejectChangeSet':
    case 'rejectRepair':
    case 'approveValidation':
    case 'rejectValidation': {
      const requestId = readRequestId(record);
      if (!isId(record.sessionId) || requestId === undefined) {
        return undefined;
      }
      return { type: record.type, sessionId: record.sessionId, requestId };
    }
    case 'requestValidation':
      if (!isId(record.sessionId) || typeof record.command !== 'string') {
        return undefined;
      }
      return {
        type: 'requestValidation',
        sessionId: record.sessionId,
        command: record.command,
      };
    case 'approveChangeSet':
    case 'approveRepair': {
      const requestId = readRequestId(record);
      if (!isId(record.sessionId) || !Array.isArray(record.ids) || requestId === undefined) {
        return undefined;
      }
      const ids = record.ids.filter(isId).slice(0, 100);
      return { type: record.type, sessionId: record.sessionId, ids, requestId };
    }
    case 'restorePreviousConversation':
      if (record.id === undefined) {
        return { type: record.type };
      }
      return isId(record.id) ? { type: record.type, id: record.id } : undefined;
    case 'switchConversation':
    case 'deleteConversation':
      if (!isId(record.id)) {
        return undefined;
      }
      return { type: record.type, id: record.id };
    case 'attachRelevantFiles':
      if (typeof record.query !== 'string') {
        return undefined;
      }
      return { type: 'attachRelevantFiles', query: record.query };
    case 'send': {
      if (typeof record.prompt !== 'string') {
        return undefined;
      }
      return {
        type: 'send',
        prompt: record.prompt,
        mode: isChatMode(record.mode) ? record.mode : 'ask',
      };
    }
    case 'removeAttachment': {
      if (typeof record.id !== 'string' || record.id.length === 0 || record.id.length > 100) {
        return undefined;
      }
      return { type: 'removeAttachment', id: record.id };
    }
    default:
      return undefined;
  }
}
