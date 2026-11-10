import * as vscode from 'vscode';
import { CONFIG_SECTION } from './defaults';
import {
  resolveAgentSettings,
  resolveCommandSettings,
  resolveContextSettings,
  resolveMcpSettings,
  resolveProviderSettings,
  resolveWorkspaceSettings,
  type ResolvedAgentSettings,
  type ResolvedCommandSettings,
  type ResolvedContextSettings,
  type ResolvedMcpSettings,
  type ResolvedProviderSettings,
  type ResolvedWorkspaceSettings,
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

  getWorkspaceSettings(): ResolvedWorkspaceSettings {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    return resolveWorkspaceSettings({
      maxIndexedFiles: config.get<unknown>('workspace.maxIndexedFiles'),
      maxRetrievedFiles: config.get<unknown>('workspace.maxRetrievedFiles'),
      retrievalMaxChars: config.get<unknown>('workspace.retrievalMaxChars'),
    });
  }

  getAgentSettings(): ResolvedAgentSettings {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    return resolveAgentSettings({
      maxSteps: config.get<unknown>('agent.maxSteps'),
      maxRepairIterations: config.get<unknown>('agent.maxRepairIterations'),
      timeoutMs: config.get<unknown>('agent.timeoutMs'),
    });
  }

  getCommandSettings(): ResolvedCommandSettings {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    return resolveCommandSettings({
      allowlist: config.get<unknown>('commands.allowlist'),
      timeoutMs: config.get<unknown>('commands.timeoutMs'),
      maxOutputChars: config.get<unknown>('commands.maxOutputChars'),
    });
  }

  getMcpSettings(): ResolvedMcpSettings {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    return resolveMcpSettings({
      servers: config.get<unknown>('mcp.servers'),
    });
  }

  async updateModel(model: string): Promise<void> {
    await vscode.workspace
      .getConfiguration(CONFIG_SECTION)
      .update('provider.model', model, vscode.ConfigurationTarget.Global);
  }

  async updateProviderType(type: string, baseUrl?: string, model?: string): Promise<void> {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    await config.update('provider.type', type, vscode.ConfigurationTarget.Global);
    if (baseUrl !== undefined) {
      await config.update('provider.baseUrl', baseUrl, vscode.ConfigurationTarget.Global);
    }
    if (model !== undefined) {
      await config.update('provider.model', model, vscode.ConfigurationTarget.Global);
    }
  }

  async updateBaseUrl(baseUrl: string): Promise<void> {
    await vscode.workspace
      .getConfiguration(CONFIG_SECTION)
      .update('provider.baseUrl', baseUrl, vscode.ConfigurationTarget.Global);
  }

  onDidChange(listener: () => void): vscode.Disposable {
    return vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(CONFIG_SECTION)) {
        listener();
      }
    });
  }
}
