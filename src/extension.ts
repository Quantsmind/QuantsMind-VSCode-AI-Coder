import * as vscode from 'vscode';
import type { QuantsMindApi } from './api';
import { createAgentRuntime } from './agent/runtime';
import { ChatViewProvider } from './chat/chatViewProvider';
import { ConversationStore } from './chat/persistence';
import { ChangeHistoryStore } from './changes/history';
import { ChangeService } from './changes/changeService';
import { COMMANDS } from './commands/ids';
import { planProviderModelSwitch } from './config/resolve';
import {
  providerAccessClass,
  providerPricingMetadata,
  type ProviderAccessClass,
} from './providers/profiles';
import { SettingsService } from './config/settings';
import { ContextService } from './context/contextService';
import { CompletionService } from './providers/completionService';
import { setUserAgentVersion } from './providers/openaiCompatible';
import { validateCredential } from './security/credential';
import { Logger } from './security/logger';
import { isProviderApiKeySecretKey, SecretStore } from './security/secretStore';
import { FIRST_RUN_NOTICE_KEY, showFirstRunNotice } from './onboarding/firstRun';
import { WorkspaceIndexService } from './workspace/indexService';
import { SelfDiagnosticsService } from './diagnostics/selfDiagnostics';
import { manageMcpServers } from './commands/mcpManagement';
import { selectWorkspaceRoot } from './workspace/rootPolicy';

interface ActiveRuntime {
  readonly chatProvider: ChatViewProvider;
  readonly statusBar: vscode.StatusBarItem;
  readonly logger: Logger;
  readonly agentRuntime: ReturnType<typeof createAgentRuntime>;
}

