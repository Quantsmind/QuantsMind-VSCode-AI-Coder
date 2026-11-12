import * as vscode from 'vscode';
import type { SettingsService } from '../config/settings';
import type { McpServerManager, McpServerSnapshot } from '../mcp/serverManager';
import { parseMcpEndpoint } from '../mcp/endpoint';
import { deleteMcpCredential, storeMcpCredential } from '../mcp/credentials';
import { validateCredential } from '../security/credential';
import { redactSecrets } from '../security/redact';
import { decideMcpLaunchApproval } from './mcpLaunchGate';
import type { SecretStorageLike } from '../security/secretStore';

export interface McpManagerDependencies {
  readonly settings: SettingsService;
  readonly manager: McpServerManager;
  readonly outputChannel: vscode.OutputChannel;
  readonly trusted: () => boolean;
  /** VS Code SecretStorage, used to store/remove bearer credentials for remote servers. */
  readonly secrets?: SecretStorageLike;
}

export interface McpQuickPickEntry {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly detail?: string;
  readonly alwaysShow?: boolean;
}

interface ServerRef {
  readonly name: string;
  readonly transport: 'stdio' | 'streamable-http';
  readonly command?: string;
  readonly args?: readonly string[];
  readonly url?: string;
  readonly auth?: 'none' | 'bearer';
  readonly enabled: boolean;
  readonly timeoutMs?: number;
  readonly maxToolOutputChars?: number;
}

const STATE_ICONS: Readonly<Record<string, string>> = {
  connected: '$(plug)',
  connecting: '$(sync~spin)',
  error: '$(error)',
  disabled: '$(circle-slash)',
  disconnected: '$(circle-outline)',
};

function isRemote(server: { readonly transport: 'stdio' | 'streamable-http' }): boolean {
  return server.transport === 'streamable-http';
}

function serverLabel(server: McpServerSnapshot): string {
  const icon = STATE_ICONS[server.state] ?? '$(circle-outline)';
  return `${icon} ${server.name}`;
}

function serverDescription(server: McpServerSnapshot): string {
  const parts: string[] = [server.state, isRemote(server) ? 'streamable-http' : 'stdio'];
  if (server.protocolVersion !== undefined) {
    parts.push(`protocol ${server.protocolVersion}`);
  }
  if (server.toolCount !== undefined) {
    parts.push(`${server.toolCount} tool(s)`);
  }
  return parts.join(' · ');
}

function serverDetail(server: McpServerSnapshot): string {
  const limits =
    `${server.timeoutMs ?? '10,000'} ms · ${server.maxToolOutputChars ?? '20,000'} chars`;
  if (isRemote(server)) {
    return `${server.url ?? '(no endpoint)'}  (${limits})`;
  }
  const args = server.args.join(' ');
  const launch = args.length > 0 ? `${server.command ?? '(no command)'} ${args}` : server.command ?? '(no command)';
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
        ? { id: 'disconnect', label: '$(debug-disconnect) Disconnect', description: 'Close the connection to the server' }
        : { id: 'connect', label: '$(plug) Connect and approve launch', description: 'Connect with explicit approval' },
    );
    items.push({ id: 'discover-tools', label: '$(tools) Discover tools', description: 'List the tools this server exposes' });
    if (isRemote(server) && server.auth === 'bearer') {
      items.push({ id: 'auth-set', label: '$(key) Set or replace bearer credential', description: 'Store a fresh credential in VS Code SecretStorage' });
      items.push({ id: 'auth-remove', label: '$(trash) Remove stored credential', description: 'Delete the stored bearer credential from SecretStorage' });
    }
    items.push({ id: 'disable', label: '$(circle-slash) Disable', description: 'Keep the configuration but stop offering it' });
  } else {
    items.push({ id: 'enable', label: '$(play) Enable', description: 'Allow this server to be launched' });
  }
  items.push({ id: 'diagnostics', label: '$(info) Diagnostics', description: 'Server info, transport, protocol, last error' });
  items.push({ id: 'edit', label: isRemote(server) ? '$(edit) Edit endpoint…' : '$(edit) Edit command and arguments…', description: isRemote(server) ? 'Change the endpoint URL' : 'Change how this server is launched' });
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

