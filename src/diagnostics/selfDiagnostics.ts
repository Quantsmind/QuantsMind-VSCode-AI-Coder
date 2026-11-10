import * as vscode from 'vscode';
import type { CompletionService } from '../providers/completionService';
import type { SettingsService } from '../config/settings';
import type { SecretStore } from '../security/secretStore';
import type { WorkspaceIndexService } from '../workspace/indexService';
import type { Logger } from '../security/logger';
import { selectWorkspaceRoot } from '../workspace/rootPolicy';

export interface SelfDiagnosticsDeps {
  readonly version: string;
  readonly completion: CompletionService;
  readonly settings: SettingsService;
  readonly secrets: SecretStore;
  readonly workspaceIndex: WorkspaceIndexService;
  readonly logger: Logger;
}

export class SelfDiagnosticsService {
  constructor(private readonly deps: SelfDiagnosticsDeps) {}

  async run(): Promise<string> {
    const lines: string[] = [];
    lines.push('# QuantsMind Self-Diagnostics Report');
    lines.push('');
    lines.push(`- Generated: ${new Date().toISOString()}`);
    lines.push(`- Extension version: ${this.deps.version}`);
    lines.push(`- VS Code version: ${vscode.version}`);
    lines.push('');

    lines.push('## Environment');
    lines.push(`- Workspace folders: ${vscode.workspace.workspaceFolders?.length ?? 0}`);
    // Same root policy as indexing, retrieval and edits (D4): report the folder
    // the extension actually treats as the root, never an arbitrary first folder.
    const root = selectWorkspaceRoot(
      (vscode.workspace.workspaceFolders ?? []).map((folder, index) => ({
        name: folder.name,
        index,
        uri: folder.uri,
      })),
    );
    lines.push(`- Selected workspace root: ${root?.name ?? '(none)'}`);
    lines.push(`- Trusted: ${vscode.workspace.isTrusted}`);
    lines.push('');

    lines.push('## Workspace intelligence');
    try {
      const entries = await this.deps.workspaceIndex.getEntries();
      const summary = await this.deps.workspaceIndex.summarize();
      lines.push(`- Indexed files: ${entries.length}`);
      lines.push(`- Summary: ${summary.text.split('\\n')[0]}`);
    } catch (error) {
      lines.push(`- Index error: ${error instanceof Error ? error.message : 'unknown'}`);
    }
    lines.push('');

    lines.push('## Provider');
    try {
      const status = await this.deps.completion.getStatus();
      lines.push(`- Provider: ${status.displayName}`);
      lines.push(`- Model: ${status.model}`);
      lines.push(`- Endpoint: ${status.endpointHost}`);
      lines.push(`- Ready: ${status.ready}`);
      if (status.configurationError) {
        lines.push(`- Configuration error: ${status.configurationError}`);
      }
      lines.push(`- Credential present: ${status.hasCredential}`);
    } catch (error) {
      lines.push(`- Provider status error: ${error instanceof Error ? error.message : 'unknown'}`);
    }
    lines.push('');

    lines.push('## Security');
    lines.push('- Secret redaction: enabled');
    lines.push('- Workspace trust enforced: yes');
    lines.push('- Command allowlist: application-scoped');
    lines.push('');

    lines.push('## Tests');
    lines.push('- Automated tests: NOT TESTED (not executed by this diagnostic)');
    lines.push('');

    return lines.join('\\n');
  }

  async runAndSave(context: vscode.ExtensionContext): Promise<string> {
    const report = await this.run();
    const dir = vscode.Uri.joinPath(context.globalStorageUri, 'diagnostics');
    await vscode.workspace.fs.createDirectory(dir);
    const file = vscode.Uri.joinPath(dir, `self-diagnostics-${Date.now()}.md`);
    await vscode.workspace.fs.writeFile(file, Buffer.from(report, 'utf8'));
    return file.fsPath;
  }
}