let activeRuntime: ActiveRuntime | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<QuantsMindApi> {
  const packageJson = context.extension.packageJSON as { version?: unknown };
  const version = typeof packageJson.version === 'string' ? packageJson.version : 'unknown';
  setUserAgentVersion(version);

  const output = vscode.window.createOutputChannel('QuantsMind AI Coder');
  const logger = new Logger({ appendLine: (line) => output.appendLine(line) });
  logger.info(`activating version=${version} vscode=${vscode.version}`);

  // Multi-root workspaces: the extension operates on exactly one root (the
  // marker-scored selection from rootPolicy.ts). Tell the user which one and
  // why; trust and approvals remain per folder.
  const multiRoot = vscode.workspace.workspaceFolders;
  if (multiRoot !== undefined && multiRoot.length > 1) {
    const selected = selectWorkspaceRoot(
      multiRoot.map((folder) => ({ name: folder.name, index: folder.index, uri: folder.uri })),
    );
    if (selected !== undefined) {
      logger.info(
        `multi-root workspace (${multiRoot.length} folders); selected "${selected.name}" (marker-scored) for indexing, retrieval and changes`,
      );
      void vscode.window.showInformationMessage(
        `QuantsMind: multiple folders are open; operating on "${selected.name}" (most project markers). Trust and change approvals remain per folder.`,
      );
    }
  }

  const secrets = new SecretStore(context.secrets);
  const settings = new SettingsService();
  const completion = new CompletionService(secrets, settings, logger);
  const contextService = new ContextService(settings);
  const conversations = new ConversationStore(context.globalState);
  const workspaceIndex = new WorkspaceIndexService(settings, logger);
  const selfDiagnostics = new SelfDiagnosticsService({
    version,
    completion,
    settings,
    secrets,
    workspaceIndex,
    logger,
  });
  const changeHistory = new ChangeHistoryStore(context.globalState);
  const changeService = new ChangeService(
    settings,
    changeHistory,
    vscode.Uri.joinPath(context.globalStorageUri, 'backups'),
    logger,
  );
  const agentRuntime = createAgentRuntime({
    completion,
    settings,
    secrets,
    logger,
    workspaceIndex,
    changeService,
    sessionStore: context.globalState,
    mcpCredentials: context.secrets,
    isTrusted: () => vscode.workspace.isTrusted,
  });
  const chatProvider = new ChatViewProvider({
    extensionUri: context.extensionUri,
    completion,
    contextService,
    secrets,
    settings,
    logger,
    version,
    conversations,
    workspaceIndex,
    changeService,
    agentRuntime,
  });

  context.subscriptions.push(output);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chatProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );
  context.subscriptions.push({ dispose: () => chatProvider.dispose() });

  const statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  statusBar.name = 'QuantsMind AI Coder';
  statusBar.text = '$(comment-discussion) QuantsMind';
  statusBar.tooltip = 'QuantsMind AI Coder';
  statusBar.command = COMMANDS.showMenu;
  statusBar.show();
  context.subscriptions.push(statusBar);

  const refreshStatusBar = async (): Promise<void> => {
    try {
      const status = await completion.getStatus();
      if (status.configurationError !== undefined) {
        statusBar.text = '$(warning) QuantsMind';
        statusBar.tooltip = `QuantsMind: ${status.configurationError}\nClick for actions.`;
        return;
      }
      if (!status.ready) {
        statusBar.text = '$(key) QuantsMind';
        statusBar.tooltip = [
          'QuantsMind: API key required',
          `${status.displayName} · ${status.model}`,
          `Endpoint: ${status.endpointHost}`,
          'Click for actions.',
        ].join('\n');
        return;
      }
      statusBar.text = '$(comment-discussion) QuantsMind';
      statusBar.tooltip = [
        `QuantsMind · ${status.displayName}`,
        `Model: ${status.model}`,
        `Endpoint: ${status.endpointHost}`,
        status.hasCredential ? 'API key stored in SecretStorage' : 'No API key required',
        'Click for actions.',
      ].join('\n');
    } catch (error) {
      logger.error('failed to refresh status bar', error);
      statusBar.text = '$(warning) QuantsMind';
      statusBar.tooltip = 'QuantsMind: provider status is unavailable.';
    }
  };

  const refreshAll = async (): Promise<void> => {
    await Promise.all([refreshStatusBar(), chatProvider.refreshStatus()]);
  };

  const register = (id: string, handler: () => unknown): void => {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async () => {
        try {
          await handler();
        } catch (error) {
          logger.error(`command ${id} failed`, error);
          const message = error instanceof Error ? error.message : 'Unexpected error.';
          void vscode.window.showErrorMessage(`QuantsMind: ${message}`);
        }
      }),
    );
  };

  const setApiKey = async (): Promise<void> => {
    const providerType = settings.getProviderSettings().type;
    const value = await vscode.window.showInputBox({
      title: `QuantsMind: Set API Key (${providerType})`,
      prompt:
        'Stored in VS Code SecretStorage per provider. It is never written to settings, logs, or workspace files. Leave empty to cancel.',
      password: true,
      ignoreFocusOut: true,
      placeHolder: 'Provider API key',
      validateInput: (input) => {
        if (input.trim().length === 0) {
          return undefined;
        }
        try {
          validateCredential(input);
          return undefined;
        } catch (error) {
          return error instanceof Error ? error.message : 'Invalid API key.';
        }
      },
    });

    if (value === undefined || value.trim().length === 0) {
      return;
    }

    try {
      await secrets.forProvider(providerType).set(value);
    } catch (error) {
      logger.error('failed to store API key', error);
      void vscode.window.showErrorMessage(
        'QuantsMind: The API key could not be stored securely.',
      );
      return;
    }

    void vscode.window.showInformationMessage(
      'QuantsMind: API key saved securely in VS Code SecretStorage.',
    );
    await refreshAll();
  };

  const clearApiKey = async (): Promise<void> => {
    const providerType = settings.getProviderSettings().type;
    const answer = await vscode.window.showWarningMessage(
      `Remove the ${providerType} API key stored by QuantsMind?`,
      { modal: true },
      'Remove',
    );
    if (answer !== 'Remove') {
      return;
    }
    await secrets.forProvider(providerType).clear();
    void vscode.window.showInformationMessage('QuantsMind: API key removed.');
    await refreshAll();
  };

  const configureProvider = async (): Promise<void> => {
    await vscode.commands.executeCommand(
      'workbench.action.openSettings',
      'quantsmind.provider',
    );
  };

  const accessLabel = (access: ProviderAccessClass | undefined): string => {
    switch (access) {
      case 'free-no-key':
        return 'Free · no API key';
      case 'free-tier-key':
        return 'Free tier · API key required';
      case 'paid':
        return 'Paid · API key required';
      case 'local':
        return 'Local · self-hosted';
      case 'custom-unknown':
        return 'Custom endpoint · pricing unknown';
      default:
        return 'Pricing unknown';
    }
  };

  const selectProvider = async (): Promise<void> => {
    const current = settings.getProviderSettings().type;
    const profiles = completion.getProfiles();
    const items = profiles.map((profile) => {
      const access = providerAccessClass(profile.id);
      const pricing = providerPricingMetadata(profile.id);
      let detail = `${profile.defaultBaseUrl ?? 'custom endpoint'}`;
      if (profile.local) {
        detail += ' (local, no API key required)';
      } else if (profile.credential === 'always') {
        detail += ` (API key required · ${accessLabel(access)})`;
      } else if (access === 'free-no-key') {
        detail += ' (no API key required · anonymous service, availability can change)';
      } else {
        detail += ` (${accessLabel(access)})`;
      }
      if (pricing?.anonymousNote) {
        detail += ` · ${pricing.anonymousNote}`;
      }
      return {
        label: profile.displayName,
        description: profile.id,
        detail,
        id: profile.id,
        picked: profile.id === current,
      };
    });
    const picked = await vscode.window.showQuickPick(items, {
      title: 'QuantsMind: Select Provider Profile',
      placeHolder: 'Choose a provider profile',
    });
    if (picked === undefined) {
      return;
    }
    const profile = profiles.find((entry) => entry.id === picked.id);
    const pricing = providerPricingMetadata(picked.id);
    // Never silently switch to a paid provider; require explicit confirmation.
    if (pricing?.access === 'paid') {
      const confirm = await vscode.window.showWarningMessage(
        `Switching to ${profile?.displayName ?? picked.id} (paid provider) may incur charges. ` +
          `Review pricing at ${pricing.pricingSource}. ` +
          'Selecting this provider does not start paid usage, but completions may be billed.',
        { modal: true },
        'Switch to paid provider',
        'Cancel',
      );
      if (confirm !== 'Switch to paid provider') {
        return;
      }
    }
    const baseUrl = profile?.defaultBaseUrl ?? undefined;
    const currentModel = settings.getProviderSettings().model;
    const plan = planProviderModelSwitch(current, picked.id, currentModel);
    let model = plan.model;
    if (plan.requiresChoice) {
      const choice = await vscode.window.showQuickPick(
        [
          {
            label: `Use ${plan.profileDefaultModel}`,
            description: `${profile?.displayName ?? picked.id} default`,
            id: 'default',
          },
          {
            label: `Keep ${currentModel}`,
            description: 'May not be served by the new provider',
            id: 'keep',
          },
        ],
        {
          title: 'QuantsMind: Model for the new provider',
          placeHolder: `"${currentModel}" was selected for ${current}`,
        },
      );
      if (choice === undefined) {
        return;
      }
      model = choice.id === 'default' ? plan.profileDefaultModel : undefined;
    }
    await settings.updateProviderType(picked.id, baseUrl, model);
    await refreshAll();
  };

  const testConnection = async (): Promise<void> => {
    const status = await completion.getStatus();
    const result = await completion.testConnection();
    const detail = [
      `Profile: ${result.displayName} (${result.profileId})`,
      `Endpoint: ${result.endpointHost}`,
      `Reachable: ${result.reachable ? 'yes' : 'no'}`,
      `Authenticated: ${result.authenticated ? 'yes' : 'no'}`,
      `Model available: ${result.modelAvailable ? 'yes' : 'no'}`,
      `Model discovery: ${result.discoveryAvailable ? 'available' : 'unavailable'}`,
      `Code: ${result.code}`,
    ].join('\n');
    logger.info(`connection test ${result.code} ${result.message}`);
    if (result.reachable && result.authenticated && result.modelAvailable) {
      void vscode.window.showInformationMessage(
        `QuantsMind connection test succeeded.\n${detail}`,
        { modal: false },
      );
    } else {
      void vscode.window.showErrorMessage(
        `QuantsMind connection test failed: ${result.message}\n${detail}`,
      );
    }
    void status;
  };

  const selectModel = async (): Promise<void> => {
    const currentSettings = settings.getProviderSettings();
    const current = currentSettings.model;
    const discovery = await completion.listModels();
    let value: string | undefined;
    if (discovery.status === 'available' && discovery.models.length > 0) {
      const items = discovery.models.map((modelId) => ({
        label: modelId,
        description: modelId === current ? 'current' : undefined,
        picked: modelId === current,
        id: modelId,
      }));
      const picked = await vscode.window.showQuickPick(items, {
        title: 'QuantsMind: Select Model (discovered)',
        placeHolder: `Discovered ${discovery.models.length} model(s). Pick one or press Escape to enter manually.`,
      });
      if (picked !== undefined) {
        value = picked.id;
      } else {
        value = await vscode.window.showInputBox({
          title: 'QuantsMind: Select Model',
          prompt: `Model discovery found ${discovery.models.length} model(s). Enter a model manually or cancel.`,
          value: current,
          ignoreFocusOut: true,
          validateInput: (input) =>
            input.trim().length > 0 ? undefined : 'A model name is required.',
        });
      }
    } else {
      value = await vscode.window.showInputBox({
        title: 'QuantsMind: Select Model',
        prompt:
          discovery.status === 'available'
            ? 'Enter the model manually.'
            : `Model discovery is unavailable (${discovery.message}). Enter the model manually.`,
        value: current,
        ignoreFocusOut: true,
        validateInput: (input) =>
          input.trim().length > 0 ? undefined : 'A model name is required.',
      });
    }
    if (value === undefined) {
      return;
    }
    await settings.updateModel(value.trim());
    await refreshAll();
  };

  const showMenu = async (): Promise<void> => {
    interface ActionItem extends vscode.QuickPickItem {
      readonly command: string;
    }
    const items: ActionItem[] = [
      { label: '$(comment-discussion) Open Chat', command: COMMANDS.openChat },
      { label: '$(add) New Chat', command: COMMANDS.newChat },
      { label: '$(map) Summarize Workspace', command: COMMANDS.summarizeWorkspace },
      { label: '$(file-add) Attach Relevant Files', command: COMMANDS.attachRelevantFiles },
      { label: '$(rocket) Start Agent Task', command: COMMANDS.startAgentTask },
      { label: '$(history) Change History', command: COMMANDS.showChangeHistory },
      { label: '$(key) Set API Key', command: COMMANDS.setApiKey },
      { label: '$(trash) Clear API Key', command: COMMANDS.clearApiKey },
      { label: '$(settings-gear) Configure Provider', command: COMMANDS.configureProvider },
      { label: '$(symbol-method) Select Provider Profile', command: COMMANDS.selectProvider },
      { label: '$(plug) Test Provider Connection', command: COMMANDS.testConnection },
      { label: '$(symbol-parameter) Select Model', command: COMMANDS.selectModel },
      { label: '$(plug) Manage MCP Servers', command: COMMANDS.manageMcpServers },
      { label: '$(output) Show Log', command: COMMANDS.showLog },
    ];
    const picked = await vscode.window.showQuickPick(items, {
      title: 'QuantsMind AI Coder',
      placeHolder: 'Choose an action',
    });
    if (picked !== undefined) {
      await vscode.commands.executeCommand(picked.command);
    }
  };

  const summarizeWorkspace = async (): Promise<void> => {
    await chatProvider.summarizeWorkspaceAndReveal();
  };

  const attachRelevantFiles = async (): Promise<void> => {
    const query = await vscode.window.showInputBox({
      title: 'QuantsMind: Attach Relevant Files',
      prompt:
        'Describe the task. Matching workspace paths are attached locally for your review; nothing is sent until you press Send.',
      ignoreFocusOut: true,
      placeHolder: 'For example: authentication middleware and its tests',
    });
    if (query === undefined || query.trim().length === 0) {
      return;
    }
    await chatProvider.attachRelevantFilesAndReveal(query.trim());
  };

  const startAgentTask = async (): Promise<void> => {
    const prompt = await vscode.window.showInputBox({
      title: 'QuantsMind: Start Agent Task',
      prompt:
        'Describe the change. A plan and diffs will be prepared for explicit approval; no file is modified until you approve it.',
      ignoreFocusOut: true,
      placeHolder: 'For example: add retry handling to the provider request',
    });
    if (prompt === undefined || prompt.trim().length === 0) {
      return;
    }
    await chatProvider.startAgentTaskAndReveal(prompt.trim());
  };

  const showChangeHistory = async (): Promise<void> => {
    const entries = changeHistory.list();
    if (entries.length === 0) {
      void vscode.window.showInformationMessage('QuantsMind: no change sets have been recorded.');
      return;
    }

    interface HistoryItem extends vscode.QuickPickItem {
      readonly taskId: string;
      readonly undoable: boolean;
    }

    const items: HistoryItem[] = entries.map((entry) => ({
      label: `${entry.status} · ${entry.summary}`,
      description: entry.updatedAt,
      detail: entry.files.map((file) => `${file.kind}: ${file.path}`).join(', ').slice(0, 300),
      taskId: entry.taskId,
      undoable: entry.undoable,
    }));

    const picked = await vscode.window.showQuickPick(items, {
      title: 'QuantsMind: Change History',
      placeHolder: 'Select an undone change set to restore its backups',
    });
    if (picked === undefined || !picked.undoable) {
      return;
    }

    const confirmation = await vscode.window.showWarningMessage(
      'Restore the files from this change set? Files modified after apply are left untouched.',
      { modal: true },
      'Undo',
    );
    if (confirmation !== 'Undo') {
      return;
    }

    try {
      const outcome = await changeService.undo(picked.taskId);
      if (outcome === undefined) {
        void vscode.window.showWarningMessage('QuantsMind: this change set has no backups to restore.');
        return;
      }
      const failedSuffix = outcome.failed > 0 ? `; ${outcome.failed} restore(s) failed` : '';
      void vscode.window.showInformationMessage(
        `QuantsMind: restored ${outcome.restored} file(s); ${outcome.conflicts} conflict(s)${failedSuffix}.`,
      );
    } catch (error) {
      logger.error('undo from history failed', error);
      void vscode.window.showErrorMessage('QuantsMind: the change set could not be undone.');
    }
  };

  register(COMMANDS.openChat, () => chatProvider.reveal());
  register(COMMANDS.newChat, async () => {
    await chatProvider.startNewChat();
    await chatProvider.reveal();
  });
  register(COMMANDS.summarizeWorkspace, summarizeWorkspace);
  register(COMMANDS.attachRelevantFiles, attachRelevantFiles);
  register(COMMANDS.startAgentTask, startAgentTask);
  register(COMMANDS.showChangeHistory, showChangeHistory);
  register(COMMANDS.explainSelection, () =>
    chatProvider.requestSelection('explain', 'Explain the selected code.'),
  );
  register(COMMANDS.askAboutSelection, () =>
    chatProvider.requestSelection('ask', ''),
  );
  register(COMMANDS.generateCode, () =>
    chatProvider.requestSelection(
      'generate',
      'Suggest a concrete implementation for the selected code.',
    ),
  );
  register(COMMANDS.attachActiveFile, () => chatProvider.attachActiveFileAndReveal());
  register(COMMANDS.setApiKey, setApiKey);
  register(COMMANDS.clearApiKey, clearApiKey);
  register(COMMANDS.configureProvider, configureProvider);
  register(COMMANDS.selectProvider, selectProvider);
  register(COMMANDS.selectModel, selectModel);
  register(COMMANDS.testConnection, testConnection);
  register(COMMANDS.showLog, () => output.show());
  const showVersion = async (): Promise<void> => {
    let providerLine = 'Provider status: unavailable';
    try {
      const status = await completion.getStatus();
      providerLine = `Provider: ${status.displayName} · ${status.model} @ ${status.endpointHost} · ${status.ready ? 'ready' : status.configurationError ?? (status.credentialRequired && !status.hasCredential ? 'API key required' : 'not ready')}`;
    } catch (error) {
      logger.error('version command provider status failed', error);
    }
    const message = [
      'QuantsMind AI Coder',
      `Version: ${version}`,
      'Extension ID: quantsmind.quantsmind-vscode-ai-coder',
      providerLine,
    ].join('\n');
    void vscode.window.showInformationMessage(message, { modal: true });
  };

  const inspectWorkspace = async (): Promise<void> => {
    await chatProvider.summarizeWorkspaceAndReveal();
  };

  const runSelfDiagnostics = async (): Promise<void> => {
    try {
      const path = await selfDiagnostics.runAndSave(context);
      void vscode.window.showInformationMessage(`QuantsMind: self-diagnostics report written to ${path}`);
    } catch (error) {
      logger.error('self-diagnostics failed', error);
      void vscode.window.showErrorMessage('QuantsMind: self-diagnostics failed. See the log.');
    }
  };

  register(COMMANDS.showMenu, showMenu);
  register(COMMANDS.inspectWorkspace, inspectWorkspace);
  register(COMMANDS.runSelfDiagnostics, runSelfDiagnostics);
  register(COMMANDS.showVersion, showVersion);
  const mcpOutputChannel = vscode.window.createOutputChannel('QuantsMind MCP');
  context.subscriptions.push(mcpOutputChannel);
  const manageMcpServersCommand = async (): Promise<void> => {
    await manageMcpServers({
      settings,
      manager: agentRuntime.mcpServerManager,
      outputChannel: mcpOutputChannel,
      trusted: () => vscode.workspace.isTrusted,
      secrets: context.secrets,
    });
  };
  register(COMMANDS.manageMcpServers, manageMcpServersCommand);

  const workspaceWatcher = vscode.workspace.createFileSystemWatcher('**/*');
  const invalidateIndex = (): void => workspaceIndex.invalidate();
  context.subscriptions.push(
    workspaceWatcher,
    workspaceWatcher.onDidCreate(invalidateIndex),
    workspaceWatcher.onDidDelete(invalidateIndex),
    workspaceWatcher.onDidChange((uri) => {
      void workspaceIndex.updateIndexedFile(vscode.workspace.asRelativePath(uri, false));
    }),
    vscode.workspace.onDidRenameFiles(invalidateIndex),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      workspaceIndex.invalidate();
      void refreshAll();
    }),
  );
  context.subscriptions.push(
    settings.onDidChange(() => {
      // Prevent stale provider instances: an in-flight request was dispatched
      // with the old profile/endpoint/model/credential. Cancel it so its
      // result cannot be posted as if it came from the new configuration.
      chatProvider.cancelActiveIfBusy();
      workspaceIndex.invalidate();
      void refreshAll();
    }),
  );
  context.subscriptions.push(
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      workspaceIndex.invalidate();
      void refreshAll();
      chatProvider.refreshWorkspaceTrust();
    }),
  );
  context.subscriptions.push(
    context.secrets.onDidChange((event) => {
      if (isProviderApiKeySecretKey(event.key)) {
        // A credential change must not let an in-flight request dispatched with
        // the old credential finish and post its result as if it were fresh.
        chatProvider.cancelActiveIfBusy();
        void refreshAll();
      }
    }),
  );

  await refreshAll();

  // Automation hosts activate the extension repeatedly against throwaway
  // profiles; an onboarding toast there would be noise, not behaviour.
  if (
    context.extensionMode !== vscode.ExtensionMode.Test &&
    context.extensionMode !== vscode.ExtensionMode.Development
  ) {
    void showFirstRunNotice({
      isShown: () => context.globalState.get<boolean>(FIRST_RUN_NOTICE_KEY, false),
      markShown: async () => context.globalState.update(FIRST_RUN_NOTICE_KEY, true),
      getProvider: async () => completion.getStatus(),
      show: async (message, items) => vscode.window.showInformationMessage(message, ...items),
      runCommand: async (command) => vscode.commands.executeCommand(command),
      onError: (message, error) => logger.error(message, error),
    });
  }

  activeRuntime = { chatProvider, statusBar, logger, agentRuntime };

  return {
    version,
    getProviderStatus: () => completion.getStatus(),
    revealChat: () => chatProvider.reveal(),
  };
}

export function deactivate(): void {
  const runtime = activeRuntime;
  activeRuntime = undefined;
  if (runtime === undefined) {
    return;
  }
  runtime.chatProvider.dispose();
  runtime.statusBar.hide();
  void runtime.agentRuntime.mcpServerManager.disconnectAll().catch(() => undefined);
  runtime.logger.info('deactivated');
}
