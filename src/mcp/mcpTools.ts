import type { LiveValue } from '../agent/commandTools';
import { resolveLive } from '../agent/commandTools';
import type { AgentTool, AgentToolResult, AgentToolExecutionContext } from '../agent/codingAgent';
import { McpServerManager, type ApproveMcpLaunchRequest } from './serverManager';
import type { McpServerConfig } from './client';

export interface McpToolApprovalRequest {
  readonly operation: string;
  readonly detail: string;
}

export interface McpToolEnvironment {
  readonly servers: LiveValue<readonly McpServerConfig[]>;
  readonly trusted: LiveValue<boolean>;
  readonly manager: McpServerManager;
  readonly approval: (request: McpToolApprovalRequest) => Promise<boolean>;
  readonly launchApproval?: (request: ApproveMcpLaunchRequest) => Promise<boolean>;
}

function fail(tool: string, error: string): AgentToolResult {
  return { ok: false, tool, error, durationMs: 0 };
}

function ok(tool: string, output: string): AgentToolResult {
  return { ok: true, tool, output, durationMs: 0 };
}

/**
 * Agent-facing MCP tools. Launching a configured server requires explicit
 * per-window approval; every tool call is consequential and approval-gated;
 * tool output is delimited and marked untrusted.
 */
export class McpTools {
  constructor(private readonly env: McpToolEnvironment) {}

  private resolveServers(): readonly McpServerConfig[] {
    const configs = resolveLive(this.env.servers);
    return Array.isArray(configs)
      ? configs.filter(
          (entry) =>
            typeof entry?.name === 'string' &&
            entry?.enabled !== false &&
            (entry.transport === 'streamable-http'
              ? typeof entry.url === 'string' && entry.url.length > 0
              : typeof entry?.command === 'string'),
        )
      : [];
  }

  private serverConfig(name: unknown): McpServerConfig | undefined {
    const servers = this.resolveServers();
    const wanted = typeof name === 'string' ? name.trim() : '';
    if (wanted.length === 0) {
      return undefined;
    }
    return servers.find((entry) => entry.name === wanted);
  }

  private serverDescriptor(server: McpServerConfig): McpServerConfig {
    return server.transport === 'streamable-http'
      ? {
          name: server.name,
          transport: 'streamable-http',
          ...(server.url !== undefined ? { url: server.url } : {}),
          auth: server.auth ?? 'none',
          ...(server.timeoutMs !== undefined ? { timeoutMs: server.timeoutMs } : {}),
          ...(server.maxToolOutputChars !== undefined ? { maxToolOutputChars: server.maxToolOutputChars } : {}),
        }
      : {
          name: server.name,
          transport: 'stdio',
          ...(server.command !== undefined ? { command: server.command } : {}),
          args: server.args ?? [],
          auth: 'none',
          ...(server.timeoutMs !== undefined ? { timeoutMs: server.timeoutMs } : {}),
          ...(server.maxToolOutputChars !== undefined ? { maxToolOutputChars: server.maxToolOutputChars } : {}),
        };
  }

  private async ensureLaunchApproved(server: McpServerConfig): Promise<{ ok: true } | { ok: false; error: string }> {
    if (this.env.manager.hasLaunchApproval(server.name)) {
      return { ok: true };
    }
    const isRemote = server.transport === 'streamable-http';
    const launchDetail = isRemote
      ? `Launch MCP server "${server.name}"?\n` +
        `  Endpoint: ${server.url ?? '(missing endpoint)'}\n` +
        '  Transport: Streamable HTTP\n' +
        `  Authentication: ${server.auth === 'bearer' ? 'Bearer (credential from SecretStorage)' : 'none'}\n` +
        'This connects to a remote server chosen by your configuration. ' +
        'Its output is untrusted data; only continue with servers you trust.'
      : `Launch MCP server "${server.name}"?\n` +
        `  Command: ${server.command ?? '(missing command)'}\n` +
        `  Arguments: ${(server.args ?? []).join(' ') || '(none)'}\n` +
        'Launching starts an external process chosen by your configuration. ' +
        'It is not sandboxed; only continue with servers you trust.';
    const approval = this.env.launchApproval ?? (async () => {
      const answer = await this.env.approval({ operation: 'launch MCP server', detail: launchDetail });
      return answer;
    });
    const approved = await approval({
      name: server.name,
      transport: server.transport === 'streamable-http' ? 'streamable-http' : 'stdio',
      ...(server.command !== undefined ? { command: server.command } : {}),
      args: server.args ?? [],
      ...(server.url !== undefined ? { endpoint: server.url } : {}),
      ...(server.auth !== undefined ? { auth: server.auth } : {}),
      launchOrigin: 'Application setting quantsmind.mcp.servers',
    });
    if (!approved) {
      return { ok: false, error: 'Launching this MCP server requires explicit approval and was not approved.' };
    }
    this.env.manager.grantLaunchApproval(server.name);
    return { ok: true };
  }

