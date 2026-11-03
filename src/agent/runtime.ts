import * as vscode from 'vscode';
import { hashContent } from '../changes/model';
import type { ChangeService } from '../changes/changeService';
import { runApprovedCommand } from '../commands/runner';
import type { SettingsService } from '../config/settings';
import type { CompletionService } from '../providers/completionService';
import type { CancellationTokenLike } from '../providers/types';
import type { Logger } from '../security/logger';
import type { SecretStore } from '../security/secretStore';
import {
  ProjectIntelligenceService,
  type ProjectWorkspaceSource,
} from '../project/intelligence';
import { SessionRepository, type KeyValueStore } from '../sessions/repository';
import type { WorkspaceIndexService } from '../workspace/indexService';
import { AgentOrchestrator } from './orchestrator';
import type { AgentSessionView } from './models';

export interface AgentRuntimeDependencies {
  readonly completion: CompletionService;
  readonly settings: SettingsService;
  readonly secrets: SecretStore;
  readonly logger: Logger;
  readonly workspaceIndex: WorkspaceIndexService;
  readonly changeService: ChangeService;
  readonly sessionStore: KeyValueStore;
}

export interface AgentRuntime {
  readonly controller: AgentOrchestrator;
  readonly intelligence: ProjectIntelligenceService;
  readonly repository: SessionRepository;
  subscribe(listener: (view: AgentSessionView) => void): { dispose(): void };
}

function workspaceRoot(): vscode.WorkspaceFolder | undefined {
  return vscode.workspace.workspaceFolders?.[0];
}

async function readWorkspaceText(path: string): Promise<string | undefined> {
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

async function hashWorkspaceFile(path: string): Promise<string | undefined> {
  const content = await readWorkspaceText(path);
  return content === undefined ? undefined : hashContent(content);
}

/**
 * Builds the extension-side adapters around the pure orchestrator. Local
 * workspace analysis and retrieval stay on disk; only explicitly retrieved,
 * redacted items reach the provider.
 */
export function createAgentRuntime(deps: AgentRuntimeDependencies): AgentRuntime {
  const root = workspaceRoot();
  const source: ProjectWorkspaceSource = {
    rootName: root?.name ?? 'workspace',
    listEntries: () => deps.workspaceIndex.getEntries(),
    readText: (path) => readWorkspaceText(path),
    retrieve: async (query: string, token: CancellationTokenLike) => {
      if (token.isCancellationRequested) {
        const summary = await deps.workspaceIndex.summarize();
        return { summary, items: [], reasons: {}, skipped: [] };
      }
      const secret = await deps.secrets.get();
      return deps.workspaceIndex.retrieve(query, secret);
    },
  };
  const intelligence = new ProjectIntelligenceService(source);
  const repository = new SessionRepository(deps.sessionStore, deps.logger);
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
        signal,
      });
    },
    agentSettings: () => deps.settings.getAgentSettings(),
    commandSettings: () => deps.settings.getCommandSettings(),
    hashFile: hashWorkspaceFile,
    repository,
    logger: deps.logger,
    onChange: (view) => {
      for (const listener of [...listeners]) {
        listener(view);
      }
    },
  });

  return {
    controller,
    intelligence,
    repository,
    subscribe(listener) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
  };
}
