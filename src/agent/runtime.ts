import * as vscode from 'vscode';
import { hashContent } from '../changes/model';
import type { ChangeService } from '../changes/changeService';
import { runApprovedCommand } from '../commands/runner';
import type { SettingsService } from '../config/settings';
import type { CompletionService } from '../providers/completionService';
import type { CancellationTokenLike } from '../providers/types';
import type { Logger } from '../security/logger';
import type { SecretStore } from '../security/secretStore';
import { isTrusted, type TrustCheck } from '../security/workspaceTrust';
import {
  ProjectIntelligenceService,
  type ProjectWorkspaceSource,
} from '../project/intelligence';
import { SessionRepository, type KeyValueStore } from '../sessions/repository';
import { CheckpointRepository } from '../sessions/checkpointRepository';
import type { WorkspaceIndexService } from '../workspace/indexService';
import type { RepositoryIntelligenceService } from '../repository/repositoryIntelligence';
import { AgentOrchestrator } from './orchestrator';
import type { AgentSessionView } from './models';
import { AgentToolRegistry, runCodingAgent, type AgentModelClient } from './codingAgent';
import { WorkspaceTools, type AgentFileSystem } from './workspaceTools';
import { ChangeTools } from './changeTools';
import { CommandTools } from './commandTools';
import { RepositoryTools } from './repositoryTools';

export interface AgentRuntimeDependencies {
  readonly completion: CompletionService;
  readonly settings: SettingsService;
  readonly secrets: SecretStore;
  readonly logger: Logger;
  readonly workspaceIndex: WorkspaceIndexService;
  readonly changeService: ChangeService;
  readonly sessionStore: KeyValueStore;
  readonly isTrusted?: TrustCheck;
}

export interface AgentRuntime {
  readonly controller: AgentOrchestrator;
  readonly intelligence: ProjectIntelligenceService;
  readonly repositoryIntelligence: RepositoryIntelligenceService;
  readonly repository: SessionRepository;
  readonly workspaceTools: WorkspaceTools;
  readonly toolRegistry: AgentToolRegistry;
  readonly codingAgent: {
    run(task: string, options?: {
      readonly maxIterations?: number;
      readonly signal?: AbortSignal;
      readonly onEvent?: (event: import('./codingAgent').AgentRunEvent) => void;
    }): Promise<import('./codingAgent').AgentRunResult>;
  };
  subscribe(listener: (view: AgentSessionView) => void): { dispose(): void };
}

function workspaceRoot(): vscode.WorkspaceFolder | undefined {
  return vscode.workspace.workspaceFolders?.[0];
}

async function readWorkspaceText(
  path: string,
  isTrusted: () => boolean,
): Promise<string | undefined> {
  if (!isTrusted()) {
    return undefined;
  }
  const root = workspaceRoot();
  if (root === undefined) {
    return undefined;
  }
  try {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root.uri, path));
    return Buffer.from(bytes).toString('utf8');
  } catch {
    return undefined;
  }
}

async function hashWorkspaceFile(
  path: string,
  isTrusted: () => boolean,
): Promise<string | undefined> {
  const content = await readWorkspaceText(path, isTrusted);
  return content === undefined ? undefined : hashContent(content);
}

/**
 * Builds the extension-side adapters around the pure orchestrator. Local
 * workspace analysis and retrieval stay on disk; only explicitly retrieved,
 * redacted items reach the provider.
 */