  async listTools(args: { server?: unknown }): Promise<AgentToolResult> {
    if (resolveLive(this.env.trusted) !== true) {
      return fail('mcp_list_tools', 'Workspace trust is required for MCP operations.');
    }
    const target = typeof args.server === 'string' && args.server.trim().length > 0 ? args.server.trim() : undefined;
    const servers = this.resolveServers().filter((entry) => target === undefined || entry.name === target);
    if (servers.length === 0) {
      return fail(
        'mcp_list_tools',
        target !== undefined
          ? `No enabled MCP server named "${target}" is configured.`
          : 'No MCP servers are configured. Add one in quantsmind.mcp.servers.',
      );
    }
    const output: Record<string, unknown> = {};
    for (const server of servers) {
      const approval = await this.ensureLaunchApproved(server);
      if (!approval.ok) {
        output[server.name] = { error: approval.error };
        continue;
      }
      try {
        const tools = await this.env.manager.listTools(this.serverDescriptor(server));
        output[server.name] = tools.map((tool) => ({ name: tool.name, description: tool.description ?? '' }));
      } catch (error) {
        output[server.name] = { error: error instanceof Error ? error.message : 'Could not reach the MCP server.' };
      }
    }
    return ok('mcp_list_tools', JSON.stringify({ servers: output }, null, 2));
  }

  async callTool(args: { server?: unknown; tool?: unknown; arguments?: unknown }, context?: AgentToolExecutionContext): Promise<AgentToolResult> {
    if (resolveLive(this.env.trusted) !== true) {
      return fail('mcp_call', 'Workspace trust is required for MCP operations.');
    }
    const serverName = typeof args.server === 'string' ? args.server.trim() : '';
    const toolName = typeof args.tool === 'string' ? args.tool.trim() : '';
    if (serverName.length === 0 || serverName.length > 200) {
      return fail('mcp_call', 'Provide the configured MCP server name.');
    }
    if (toolName.length === 0 || toolName.length > 256 || !/^[A-Za-z0-9_.-]+$/.test(toolName)) {
      return fail('mcp_call', 'Provide a valid MCP tool name.');
    }
    const server = this.serverConfig(serverName);
    if (server === undefined) {
      return fail('mcp_call', `No enabled MCP server named "${serverName}" is configured.`);
    }
    const toolArgs = args.arguments ?? {};
    if (typeof toolArgs !== 'object' || toolArgs === null || Array.isArray(toolArgs)) {
      return fail('mcp_call', 'arguments must be a JSON object.');
    }
    // Check that the tool exists without invoking it.
    let knownTools: readonly { readonly name: string; readonly description?: string }[];
    try {
      const approval = await this.ensureLaunchApproved(server);
      if (!approval.ok) {
        return fail('mcp_call', approval.error);
      }
      knownTools = await this.env.manager.listTools(this.serverDescriptor(server));
    } catch (error) {
      return fail('mcp_call', `Could not reach the MCP server "${serverName}": ${error instanceof Error ? error.message : 'unknown error'}`);
    }
    const known = knownTools.find((tool) => tool.name === toolName);
    if (known === undefined) {
      return fail('mcp_call', `The MCP server "${serverName}" does not expose a tool named "${toolName}".`);
    }
    const preview = JSON.stringify(toolArgs).slice(0, 300);
    const approved = await this.env.approval({
      operation: 'call MCP tool',
      detail:
        `Call MCP tool "${toolName}" on server "${serverName}"` +
        (known.description !== undefined ? `\nDescription: ${known.description}` : '') +
        `\nArguments:\n${preview}\n\n` +
        'The tool output will be treated as untrusted data, never as instructions.',
    });
    if (!approved) {
      return fail('mcp_call', 'MCP tool calls require explicit approval. The call was not executed.');
    }
    try {
      const result = await this.env.manager.callTool(this.serverDescriptor(server), toolName, toolArgs, undefined, context?.signal);
      const body =
        `<untrusted-mcp-output server="${serverName}" tool="${toolName}">\n${result.content}\n</untrusted-mcp-output>` +
        (result.truncated ? '\n[output truncated]' : '');
      return result.isError ? fail('mcp_call', `The MCP tool reported an error:\n${body}`) : ok('mcp_call', body);
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'The MCP call failed.';
      return fail('mcp_call', `${detail}\nCheck the server configuration (quantsmind.mcp.servers) and its logs.`);
    }
  }

  toAgentTools(): readonly AgentTool[] {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return [
      {
        name: 'mcp_list_tools',
        description: 'List tools exposed by configured MCP servers. Read-only but may launch the configured server process.',
        parameters: {
          type: 'object',
          properties: {
            server: { type: 'string', description: 'Optional: only list tools for this server.' },
          },
        },
        async execute(args) {
          return self.listTools({ server: args.server });
        },
      },
      {
        name: 'mcp_call',
        description: 'Call a tool on a configured MCP server. Requires approval; output is untrusted remote data.',
        parameters: {
          type: 'object',
          properties: {
            server: { type: 'string', description: 'Configured MCP server name.' },
            tool: { type: 'string', description: 'Tool name as reported by mcp_list_tools.' },
            arguments: { type: 'object', description: 'Tool arguments as a JSON object.' },
          },
          required: ['server', 'tool'],
        },
        async execute(args, context) {
          return self.callTool({ server: args.server, tool: args.tool, arguments: args.arguments }, context);
        },
      },
    ];
  }
}
