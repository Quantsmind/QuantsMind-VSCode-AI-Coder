import * as vscode from 'vscode';
import type { QuantsMindApi } from './api';
import { ChatViewProvider } from './chat/chatViewProvider';
import { ConversationStore } from './chat/persistence';
import { ChangeHistoryStore } from './changes/history';
import { ChangeService } from './changes/changeService';
import { COMMANDS } from './commands/ids';
import { SettingsService } from './config/settings';
import { ContextService } from './context/contextService';
import { CompletionService } from './providers/completionService';
import { validateCredential } from './security/credential';
import { Logger } from './security/logger';
import { isProviderApiKeySecretKey, SecretStore } from './security/secretStore';
import { WorkspaceIndexService } from './workspace/indexService';

interface ActiveRuntime {
  readonly chatProvider: ChatViewProvider;
  readonly statusBar: vscode.StatusBarItem;
  readonly logger: Logger;
}

let activeRuntime: ActiveRuntime | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<QuantsMindApi> {
  const packageJson = context.extension.packageJSON as { version?: unknown };
  const version = typeof packageJson.version === 'string' ? packageJson.version : '1.0.0';

  const output = vscode.window.createOutputChannel('QuantsMind AI Coder');
  const logger = new Logger({ appendLine: (line) => output.appendLine(line) });
  logger.info(`activating version=${version} vscode=${vscode.version}`);

  const secrets = new SecretStore(context.secrets);
  const settings = new SettingsService();
  const completion = new CompletionService(secrets, settings, logger);
  const contextService = new ContextService(settings);
  const conversations = new ConversationStore(context.globalState);
  const workspaceIndex = new WorkspaceIndexService(settings, logger);
  const changeHistory = new ChangeHistoryStore(context.globalState);
  const changeService = new ChangeService(
    settings,
    changeHistory,
    vscode.Uri.joinPath(context.globalStorageUri, 'backups'),
    logger,
  );
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

  const selectProvider = async (): Promise<void> => {
    const current = settings.getProviderSettings().type;
    const profiles = completion.getProfiles();
    const items = profiles.map((profile) => ({
      label: profile.displayName,
      description: profile.id,
      detail:
        profile.adapter === 'gemini'
          ? 'Google Gemini endpoint (API key required)'
          : `${profile.defaultBaseUrl ?? 'custom endpoint'}${profile.local ? ' · local, no API key required' : profile.credential === 'always' ? ' · API key required' : ' · API key required for remote endpoints'}`,
      id: profile.id,
      picked: profile.id === current,
    }));
    const picked = await vscode.window.showQuickPick(items, {
      title: 'QuantsMind: Select Provider Profile',
      placeHolder: 'Choose a provider profile',
    });
    if (picked === undefined) {
      return;
    }
    const profile = profiles.find((entry) => entry.id === picked.id);
    const baseUrl = profile?.defaultBaseUrl ?? undefined;
    await settings.updateProviderType(picked.id, baseUrl);
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
      { label: '$(symbol-parameter) Select Model', command: COMMANDS.selectModel },
      { label: '$(plug) Test Provider Connection', command: COMMANDS.testConnection },
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
      void vscode.window.showInformationMessage(
        `QuantsMind: restored ${outcome.restored} file(s); ${outcome.conflicts} conflict(s).`,
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
  register(COMMANDS.showMenu, showMenu);

  const workspaceWatcher = vscode.workspace.createFileSystemWatcher('**/*');
  const invalidateIndex = (): void => workspaceIndex.invalidate();
  context.subscriptions.push(
    workspaceWatcher,
    workspaceWatcher.onDidCreate(invalidateIndex),
    workspaceWatcher.onDidDelete(invalidateIndex),
    vscode.workspace.onDidRenameFiles(invalidateIndex),
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
    context.secrets.onDidChange((event) => {
      if (isProviderApiKeySecretKey(event.key)) {
        chatProvider.cancelActiveIfBusy();
        void refreshAll();
      }
    }),
  );

  await refreshAll();

  activeRuntime = { chatProvider, statusBar, logger };

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
  runtime.logger.info('deactivated');
}
