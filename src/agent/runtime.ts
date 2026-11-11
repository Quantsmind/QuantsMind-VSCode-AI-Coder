import * as vscode from 'vscode';
import { hashContent } from '../changes/model';
import type { ChangeService } from '../changes/changeService';
import type { SettingsService } from '../config/settings';
import type { CompletionService } from '../providers/completionService';
import type { CancellationTokenLike } from '../providers/types';
import type { Logger } from '../security/logger';
import type { SecretStore, SecretStorageLike } from '../security/secretStore';
import { isTrusted, type TrustCheck } from '../security/workspaceTrust';
import {
  ProjectIntelligenceService,
  type ProjectWorkspaceSource,
} from '../project/intelligence';
import { SessionRepository, type KeyValueStore } from '../sessions/repository';
import { CheckpointRepository } from '../sessions/checkpointRepository';
import type { WorkspaceIndexService } from '../workspace/indexService';
import { selectWorkspaceRoot } from '../workspace/rootPolicy';
import type { RepositoryIntelligenceService } from '../repository/repositoryIntelligence';
import { AgentOrchestrator } from './orchestrator';
import type { AgentSessionView } from './models';
import { AgentToolRegistry, type AgentModelClient } from './codingAgent';
import { DEFAULT_SYSTEM_PROMPT } from './codingAgent';
import { runAgentEngine } from './engine';
import { settingsToEngineLimits } from './execution';
import { buildStackGuidance } from './stackGuidance';
import { cachedLanguageInventory } from '../languages/inventory';
import { describeCapabilities } from '../providers/capabilities';
import { WorkspaceTools, type AgentFileSystem } from './workspaceTools';
import { ChangeTools } from './changeTools';
import { CommandTools } from './commandTools';
import { RepositoryTools } from './repositoryTools';
import { FileSystemTools, type AgentPathFs, type WorkspaceStat } from './fileSystemTools';
import { BuildTools } from './buildTools';
import { ExecutionService } from '../execution/service';
import { GitTools } from './gitTools';
import { CheckpointService } from '../git/checkpointService';
import { GitHubService, type FetchFn, type HttpRequest, type HttpResponse } from '../github/githubService';
import { UsageLedger } from '../providers/usage';
import { PaidProviderConsent, PaidConsentError } from '../providers/paidConsent';
import { getProviderProfile } from '../providers/profiles';
import { TaskContextStore, contextTools } from './context';
import { McpTools } from '../mcp/mcpTools';
import { McpServerManager } from '../mcp/serverManager';
import type { AgentTool } from './codingAgent';

export interface AgentRuntimeDependencies {
  readonly completion: CompletionService;
  readonly settings: SettingsService;
  readonly secrets: SecretStore;
  readonly logger: Logger;
  readonly workspaceIndex: WorkspaceIndexService;
  readonly changeService: ChangeService;
  readonly sessionStore: KeyValueStore;
  readonly isTrusted?: TrustCheck;
  /** VS Code SecretStorage for remote MCP bearer credentials (never written to settings). */
  readonly mcpCredentials?: SecretStorageLike;
}

