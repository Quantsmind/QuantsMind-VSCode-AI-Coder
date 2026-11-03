import * as vscode from 'vscode';
import { CONFIG_SECTION } from './defaults';
import {
  resolveContextSettings,
  resolveProviderSettings,
  type ResolvedContextSettings,
  type ResolvedProviderSettings,
} from './resolve';

/**
 * Reads configuration from VS Code on demand. Provider settings are declared
 * with application scope, so workspace settings cannot redirect requests.
 */
export class SettingsService {
  getProviderSettings(): ResolvedProviderSettings {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    return resolveProviderSettings({
      type: config.get<unknown>('provider.type'),
      baseUrl: config.get<unknown>('provider.baseUrl'),
      model: config.get<unknown>('provider.model'),
      timeoutMs: config.get<unknown>('provider.requestTimeoutMs'),
      maxOutputTokens: config.get<unknown>('provider.maxOutputTokens'),
      temperature: config.get<unknown>('provider.temperature'),
      stream: config.get<unknown>('provider.stream'),
      allowInsecureLocalhost: config.get<unknown>('provider.allowInsecureLocalhost'),
    });
  }

  getContextSettings(): ResolvedContextSettings {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    return resolveContextSettings({
      excludeGlobs: config.get<unknown>('context.excludeGlobs'),
      maxFileSizeKb: config.get<unknown>('context.maxFileSizeKb'),
      maxTotalChars: config.get<unknown>('context.maxTotalChars'),
      maxFiles: config.get<unknown>('context.maxFiles'),
    });
  }

  async updateModel(model: string): Promise<void> {
    await vscode.workspace
      .getConfiguration(CONFIG_SECTION)
      .update('provider.model', model, vscode.ConfigurationTarget.Global);
  }

  onDidChange(listener: () => void): vscode.Disposable {
    return vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(CONFIG_SECTION)) {
        listener();
      }
    });
  }
}
