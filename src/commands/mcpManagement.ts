import * as vscode from 'vscode';
import type { SettingsService } from '../config/settings';
import type { McpServerManager, McpServerSnapshot } from '../mcp/serverManager';
import { redactSecrets } from '../security/redact';

export interface McpManagerDependencies {
  readonly settings: SettingsService;
  readonly manager: McpServerManager;
  readonly outputChannel: vscode.OutputChannel;
  readonly trusted: () => boolean;
}

export interface McpQuickPickEntry {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly detail?: string;
  readonly alwaysShow?: boolean;
}

const STATE_ICONS: Readonly<Record<string, string>> = {
  connected: '$(plug)',
  connecting: '$(sync~spin)',
  error: '$(error)',
  disabled: '$(circle-slash)',
  disconnected: '$(circle-outline)',
};

function serverLabel(server: McpServerSnapshot): string {
  const icon = STATE_ICONS[server.state] ?? '$(circle-outline)';
  return `${icon} ${server.name}`;
}

function serverDescription(server: McpServerSnapshot): string {
  const parts: string[] = [server.state];
  if (server.protocolVersion !== undefined) {
    parts.push(`protocol ${server.protocolVersion}`);
  }
  if (server.toolCount !== undefined) {
    parts.push(`${server.toolCount} tool(s)`);
  }
  return parts.join(' · ');
}

function serverDetail(server: McpServerSnapshot): string {
  const args = server.args.join(' ');
  const launch = args.length > 0 ? `${server.command} ${args}` : server.command;
  const limits =
    `${server.timeoutMs ?? '10,000'} ms · ${server.maxToolOutputChars ?? '20,000'} chars`;
  return `${launch}  (${limits})`;
}

/** Pure builder: the top-level QuickPick for MCP server management. */
export function buildServerListItems(snapshot: readonly McpServerSnapshot[]): McpQuickPickEntry[] {
  const items: McpQuickPickEntry[] = [];
  for (const server of snapshot) {
    items.push({
      id: `server:${server.name}`,
      label: serverLabel(server),
      description: serverDescription(server),
      detail: serverDetail(server),
    });
  }
  items.push({ id: 'add-server', label: '$(add) Add MCP server…', description: 'Configure a new server' });
  items.push({ id: 'show-diagnostics', label: '$(output) Show diagnostics', description: 'Write server diagnostics to the MCP output channel' });
  items.push({ id: 'refresh', label: '$(refresh) Refresh', description: 'Re-read the configured servers' });
  return items;
}

/** Pure builder: per-server action QuickPick. */
export function buildServerActionItems(server: McpServerSnapshot): McpQuickPickEntry[] {
  const items: McpQuickPickEntry[] = [];
  if (server.enabled) {
    items.push(
      server.state === 'connected'
        ? { id: 'disconnect', label: '$(debug-disconnect) Disconnect', description: 'Stop the server process' }
        : { id: 'connect', label: '$(plug) Connect and approve launch', description: 'Launch the server with explicit approval' },
    );
    items.push({ id: 'discover-tools', label: '$(tools) Discover tools', description: 'List the tools this server exposes' });
    items.push({ id: 'disable', label: '$(circle-slash) Disable', description: 'Keep the configuration but stop offering it' });
  } else {
    items.push({ id: 'enable', label: '$(play) Enable', description: 'Allow this server to be launched' });
  }
  items.push({ id: 'diagnostics', label: '$(info) Diagnostics', description: 'Server info, protocol, last error and stderr tail' });
  items.push({ id: 'edit', label: '$(edit) Edit command and arguments…', description: 'Change how this server is launched' });
  items.push({ id: 'restart', label: '$(debug-restart) Restart server', description: 'Disconnect and reconnect' });
  items.push({ id: 'remove', label: '$(trash) Remove server…', description: 'Delete this configuration' });
  items.push({ id: 'back', label: '$(arrow-left) Back' });
  return items;
}

async function pickFrom(items: readonly McpQuickPickEntry[], title: string, placeHolder: string): Promise<string | undefined> {
  const picked = await vscode.window.showQuickPick(
    items.map((entry) => ({ label: entry.label, description: entry.description, detail: entry.detail, id: entry.id })),
    { title, placeHolder, ignoreFocusOut: true },
  );
  return picked === undefined ? undefined : (picked as { id: string }).id;
}