export interface AgentRuntime {
  readonly controller: AgentOrchestrator;
  readonly intelligence: ProjectIntelligenceService;
  readonly repositoryIntelligence: RepositoryIntelligenceService;
  readonly repository: SessionRepository;
  readonly workspaceTools: WorkspaceTools;
  readonly fileSystemTools: FileSystemTools;
  readonly executionService: ExecutionService;
  readonly checkpointService: CheckpointService;
  readonly usageLedger: UsageLedger;
  readonly taskContext: TaskContextStore;
  readonly mcpServerManager: McpServerManager;
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
  return selectWorkspaceRoot(vscode.workspace.workspaceFolders);
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
  const trustCheck: TrustCheck = deps.isTrusted ?? (() => vscode.workspace.isTrusted);
  const trusted = (): boolean => isTrusted(trustCheck);
  const source: ProjectWorkspaceSource = {
    rootName: () => workspaceRoot()?.name ?? 'workspace',
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
  const workspaceTools = new WorkspaceTools(() => workspaceRoot()?.uri.fsPath ?? '', fileSystem);
  const executionService = new ExecutionService();
  const pathFs: AgentPathFs = {
    async createDirectory(absolutePath: string): Promise<void> {
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(absolutePath));
    },
    async deletePath(absolutePath: string, recursive: boolean): Promise<void> {
      await vscode.workspace.fs.delete(vscode.Uri.file(absolutePath), { recursive, useTrash: false });
    },
    async renamePath(fromAbsolute: string, toAbsolute: string): Promise<void> {
      await vscode.workspace.fs.rename(vscode.Uri.file(fromAbsolute), vscode.Uri.file(toAbsolute), {
        overwrite: false,
      });
    },
    async statPath(absolutePath: string): Promise<WorkspaceStat | undefined> {
      try {
        const stat = await vscode.workspace.fs.stat(vscode.Uri.file(absolutePath));
        return {
          type: (stat.type & vscode.FileType.Directory) !== 0 ? 'directory' : 'file',
          size: stat.size,
        };
      } catch {
        return undefined;
      }
    },
    async exists(absolutePath: string): Promise<boolean> {
      try {
        await vscode.workspace.fs.stat(vscode.Uri.file(absolutePath));
        return true;
      } catch {
        return false;
      }
    },
  };
  const repositoryTools = new RepositoryTools(deps.workspaceIndex.repositoryIntelligence());
  const changeTools = new ChangeTools(deps.changeService, async (review) => {
    const answer = await vscode.window.showWarningMessage(
      `Apply ${review.files.length} proposed file change(s)?`,
      { modal: true, detail: review.files.map((file) => `${file.kind}: ${file.path}`).join('\n') },
      'Apply',
    );
    return answer === 'Apply' ? review.files.map((_, index) => `change-${index + 1}`) : undefined;
  });
  const fileSystemTools = new FileSystemTools({
    rootPath: () => workspaceRoot()?.uri.fsPath ?? '',
    pathFs,
    changes: deps.changeService,
    trusted,
    approval: async (request) => {
      const answer = await vscode.window.showWarningMessage(
        request.details,
        { modal: true, detail: `Operation: ${request.operation}\nPath: ${request.path}` },
        'Apply',
      );
      return answer === 'Apply';
    },
  });
  const commandTools = new CommandTools({
    cwd: () => workspaceRoot()?.uri.fsPath ?? '',
    workspaceRoot: () => workspaceRoot()?.uri.fsPath ?? '',
    allowlist: () => deps.settings.getCommandSettings().allowlist,
    timeoutMs: () => deps.settings.getCommandSettings().timeoutMs,
    maxOutputChars: () => deps.settings.getCommandSettings().maxOutputChars,
    secret: () => deps.secrets.get(),
    trusted,
    approval: async (request) => {
      const answer = await vscode.window.showWarningMessage(
        `Run approved command?\n${request.command}`,
        { modal: true, detail: `Risk: ${request.risk}\nDirectory: ${request.cwd}` },
        'Run',
      );
      return answer === 'Run';
    },
    executionService,
  });
  const buildTools = new BuildTools({
    trusted,
    entries: () => deps.workspaceIndex.getEntries(),
    commandTools,
    executionService,
    languageIntelligence: () => deps.settings.getLanguageIntelligenceSettings().enabled,
  });
  const checkpointService = new CheckpointService();
  const usageLedger = new UsageLedger();
  const taskContext = new TaskContextStore();
  const paidConsent = new PaidProviderConsent();
  const ensurePaidConsent = async (): Promise<void> => {
    const providerSettings = deps.settings.getProviderSettings();
    if (!paidConsent.isPaid(providerSettings.type) || paidConsent.hasConsent(providerSettings.type)) {
      return;
    }
    const profile = getProviderProfile(providerSettings.type);
    const pricing = profile?.pricing;
    const answer = await vscode.window.showWarningMessage(
      `QuantsMind is about to use the paid provider "${profile?.displayName ?? providerSettings.type}" on your behalf.`,
      {
        modal: true,
        detail:
          `Access class: ${profile?.access ?? 'paid'}\n` +
          `Pricing reference: ${pricing?.pricingSource ?? 'not disclosed by the provider'}\n` +
          'Calling this provider may incur charges. Granting consent applies to this window session; it is never persisted.',
      },
      'Allow paid usage',
    );
    if (answer === 'Allow paid usage') {
      paidConsent.grantConsent(providerSettings.type);
      return;
    }
    throw new PaidConsentError(providerSettings.type, profile?.access ?? 'paid');
  };
  const httpFetch: FetchFn = async (request: HttpRequest): Promise<HttpResponse> => {
    const res = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      ...(request.body !== undefined ? { body: request.body } : {}),
    });
    const text = await res.text();
    const json: unknown = (() => {
      try {
        return text.length > 0 ? (JSON.parse(text) as unknown) : undefined;
      } catch {
        return undefined;
      }
    })();
    const headers: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      headers[key] = value;
    });
    return { status: res.status, json, text, headers };
  };
  const githubTokenProvider = async (): Promise<string | undefined> => {
    try {
      const session = await vscode.authentication.getSession('github', ['repo', 'read:user'], { createIfNone: false });
      return session?.accessToken;
    } catch {
      return undefined;
    }
  };
  const githubService = new GitHubService(httpFetch, githubTokenProvider);
  const gitTools = new GitTools({
    workspaceRoot: () => workspaceRoot()?.uri.fsPath ?? '',
    trusted,
    approval: async (request) => {
      const answer = await vscode.window.showWarningMessage(
        request.detail,
        {
          modal: true,
          detail: `Operation: ${request.operation}${
            request.files !== undefined && request.files.length > 0
              ? `\nFiles: ${request.files.slice(0, 12).join(', ')}${request.files.length > 12 ? ' …' : ''}`
              : ''
          }`,
        },
        'Apply',
      );
      return answer === 'Apply';
    },
    github: githubService,
    githubRemoteName: () => 'origin',
    checkpointService,
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
  for (const tool of fileSystemTools.toAgentTools()) {
    toolRegistry.register(tool);
  }
  for (const tool of commandTools.toAgentTools()) {
    toolRegistry.register(tool);
  }
  for (const tool of buildTools.toAgentTools()) {
    toolRegistry.register(tool);
  }
  for (const tool of gitTools.toAgentTools()) {
    toolRegistry.register(tool);
  }
  const mcpServerManager = new McpServerManager({
    ...(deps.mcpCredentials !== undefined ? { credentials: deps.mcpCredentials } : {}),
  });
  const mcpTools = new McpTools({
    servers: () =>
      deps.settings
        .getMcpSettings()
        .servers.filter((entry) => entry.enabled)
        .map((entry) =>
          entry.transport === 'streamable-http'
            ? {
                name: entry.name,
                transport: 'streamable-http' as const,
                ...(entry.url !== undefined ? { url: entry.url } : {}),
                auth: entry.auth,
                timeoutMs: entry.timeoutMs,
                maxToolOutputChars: entry.maxToolOutputChars,
              }
            : {
                name: entry.name,
                transport: 'stdio' as const,
                ...(entry.command !== undefined ? { command: entry.command } : {}),
                args: entry.args ?? [],
                auth: 'none' as const,
                timeoutMs: entry.timeoutMs,
                maxToolOutputChars: entry.maxToolOutputChars,
              },
        ),
    trusted,
    manager: mcpServerManager,
    approval: async (request) => {
      const answer = await vscode.window.showWarningMessage(
        request.detail,
        {
          modal: true,
          detail: `Operation: ${request.operation}`,
        },
        'Apply',
      );
      return answer === 'Apply';
    },
    launchApproval: async (request) => {
      const isRemote = request.transport === 'streamable-http';
      const detail = isRemote
        ? `  Endpoint: ${request.endpoint ?? '(missing endpoint)'}\n` +
          '  Transport: Streamable HTTP\n' +
          `  Authentication: ${request.auth === 'bearer' ? 'Bearer (credential from SecretStorage)' : 'none'}\n` +
          `  Origin: ${request.launchOrigin}\n\n` +
          'This connects to a remote server chosen by your configuration. ' +
          'Its output is untrusted data. Only connect to servers you trust.'
        : `  Command: ${request.command}\n` +
          `  Arguments: ${(request.args ?? []).join(' ') || '(none)'}\n` +
          `  Origin: ${request.launchOrigin}\n\n` +
          'This starts an external process chosen by your configuration. ' +
          'It is not sandboxed. Only launch servers you trust.';
      const answer = await vscode.window.showWarningMessage(
        `Launch MCP server "${request.name}"?`,
        { modal: true, detail },
        'Launch server',
      );
      return answer === 'Launch server';
    },
  });
  for (const tool of mcpTools.toAgentTools()) {
    toolRegistry.register(tool);
  }
  for (const tool of contextTools(taskContext)) {
    toolRegistry.register(tool);
  }
  const getUsageTool: AgentTool = {
    name: 'get_usage',
    description: 'Report token usage recorded for the current agent session (prompt/completion/total per provider). Rates are never invented; cost requires an explicit rate card.',
    parameters: { type: 'object', properties: { provider: { type: 'string' } } },
    async execute(args) {
      const provider = typeof args.provider === 'string' && args.provider.trim().length > 0 ? args.provider.trim() : undefined;
      const summary = usageLedger.summary(provider);
      const providerSettings = deps.settings.getProviderSettings();
      return {
        ok: true,
        tool: 'get_usage',
        output: JSON.stringify({
          session: summary,
          activeProvider: providerSettings.type,
          note: 'Rates are never estimated without an explicit rate card supplied by the host.',
        }, null, 2),
        durationMs: 0,
      };
    },
  };
  toolRegistry.register(getUsageTool);
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
      const capabilities = describeCapabilities(deps.settings.getProviderSettings());
      // Native tool definitions are only sent when the selected provider AND
      // model support them. Everything else uses the JSON-text fallback in
      // normalizeModelResponse, so no tool definitions are transmitted to them.
      const nativeTools = capabilities.nativeToolCalling ? options?.tools : undefined;
      await ensurePaidConsent();
      const result = await deps.completion.complete(messages, {
        token,
        tools: nativeTools,
        stream: false,
      });
      const providerSettings = deps.settings.getProviderSettings();
      usageLedger.record(providerSettings.type, providerSettings.model, result.usage);
      return {
        text: result.text,
        toolCalls: result.toolCalls,
        finishReason: result.finishReason,
      };
    },
  };
  const buildStackGuidanceForTask = async (): Promise<string> => {
    try {
      if (!deps.settings.getLanguageIntelligenceSettings().enabled) {
        return '';
      }
      const entries = await deps.workspaceIndex.getEntries();
      const inventory = cachedLanguageInventory(entries);
      const hasKarkain = entries.some((entry) => String(entry.path ?? '').toLowerCase().endsWith('.kark'));
      // Package-manager detection is best-effort; a failure must not drop guidance.
      let packageManager: string | undefined;
      try {
        const inspection = await intelligence.inspect({
          isCancellationRequested: false,
          onCancellationRequested: () => ({ dispose() {} }),
        });
        packageManager = typeof inspection.packageManager === 'string' && inspection.packageManager.length > 0
          ? inspection.packageManager
          : undefined;
      } catch {
        packageManager = undefined;
      }
      const activeLanguageId = vscode.window.activeTextEditor?.document.languageId;
      return buildStackGuidance({
        inventory,
        ...(packageManager !== undefined ? { packageManager } : {}),
        hasKarkain,
        ...(activeLanguageId !== undefined ? { activeLanguageId } : {}),
      });
    } catch {
      // Guidance is best-effort; the default prompt is fully usable without it.
      return '';
    }
  };
  const codingAgent = {
    run: async (task: string, options?: {
      readonly maxIterations?: number;
      readonly signal?: AbortSignal;
      readonly onEvent?: (event: import('./codingAgent').AgentRunEvent) => void;
    }): Promise<import('./codingAgent').AgentRunResult> => {
      const guidance = await buildStackGuidanceForTask();
      const agentic = settingsToEngineLimits(deps.settings.getAgenticEngineSettings());
      const outcome = await runAgentEngine({
        task,
        model,
        tools: toolRegistry.list(),
        limits: {
          ...agentic,
          maxIterations: options?.maxIterations ?? agentic.maxIterations,
        },
        signal: options?.signal,
        onEvent: options?.onEvent,
        ...(guidance.length > 0 ? { systemPrompt: `${DEFAULT_SYSTEM_PROMPT}${guidance}` } : {}),
      });
      const mappedStatus = outcome.status === 'blocked' || outcome.status === 'recovery-required' || outcome.status === 'paused'
        ? 'limit'
        : outcome.status === 'error' ? 'error'
          : outcome.status;
      return {
        status: mappedStatus,
        finalText: outcome.finalText,
        iterations: outcome.iterations,
        toolResults: outcome.toolResults,
        messages: outcome.messages,
        engineOutcome: {
          status: outcome.status,
          evaluation: outcome.evaluation,
          toolCalls: outcome.toolCalls,
          revisions: outcome.revisions,
          filesChanged: outcome.filesChanged.length,
          ...(outcome.limitReached !== undefined ? { limitReached: outcome.limitReached } : {}),
        },
      };
    },
  };
  const listeners = new Set<(view: AgentSessionView) => void>();

  const controller = new AgentOrchestrator({
    workspaceRoot: () => workspaceRoot()?.uri.fsPath ?? '',
    complete: async (messages, token) => {
      await ensurePaidConsent();
      const result = await deps.completion.complete(messages, { token });
      const providerSettings = deps.settings.getProviderSettings();
      usageLedger.record(providerSettings.type, providerSettings.model, result.usage);
      return result;
    },
    inspect: (token) => intelligence.inspect(token),
    retrieve: (query, token) => intelligence.retrieve(query, token),
    changes: deps.changeService,
    runCommand: async (command, signal, taskId) => {
      const folder = workspaceRoot();
      if (folder === undefined) {
        throw new Error('Open a workspace folder before running validation.');
      }
      const commandSettings = deps.settings.getCommandSettings();
      const record = await executionService.run(command, {
        cwd: folder.uri.fsPath,
        workspaceRoot: folder.uri.fsPath,
        allowlist: commandSettings.allowlist,
        timeoutMs: commandSettings.timeoutMs,
        maxOutputChars: commandSettings.maxOutputChars,
        secret: await deps.secrets.get(),
        trusted: trusted(),
        signal,
        kind: 'command',
        ...(taskId !== undefined ? { taskId } : {}),
      });
      return record as unknown as import('../commands/runner').CommandResult;
    },
    agentSettings: () => deps.settings.getAgentSettings(),
    executionLimits: () => settingsToEngineLimits(deps.settings.getAgenticEngineSettings()),
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
    fileSystemTools,
    executionService,
    checkpointService,
    usageLedger,
    taskContext,
    mcpServerManager,
    toolRegistry,
    codingAgent,
    subscribe(listener) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
  };
}
