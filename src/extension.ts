import * as vscode from 'vscode';
import type { QuantsMindApi } from './api';
import { ChatViewProvider } from './chat/chatViewProvider';
import { COMMANDS } from './commands/ids';
import { SettingsService } from './config/settings';
import { ContextService } from './context/contextService';
import { CompletionService } from './providers/completionService';
import { validateCredential } from './security/credential';
import { Logger } from './security/logger';
import { API_KEY_SECRET_KEY, SecretStore } from './security/secretStore';

interface ActiveRuntime {
  readonly chatProvider: ChatViewProvider;
  readonly statusBar: vscode.StatusBarItem;
  readonly logger: Logger;
}

let activeRuntime: ActiveRuntime | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<QuantsMindApi> {
  const packageJson = context.extension.packageJSON as { version?: unknown };
  const version = typeof packageJson.version === 'string' ? packageJson.version : '0.1.0';

  const output = vscode.window.createOutputChannel('QuantsMind AI Coder');
  const logger = new Logger({ appendLine: (line) => output.appendLine(line) });
  logger.info(`activating version=${version} vscode=${vscode.version}`);

  const secrets = new SecretStore(context.secrets);
  const settings = new SettingsService();
  const completion = new CompletionService(secrets, settings, logger);
  const contextService = new ContextService(settings);
  const chatProvider = new ChatViewProvider({
    extensionUri: context.extensionUri,
    completion,
    contextService,
    secrets,
    settings,
    logger,
    version,
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
    const value = await vscode.window.showInputBox({
      title: 'QuantsMind: Set API Key',
      prompt:
        'Stored in VS Code SecretStorage. It is never written to settings, logs, or workspace files. Leave empty to cancel.',
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
      await secrets.set(value);
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
    const answer = await vscode.window.showWarningMessage(
      'Remove the API key stored by QuantsMind?',
      { modal: true },
      'Remove',
    );
    if (answer !== 'Remove') {
      return;
    }
    await secrets.clear();
    void vscode.window.showInformationMessage('QuantsMind: API key removed.');
    await refreshAll();
  };

  const configureProvider = async (): Promise<void> => {
    await vscode.commands.executeCommand(
      'workbench.action.openSettings',
      'quantsmind.provider',
    );
  };

  const selectModel = async (): Promise<void> => {
    const current = settings.getProviderSettings().model;
    const value = await vscode.window.showInputBox({
      title: 'QuantsMind: Select Model',
      prompt: 'Enter the model identifier expected by your OpenAI-compatible provider.',
      value: current,
      ignoreFocusOut: true,
      validateInput: (input) =>
        input.trim().length > 0 ? undefined : 'A model name is required.',
    });
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
      { label: '$(key) Set API Key', command: COMMANDS.setApiKey },
      { label: '$(trash) Clear API Key', command: COMMANDS.clearApiKey },
      { label: '$(settings-gear) Configure Provider', command: COMMANDS.configureProvider },
      { label: '$(symbol-parameter) Select Model', command: COMMANDS.selectModel },
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

  register(COMMANDS.openChat, () => chatProvider.reveal());
  register(COMMANDS.newChat, async () => {
    chatProvider.startNewChat();
    await chatProvider.reveal();
  });
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
  register(COMMANDS.selectModel, selectModel);
  register(COMMANDS.showLog, () => output.show());
  register(COMMANDS.showMenu, showMenu);

  context.subscriptions.push(settings.onDidChange(() => void refreshAll()));
  context.subscriptions.push(
    context.secrets.onDidChange((event) => {
      if (event.key === API_KEY_SECRET_KEY) {
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