function toDescriptor(server: ServerRef): ServerRef {
  if (server.transport === 'streamable-http') {
    return {
      name: server.name,
      transport: 'streamable-http',
      ...(server.url !== undefined ? { url: server.url } : {}),
      auth: server.auth ?? 'none',
      enabled: server.enabled,
      ...(server.timeoutMs !== undefined ? { timeoutMs: server.timeoutMs } : {}),
      ...(server.maxToolOutputChars !== undefined ? { maxToolOutputChars: server.maxToolOutputChars } : {}),
    };
  }
  return {
    name: server.name,
    transport: 'stdio',
    ...(server.command !== undefined ? { command: server.command } : {}),
    args: server.args ?? [],
    auth: 'none',
    enabled: server.enabled,
    ...(server.timeoutMs !== undefined ? { timeoutMs: server.timeoutMs } : {}),
    ...(server.maxToolOutputChars !== undefined ? { maxToolOutputChars: server.maxToolOutputChars } : {}),
  };
}

function serverApprovalDetail(server: ServerRef): string {
  if (server.transport === 'streamable-http') {
    return (
      `  Endpoint: ${server.url ?? '(missing endpoint)'}\n` +
      '  Transport: Streamable HTTP\n' +
      `  Authentication: ${server.auth === 'bearer' ? 'Bearer (credential from SecretStorage)' : 'none'}\n` +
      'Origin: application setting quantsmind.mcp.servers\n\n' +
      'This connects to a remote server chosen by your configuration. Its output is untrusted data. Only connect to servers you trust.'
    );
  }
  return (
    `  Command: ${server.command ?? '(missing command)'}\n` +
    `  Arguments: ${(server.args ?? []).join(' ') || '(none)'}\n` +
    'Origin: application setting quantsmind.mcp.servers\n\n' +
    'This starts an external process chosen by your configuration. It is not sandboxed. Only launch servers you trust.'
  );
}

/**
 * Shared launch gate for MCP servers from the management UI: requires workspace
 * trust, then a modal approval, and records the launch approval on success.
 * Callers still own the actual connect afterwards so they can use the correct
 * transport-specific error handling.
 */
/**
 * Shared launch gate for MCP servers from the management UI: requires workspace
 * trust, then a modal approval, and records the launch approval on success.
 * Decision logic is in `mcpLaunchGate.ts` (unit-tested); this wrapper maps the
 * outcomes onto the VS Code surface.
 */
async function ensureMcpLaunchApproved(
  deps: McpManagerDependencies,
  server: ServerRef,
  action: { title: string; button: string; trustAction: string },
): Promise<boolean> {
  const outcome = await decideMcpLaunchApproval({
    trusted: deps.trusted,
    prompt: async () => {
      const approved = await vscode.window.showWarningMessage(
        `${action.title} "${server.name}"?`,
        {
          modal: true,
          detail: serverApprovalDetail(server),
        },
        action.button,
      );
      return approved === action.button;
    },
  });
  if (outcome.ok) {
    deps.manager.grantLaunchApproval(server.name);
    return true;
  }
  if (outcome.reason === 'untrusted') {
    void vscode.window.showWarningMessage(`Workspace trust is required to ${action.trustAction} MCP servers.`);
    return false;
  }
  deps.outputChannel.appendLine(`[${new Date().toISOString()}] ${action.title} on "${server.name}" was not approved; nothing was launched.`);
  return false;
}