export function createAgentRuntime(deps: AgentRuntimeDependencies): AgentRuntime {
  const root = workspaceRoot();
  const trustCheck: TrustCheck = deps.isTrusted ?? (() => vscode.workspace.isTrusted);
  const trusted = (): boolean => isTrusted(trustCheck);
  const source: ProjectWorkspaceSource = {
    rootName: root?.name ?? 'workspace',
    listEntries: async () => (trusted() ? deps.workspaceIndex.getEntries() : []),
    readText: (path) => readWorkspaceText(path, trusted),
    retrieve: async (query: string, token: CancellationTokenLike) => {
      if (token.isCancellationRequested || !trusted()) {
        const summary = await deps.workspaceIndex.summarize();
        return { summary, items: [], reasons: {}, skipped: [] };
      }
      const secret = await deps.secrets.get();
      return deps.workspaceIndex.retrieve(query, secret);
    },
  };
  const intelligence = new ProjectIntelligenceService(source);
  const repository = new SessionRepository(deps.sessionStore, deps.logger);
  const checkpointRepository = new CheckpointRepository(deps.sessionStore, deps.logger);
  const fileSystem: AgentFileSystem = {
    async readFile(path: string): Promise<string> {
      if (!trusted()) {
        throw new Error('Workspace trust is required to read files.');
      }
      const root = workspaceRoot();
      if (root === undefined) {
        throw new Error('Open a workspace folder before reading files.');
      }
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root.uri, path));
      return Buffer.from(bytes).toString('utf8');
    },
    async listDirectory(path: string): Promise<readonly { name: string; type: 'file' | 'directory' }[]> {
      if (!trusted()) {
        throw new Error('Workspace trust is required to list files.');
      }
      const root = workspaceRoot();
      if (root === undefined) {
        throw new Error('Open a workspace folder before listing files.');
      }
      const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.joinPath(root.uri, path));
      return entries.map(([name, type]) => ({
        name,
        type: type === vscode.FileType.Directory ? 'directory' : 'file',
      }));
    },
  };
  const workspaceTools = new WorkspaceTools(root?.uri.fsPath ?? '', fileSystem);
  const repositoryTools = new RepositoryTools(deps.workspaceIndex.repositoryIntelligence());
  const changeTools = new ChangeTools(deps.changeService, async (review) => {
    const answer = await vscode.window.showWarningMessage(
      `Apply ${review.files.length} proposed file change(s)?`,
      { modal: true, detail: review.files.map((file) => `${file.kind}: ${file.path}`).join('\\n') },
      'Apply',
    );
    return answer === 'Apply' ? review.files.map((_, index) => `change-${index + 1}`) : undefined;
  });
  const commandSettings = deps.settings.getCommandSettings();
  const commandTools = new CommandTools({
    cwd: root?.uri.fsPath ?? '',
    workspaceRoot: root?.uri.fsPath ?? '',
    allowlist: commandSettings.allowlist,
    timeoutMs: commandSettings.timeoutMs,
    maxOutputChars: commandSettings.maxOutputChars,
    secret: () => deps.secrets.get(),
    trusted: trusted(),
    approval: async (request) => {
      const answer = await vscode.window.showWarningMessage(
        `Run approved command?\\n${request.command}`,
        { modal: true, detail: `Risk: ${request.risk}\\nDirectory: ${request.cwd}` },
        'Run',
      );
      return answer === 'Run';
    },
  });
  const toolRegistry = new AgentToolRegistry();
  for (const tool of workspaceTools.toAgentTools()) {
    toolRegistry.register(tool);
  }
  for (const tool of repositoryTools.toAgentTools()) {
    toolRegistry.register(tool);
  }
  for (const tool of changeTools.toAgentTools()) {
    toolRegistry.register(tool);
  }
  for (const tool of commandTools.toAgentTools()) {
    toolRegistry.register(tool);
  }
  const model: AgentModelClient = {
    complete: async (messages, options) => {
      const signal = options?.signal;
      const token: CancellationTokenLike = {
        isCancellationRequested: signal?.aborted === true,
        onCancellationRequested(listener) {
          if (signal === undefined) {
            return { dispose() {} };
          }
          const handler = (): void => listener();
          signal.addEventListener('abort', handler, { once: true });
          return { dispose() { signal.removeEventListener('abort', handler); } };
        },
      };
      const result = await deps.completion.complete(messages as never, {
        token,
        tools: options?.tools as never,
        stream: false,
      });
      return {
        text: result.text,
        toolCalls: result.toolCalls,
        finishReason: result.finishReason,
      };
    },
  };
  const codingAgent = {
    run: (task: string, options?: {
      readonly maxIterations?: number;
      readonly signal?: AbortSignal;
      readonly onEvent?: (event: import('./codingAgent').AgentRunEvent) => void;
    }) =>
      runCodingAgent({
        task,
        model,
        tools: toolRegistry.list(),
        maxIterations: options?.maxIterations,
        signal: options?.signal,
        onEvent: options?.onEvent as never,
      }),
  };
  const listeners = new Set<(view: AgentSessionView) => void>();

  const controller = new AgentOrchestrator({
    workspaceRoot: root?.uri.fsPath ?? '',
    complete: (messages, token) => deps.completion.complete(messages, { token }),
    inspect: (token) => intelligence.inspect(token),
    retrieve: (query, token) => intelligence.retrieve(query, token),
    changes: deps.changeService,
    runCommand: async (command, signal) => {
      const folder = workspaceRoot();
      if (folder === undefined) {
        throw new Error('Open a workspace folder before running validation.');
      }
      const commandSettings = deps.settings.getCommandSettings();
      return runApprovedCommand(command, {
        cwd: folder.uri.fsPath,
        workspaceRoot: folder.uri.fsPath,
        allowlist: commandSettings.allowlist,
        timeoutMs: commandSettings.timeoutMs,
        maxOutputChars: commandSettings.maxOutputChars,
        secret: await deps.secrets.get(),
        trusted: trusted(),
        signal,
      });
    },
    agentSettings: () => deps.settings.getAgentSettings(),
    commandSettings: () => deps.settings.getCommandSettings(),
    hashFile: (path) => hashWorkspaceFile(path, trusted),
    analyzeImpact: async (changes, validationCommands) =>
      trusted()
        ? deps.workspaceIndex.analyzeChangeImpact(changes, validationCommands)
        : undefined,
    checkpointRepository,
    repository,
    logger: deps.logger,
    isTrusted: trusted,
    onChange: (view) => {
      for (const listener of [...listeners]) {
        listener(view);
      }
    },
  });

  return {
    controller,
    intelligence,
    repositoryIntelligence: deps.workspaceIndex.repositoryIntelligence(),
    repository,
    workspaceTools,
    toolRegistry,
    codingAgent,
    subscribe(listener) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
  };
}