async function connectWithApproval(
  deps: McpManagerDependencies,
  server: { readonly name: string; readonly command: string; readonly args: readonly string[] },
): Promise<void> {
  if (!deps.trusted()) {
    void vscode.window.showWarningMessage('Workspace trust is required to launch MCP servers.');
    return;
  }
  const approved = await vscode.window.showWarningMessage(
    `Launch MCP server "${server.name}"?`,
    {
      modal: true,
      detail:
        `  Command: ${server.command}\n` +
        `  Arguments: ${server.args.join(' ') || '(none)'}\n` +
        'Origin: application setting quantsmind.mcp.servers\n\n' +
        'This starts an external process chosen by your configuration. It is not sandboxed. Only launch servers you trust.',
    },
    'Launch server',
  );
  if (approved !== 'Launch server') {
    deps.outputChannel.appendLine(`[${new Date().toISOString()}] Launch of "${server.name}" was not approved; server not started.`);
    return;
  }
  deps.manager.grantLaunchApproval(server.name);
  try {
    await deps.manager.connectApproved(server);
    deps.outputChannel.appendLine(`[${new Date().toISOString()}] Server "${server.name}" connected.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Connection failed.';
    deps.outputChannel.appendLine(`[${new Date().toISOString()}] Server "${server.name}" failed to connect: ${redactSecrets(message).text}`);
    void vscode.window.showErrorMessage(`MCP server "${server.name}" failed to connect. See the MCP output channel.`);
  }
}

async function discoverTools(
  deps: McpManagerDependencies,
  server: { readonly name: string; readonly command: string; readonly args: readonly string[] },
): Promise<void> {
  try {
    const tools = await deps.manager.listTools(server);
    if (tools.length === 0) {
      void vscode.window.showInformationMessage(`MCP server "${server.name}" reports no tools.`);
      return;
    }
    const pick = await vscode.window.showQuickPick(
      tools.map((tool) => ({ label: tool.name, description: tool.description ?? '(no description)' })),
      { title: `MCP tools — ${server.name}`, placeHolder: 'Tools are listed for inspection; calling them requires per-call approval.', ignoreFocusOut: true },
    );
    if (pick !== undefined) {
      deps.outputChannel.appendLine(`[${new Date().toISOString()}] Tool "${pick.label}" selected for inspection on "${server.name}".`);
    }
  } catch (error) {
    deps.outputChannel.appendLine(`[${new Date().toISOString()}] Discovery on "${server.name}" failed: ${redactSecrets(error instanceof Error ? error.message : 'unknown error').text}`);
    void vscode.window.showErrorMessage(`Could not list tools for "${server.name}". See the MCP output channel.`);
  }
}

function diagnosticsFor(deps: McpManagerDependencies, server: McpServerSnapshot): void {
  const lines = [
    `[${new Date().toISOString()}] Diagnostics for MCP server "${server.name}"`,
    `  state: ${server.state}`,
    `  enabled: ${server.enabled}`,
    `  launch origin: ${server.launchOrigin}`,
    `  command: ${server.command}`,
    `  args: ${server.args.join(' ') || '(none)'}`,
    `  timeoutMs: ${server.timeoutMs ?? 'default (10000)'}`,
    `  maxToolOutputChars: ${server.maxToolOutputChars ?? 'default (20000)'}`,
    ...(server.serverInfo !== undefined ? [`  server: ${server.serverInfo.name} ${server.serverInfo.version}`] : []),
    ...(server.protocolVersion !== undefined ? [`  protocol: ${server.protocolVersion}`] : []),
    ...(server.toolCount !== undefined ? [`  tools cached: ${server.toolCount}`] : []),
    ...(server.lastError !== undefined ? [`  last error: ${redactSecrets(server.lastError).text}`] : ['  last error: (none)']),
  ];
  for (const line of lines) {
    deps.outputChannel.appendLine(line);
  }
  deps.outputChannel.show(true);
  void vscode.window.showInformationMessage(`Diagnostics written to the MCP output channel (${server.state}).`);
}

async function editServer(
  deps: McpManagerDependencies,
  current: readonly { readonly name: string; readonly command: string; readonly args: readonly string[]; readonly enabled: boolean }[],
  target: { readonly name: string; readonly command: string; readonly args: readonly string[]; readonly enabled: boolean },
): Promise<boolean> {
  const command = await vscode.window.showInputBox({
    title: `Edit MCP server — command (${target.name})`,
    prompt: 'Executable to launch',
    value: target.command,
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim().length === 0 ? 'A command is required.' : undefined),
  });
  if (command === undefined) {
    return false;
  }
  const argsInput = await vscode.window.showInputBox({
    title: `Edit MCP server — arguments (${target.name})`,
    prompt: 'Arguments separated by spaces (quote paths containing spaces like "C:\\Program Files\\…")',
    value: target.args.join(' '),
    ignoreFocusOut: true,
  });
  if (argsInput === undefined) {
    return false;
  }
  const parsedArgs = (argsInput.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((token) => token.replace(/^["']|["']$/g, ''));
  const updated = current.map((entry) =>
    entry.name === target.name ? { ...entry, command: command.trim(), args: parsedArgs } : entry,
  );
  await deps.settings.setMcpServers(updated);
  deps.manager.revokeLaunchApproval(target.name); // reconfiguration invalidates a previous launch approval
  deps.outputChannel.appendLine(`[${new Date().toISOString()}] Server "${target.name}" updated; launch approval revoked.`);
  return true;
}

async function addServer(deps: McpManagerDependencies, current: readonly { readonly name: string; readonly command: string; readonly args: readonly string[]; readonly enabled: boolean }[]): Promise<void> {
  const name = await vscode.window.showInputBox({
    title: 'Add MCP server — name',
    prompt: 'A stable identifier, e.g. "filesystem" or "company-search"',
    ignoreFocusOut: true,
    validateInput: (value) => {
      const trimmed = value.trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(trimmed)) {
        return 'Use letters, digits, dot, dash or underscore; start with a letter or digit.';
      }
      if (current.some((entry) => entry.name === trimmed)) {
        return 'A server with this name is already configured.';
      }
      return undefined;
    },
  });
  if (name === undefined) {
    return;
  }
  const command = await vscode.window.showInputBox({
    title: 'Add MCP server — command',
    prompt: 'Executable to launch, e.g. "node" or "npx"',
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim().length === 0 ? 'A command is required.' : undefined),
  });
  if (command === undefined) {
    return;
  }
  const argsInput = await vscode.window.showInputBox({
    title: 'Add MCP server — arguments',
    prompt: 'Arguments separated by spaces (quote paths containing spaces)',
    ignoreFocusOut: true,
  });
  if (argsInput === undefined) {
    return;
  }
  const args = (argsInput.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((token) => token.replace(/^["']|["']$/g, ''));
  const updated = [...current, { name: name.trim(), command: command.trim(), args, enabled: true }];
  await deps.settings.setMcpServers(updated);
  deps.outputChannel.appendLine(`[${new Date().toISOString()}] Server "${name.trim()}" configured and enabled. Launch it from the MCP manager.`);
  void vscode.window.showInformationMessage(`MCP server "${name.trim()}" added. Launch it from QuantsMind: Manage MCP Servers.`);
}

/** The `quantsmind.manageMcpServers` command. */
export async function manageMcpServers(deps: McpManagerDependencies): Promise<void> {
  for (;;) {
    const servers = deps.settings.getMcpSettings().servers;
    const snapshot = deps.manager.snapshot(servers);
    const picked = await pickFrom(buildServerListItems(snapshot), 'QuantsMind: Manage MCP Servers', 'Select a server or an action');
    if (picked === undefined) {
      return;
    }
    if (picked === 'add-server') {
      await addServer(deps, servers);
      continue;
    }
    if (picked === 'show-diagnostics') {
      for (const server of snapshot) {
        diagnosticsFor(deps, server);
      }
      continue;
    }
    if (picked === 'refresh') {
      continue;
    }

    const target = snapshot.find((server) => `server:${server.name}` === picked);
    if (target === undefined) {
      continue;
    }

    for (;;) {
      const action = await pickFrom(buildServerActionItems(target), `MCP server — ${target.name}`, 'Select an action');
      if (action === undefined || action === 'back') {
        break;
      }
      const server = { name: target.name, command: target.command, args: target.args };
      switch (action) {
        case 'connect':
          await connectWithApproval(deps, server);
          break;
        case 'disconnect':
          await deps.manager.disconnect(target.name);
          break;
        case 'discover-tools':
          await discoverTools(deps, server);
          break;
        case 'enable':
        case 'disable': {
          const enable = action === 'enable';
          if (!enable) {
            const confirmed = await vscode.window.showWarningMessage(
              `Disable MCP server "${target.name}"? It will remain configured but cannot be launched.`,
              { modal: true },
              'Disable',
            );
            if (confirmed !== 'Disable') {
              break;
            }
            await deps.manager.disconnect(target.name);
            deps.manager.revokeLaunchApproval(target.name);
          }
          await deps.settings.setMcpServers(
            servers.map((entry) => (entry.name === target.name ? { ...entry, enabled: enable } : entry)),
          );
          break;
        }
        case 'diagnostics':
          diagnosticsFor(deps, target);
          break;
        case 'edit':
          await editServer(deps, servers, { name: target.name, command: target.command, args: target.args, enabled: target.enabled });
          break;
        case 'restart': {
          await deps.manager.disconnect(target.name);
          await connectWithApproval(deps, server);
          break;
        }
        case 'remove': {
          const confirmed = await vscode.window.showWarningMessage(
            `Remove MCP server "${target.name}"?`,
            {
              modal: true,
              detail: `Command: ${target.command} ${target.args.join(' ')}\n\nThis deletes the configuration. The server process is stopped if it is running.`,
            },
            'Remove',
          );
          if (confirmed !== 'Remove') {
            break;
          }
          await deps.manager.disconnect(target.name);
          deps.manager.revokeLaunchApproval(target.name);
          await deps.settings.setMcpServers(servers.filter((entry) => entry.name !== target.name));
          deps.outputChannel.appendLine(`[${new Date().toISOString()}] Server "${target.name}" removed.`);
          break;
        }
        default:
          break;
      }
      // Refresh the snapshot after any mutating action, then re-render the submenu.
      const refreshed = deps.manager.snapshot(deps.settings.getMcpSettings().servers);
      const refreshedTarget = refreshed.find((entry) => entry.name === target.name);
      if (refreshedTarget === undefined) {
        break;
      }
      Object.assign(target, refreshedTarget);
      if (action === 'remove' || action === 'enable' || action === 'disable') {
        break;
      }
    }
  }
}