async function connectWithApproval(
  deps: McpManagerDependencies,
  server: ServerRef,
): Promise<void> {
  const approved = await ensureMcpLaunchApproved(deps, server, { title: 'Connect to MCP server', button: 'Connect server', trustAction: 'connect to' });
  if (!approved) {
    return;
  }
  try {
    await deps.manager.connectApproved(toDescriptor(server));
    deps.outputChannel.appendLine(`[${new Date().toISOString()}] Server "${server.name}" connected.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Connection failed.';
    deps.outputChannel.appendLine(`[${new Date().toISOString()}] Server "${server.name}" failed to connect: ${redactSecrets(message).text}`);
    void vscode.window.showErrorMessage(`MCP server "${server.name}" failed to connect. See the MCP output channel.`);
  }
}

async function discoverTools(
  deps: McpManagerDependencies,
  server: ServerRef,
): Promise<void> {
  // Discovery connects (or reuses a connection to) the server, so it must pass
  // the same trust and launch-approval gate as an explicit connect.
  const approved = await ensureMcpLaunchApproved(deps, server, { title: 'Discover tools on MCP server', button: 'Discover tools', trustAction: 'discover tools on' });
  if (!approved) {
    return;
  }
  try {
    const tools = await deps.manager.listTools(toDescriptor(server));
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
    `  transport: ${server.transport}`,
    ...(server.transport === 'streamable-http'
      ? [`  endpoint: ${server.url ?? '(missing endpoint)'}`, `  authentication: ${server.auth}${server.auth === 'bearer' ? ' (credential in SecretStorage; never shown)' : ''}`]
      : [`  command: ${server.command ?? '(missing command)'}`, `  args: ${server.args.join(' ') || '(none)'}`]),
    `  timeoutMs: ${server.timeoutMs ?? 'default (10000)'}`,
    `  maxToolOutputChars: ${server.maxToolOutputChars ?? 'default (20000)'}`,
    `  launch origin: ${server.launchOrigin}`,
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

async function setBearerCredential(
  deps: McpManagerDependencies,
  target: { readonly name: string },
): Promise<void> {
  if (deps.secrets === undefined) {
    void vscode.window.showErrorMessage('Secure credential storage is unavailable in this context.');
    return;
  }
  const token = await vscode.window.showInputBox({
    title: `Bearer credential for MCP server "${target.name}"`,
    prompt: 'Stored in VS Code SecretStorage only. Never written to settings or logs.',
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) => {
      try {
        validateCredential(value);
        return undefined;
      } catch (error) {
        return error instanceof Error ? error.message : 'Invalid credential.';
      }
    },
  });
  if (token === undefined) {
    return;
  }
  try {
    await storeMcpCredential(deps.secrets, target.name, token);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not store the credential.';
    void vscode.window.showErrorMessage(`MCP credential was not stored: ${message}`);
    return;
  }
  // A new credential invalidates any cached connection and launch approval.
  await deps.manager.disconnect(target.name);
  deps.manager.revokeLaunchApproval(target.name);
  deps.outputChannel.appendLine(`[${new Date().toISOString()}] Bearer credential for "${target.name}" stored; previous connection and approval revoked.`);
  void vscode.window.showInformationMessage(`Bearer credential for "${target.name}" saved in SecretStorage.`);
}

async function removeBearerCredential(
  deps: McpManagerDependencies,
  target: { readonly name: string },
): Promise<void> {
  if (deps.secrets === undefined) {
    void vscode.window.showErrorMessage('Secure credential storage is unavailable in this context.');
    return;
  }
  const confirmed = await vscode.window.showWarningMessage(
    `Remove the stored bearer credential for MCP server "${target.name}"?`,
    { modal: true },
    'Remove credential',
  );
  if (confirmed !== 'Remove credential') {
    return;
  }
  await deleteMcpCredential(deps.secrets, target.name);
  await deps.manager.disconnect(target.name);
  deps.manager.revokeLaunchApproval(target.name);
  deps.outputChannel.appendLine(`[${new Date().toISOString()}] Bearer credential for "${target.name}" removed; previous connection and approval revoked.`);
  void vscode.window.showInformationMessage(`Bearer credential for "${target.name}" removed.`);
}

function parseArgsInput(argsInput: string): string[] {
  return (argsInput.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((token) => token.replace(/^["']|["']$/g, ''));
}

async function editServer(
  deps: McpManagerDependencies,
  current: readonly ServerRef[],
  target: ServerRef,
): Promise<boolean> {
  if (target.transport === 'streamable-http') {
    const url = await vscode.window.showInputBox({
      title: `Edit MCP server — endpoint (${target.name})`,
      prompt: 'https URL of the MCP endpoint (http only for loopback development; credentials never belong in the URL)',
      value: target.url ?? '',
      ignoreFocusOut: true,
      validateInput: (value) => {
        const parsed = parseMcpEndpoint(value);
        return parsed.ok ? undefined : parsed.error;
      },
    });
    if (url === undefined) {
      return false;
    }
    const parsed = parseMcpEndpoint(url);
    if (!parsed.ok) {
      return false;
    }
    const updated = current.map((entry) => (entry.name === target.name ? { ...entry, url: parsed.url } : entry));
    await deps.settings.setMcpServers(updated);
    await deps.manager.disconnect(target.name);
    deps.manager.revokeLaunchApproval(target.name);
    deps.outputChannel.appendLine(`[${new Date().toISOString()}] Server "${target.name}" endpoint updated; launch approval revoked.`);
    return true;
  }
  const command = await vscode.window.showInputBox({
    title: `Edit MCP server — command (${target.name})`,
    prompt: 'Executable to launch',
    value: target.command ?? '',
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim().length === 0 ? 'A command is required.' : undefined),
  });
  if (command === undefined) {
    return false;
  }
  const argsInput = await vscode.window.showInputBox({
    title: `Edit MCP server — arguments (${target.name})`,
    prompt: 'Arguments separated by spaces (quote paths containing spaces like "C:\\Program Files\\…")',
    value: (target.args ?? []).join(' '),
    ignoreFocusOut: true,
  });
  if (argsInput === undefined) {
    return false;
  }
  const parsedArgs = parseArgsInput(argsInput);
  const updated = current.map((entry) =>
    entry.name === target.name ? { ...entry, command: command.trim(), args: parsedArgs } : entry,
  );
  await deps.settings.setMcpServers(updated);
  deps.manager.revokeLaunchApproval(target.name); // reconfiguration invalidates a previous launch approval
  deps.outputChannel.appendLine(`[${new Date().toISOString()}] Server "${target.name}" updated; launch approval revoked.`);
  return true;
}

async function addStdioServer(deps: McpManagerDependencies, current: readonly ServerRef[], name: string): Promise<void> {
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
  const args = parseArgsInput(argsInput);
  const updated = [...current, { name: name.trim(), transport: 'stdio' as const, command: command.trim(), args, enabled: true }];
  await deps.settings.setMcpServers(updated);
  deps.outputChannel.appendLine(`[${new Date().toISOString()}] Server "${name.trim()}" configured and enabled. Launch it from the MCP manager.`);
  void vscode.window.showInformationMessage(`MCP server "${name.trim()}" added. Connect it from QuantsMind: Manage MCP Servers.`);
}

async function addHttpServer(deps: McpManagerDependencies, current: readonly ServerRef[], name: string): Promise<void> {
  const url = await vscode.window.showInputBox({
    title: 'Add MCP server — endpoint',
    prompt: 'https URL of the MCP endpoint (http only for loopback development; credentials never belong in the URL)',
    ignoreFocusOut: true,
    validateInput: (value) => {
      const parsed = parseMcpEndpoint(value);
      return parsed.ok ? undefined : parsed.error;
    },
  });
  if (url === undefined) {
    return;
  }
  const parsed = parseMcpEndpoint(url);
  if (!parsed.ok) {
    return;
  }
  const auth = await vscode.window.showQuickPick(
    [
      { label: 'none', description: 'The endpoint does not require authentication', value: 'none' as const },
      { label: 'bearer', description: 'Requires a token stored in VS Code SecretStorage; never written to settings', value: 'bearer' as const },
    ],
    { title: 'Add MCP server — authentication', placeHolder: 'How does the server authenticate requests?', ignoreFocusOut: true },
  );
  if (auth === undefined) {
    return;
  }
  if (auth.value === 'bearer') {
    if (deps.secrets === undefined) {
      void vscode.window.showErrorMessage('Secure credential storage is unavailable; cannot store a bearer credential for this server.');
      return;
    }
    const token = await vscode.window.showInputBox({
      title: 'Add MCP server — bearer credential',
      prompt: `Token for "${name.trim()}"; stored in SecretStorage only`,
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) => {
        try {
          validateCredential(value);
          return undefined;
        } catch (error) {
          return error instanceof Error ? error.message : 'Invalid credential.';
        }
      },
    });
    if (token === undefined) {
      return;
    }
    try {
      await storeMcpCredential(deps.secrets, name.trim(), token);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not store the credential.';
      void vscode.window.showErrorMessage(`MCP server "${name.trim()}" was not added: ${message}`);
      return;
    }
  }
  const updated = [...current, { name: name.trim(), transport: 'streamable-http' as const, url: parsed.url, enabled: true, auth: auth.value }];
  await deps.settings.setMcpServers(updated);
  deps.outputChannel.appendLine(`[${new Date().toISOString()}] Remote server "${name.trim()}" configured (streamable-http, auth: ${auth.value}). Connect it from the MCP manager.`);
  void vscode.window.showInformationMessage(`MCP server "${name.trim()}" added. Connect it from QuantsMind: Manage MCP Servers.`);
}

async function addServer(deps: McpManagerDependencies, current: readonly ServerRef[]): Promise<void> {
  const transport = await vscode.window.showQuickPick(
    [
      { label: 'stdio (local process)', description: 'Launch a local executable over stdio JSON-RPC', value: 'stdio' as const },
      { label: 'streamable-http (remote server)', description: 'Connect to an HTTPS MCP endpoint with optional bearer authentication', value: 'streamable-http' as const },
    ],
    { title: 'Add MCP server — transport', placeHolder: 'How should QuantsMind reach the server?', ignoreFocusOut: true },
  );
  if (transport === undefined) {
    return;
  }
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
  if (transport.value === 'stdio') {
    await addStdioServer(deps, current, name);
    return;
  }
  await addHttpServer(deps, current, name);
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
      const server: ServerRef = {
        name: target.name,
        transport: target.transport,
        ...(target.command !== undefined ? { command: target.command } : {}),
        args: target.args,
        ...(target.url !== undefined ? { url: target.url } : {}),
        auth: target.auth,
        enabled: target.enabled,
        ...(target.timeoutMs !== undefined ? { timeoutMs: target.timeoutMs } : {}),
        ...(target.maxToolOutputChars !== undefined ? { maxToolOutputChars: target.maxToolOutputChars } : {}),
      };
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
        case 'auth-set':
          await setBearerCredential(deps, target);
          break;
        case 'auth-remove':
          await removeBearerCredential(deps, target);
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
          await editServer(deps, servers, server);
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
              detail:
                server.transport === 'streamable-http'
                  ? `Endpoint: ${server.url ?? '(missing endpoint)'}\n\nThis deletes the configuration. The stored bearer credential, if any, is removed as well. The connection is closed if active.`
                  : `Command: ${server.command ?? ''} ${(server.args ?? []).join(' ')}\n\nThis deletes the configuration. The server process is stopped if it is running.`,
            },
            'Remove',
          );
          if (confirmed !== 'Remove') {
            break;
          }
          await deps.manager.disconnect(target.name);
          deps.manager.revokeLaunchApproval(target.name);
          if (server.transport === 'streamable-http' && deps.secrets !== undefined) {
            await deleteMcpCredential(deps.secrets, target.name).catch(() => undefined);
            deps.outputChannel.appendLine(`[${new Date().toISOString()}] Stored bearer credential for "${target.name}" removed.`);
          }
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
