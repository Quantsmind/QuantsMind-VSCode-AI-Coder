export type WorkspaceFileType = 'file' | 'directory';

export interface WorkspaceDirectoryEntry {
  readonly name: string;
  readonly type: WorkspaceFileType;
}

export interface AgentFileSystem {
  readFile(path: string): Promise<string>;
  listDirectory(path: string): Promise<readonly WorkspaceDirectoryEntry[]>;
}

export function normalizeWorkspacePath(input: unknown): string | undefined {
  if (typeof input !== 'string') {
    return undefined;
  }
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return '';
  }
  if (trimmed.includes('\u0000') || trimmed.length > 1000) {
    return undefined;
  }
  const converted = trimmed.replace(/\\/g, '/');
  if (converted.startsWith('/') || /^[a-zA-Z]:/.test(converted) || converted.startsWith('//')) {
    return undefined;
  }
  const segments = converted.split('/');
  const normalized: string[] = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      return undefined;
    }
    if (segment.length > 255) {
      return undefined;
    }
    normalized.push(segment);
  }
  return normalized.join('/');
}

export interface WorkspaceToolResult {
  readonly ok: boolean;
  readonly output?: string;
  readonly error?: string;
}

export class WorkspaceTools {
  constructor(
    private readonly rootPath: string,
    private readonly fileSystem: AgentFileSystem,
  ) {}

  async readFile(requestedPath: unknown): Promise<WorkspaceToolResult> {
    const path = normalizeWorkspacePath(requestedPath);
    if (path === undefined) {
      return { ok: false, error: 'Path is outside the workspace or invalid.' };
    }
    if (path.length === 0) {
      return { ok: false, error: 'A file path is required.' };
    }
    try {
      const content = await this.fileSystem.readFile(path);
      const limited = content.length > 200000 ? `${content.slice(0, 200000)}\n...[truncated]` : content;
      return { ok: true, output: limited };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Unable to read file.' };
    }
  }

  async listFiles(requestedPath: unknown = ''): Promise<WorkspaceToolResult> {
    const path = normalizeWorkspacePath(requestedPath);
    if (path === undefined) {
      return { ok: false, error: 'Path is outside the workspace or invalid.' };
    }
    try {
      const entries = await this.collectEntries(path, 4, 300);
      const output = entries.length === 0 ? '(empty)' : entries.join('\n');
      return { ok: true, output };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Unable to list files.' };
    }
  }

  async searchFiles(query: unknown, requestedPath: unknown = ''): Promise<WorkspaceToolResult> {
    if (typeof query !== 'string' || query.trim().length === 0) {
      return { ok: false, error: 'A search query is required.' };
    }
    const path = normalizeWorkspacePath(requestedPath);
    if (path === undefined) {
      return { ok: false, error: 'Path is outside the workspace or invalid.' };
    }
    const needle = query.trim().toLowerCase();
    const files = await this.collectFiles(path, 5, 500);
    const matches: string[] = [];
    for (const file of files) {
      if (matches.length >= 100) {
        break;
      }
      try {
        const content = await this.fileSystem.readFile(file);
        const lines = content.split(/\r?\n/);
        for (let index = 0; index < lines.length; index += 1) {
          if (lines[index].toLowerCase().includes(needle)) {
            matches.push(`${file}:${index + 1}: ${lines[index].trim().slice(0, 300)}`);
            if (matches.length >= 100) {
              break;
            }
          }
        }
      } catch {
        // Skip unreadable files during search.
      }
    }
    return { ok: true, output: matches.length === 0 ? '(no matches)' : matches.join('\n') };
  }

  async getWorkspaceContext(query: unknown = ''): Promise<WorkspaceToolResult> {
    const path = '';
    const files = await this.collectFiles(path, 3, 100);
    const listing = files.slice(0, 50).join('\n');
    let searchOutput = '(no query)';
    if (typeof query === 'string' && query.trim().length > 0) {
      const result = await this.searchFiles(query, path);
      searchOutput = result.output ?? '(no matches)';
    }
    return {
      ok: true,
      output: `Workspace root: ${this.rootPath || '(workspace)'}\nFiles:\n${listing || '(empty)'}\n\nSearch results:\n${searchOutput}`,
    };
  }

  toAgentTools(): readonly import('./codingAgent').AgentTool[] {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return [
      {
        name: 'read_file',
        description: 'Read a UTF-8 text file from the workspace.',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        async execute(args) {
          const result = await self.readFile(args.path);
          return toAgentResult('read_file', result);
        },
      },
      {
        name: 'list_files',
        description: 'List files in a workspace directory.',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
        async execute(args) {
          const result = await self.listFiles(args.path);
          return toAgentResult('list_files', result);
        },
      },
      {
        name: 'search_files',
        description: 'Search workspace files for a text query.',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' }, path: { type: 'string' } },
          required: ['query'],
        },
        async execute(args) {
          const result = await self.searchFiles(args.query, args.path);
          return toAgentResult('search_files', result);
        },
      },
      {
        name: 'get_workspace_context',
        description: 'Summarize the workspace and search it for a query.',
        parameters: { type: 'object', properties: { query: { type: 'string' } } },
        async execute(args) {
          const result = await self.getWorkspaceContext(args.query);
          return toAgentResult('get_workspace_context', result);
        },
      },
    ];
  }

  private async collectEntries(basePath: string, depth: number, limit: number): Promise<string[]> {
    const result: string[] = [];
    const stack: Array<{ path: string; depth: number }> = [{ path: basePath, depth: 0 }];
    while (stack.length > 0 && result.length < limit) {
      const current = stack.pop()!;
      if (current.depth > depth) {
        continue;
      }
      const entries = await this.fileSystem.listDirectory(current.path);
      for (const entry of entries) {
        const fullPath = current.path.length === 0 ? entry.name : `${current.path}/${entry.name}`;
        if (entry.type === 'file') {
          result.push(fullPath);
          if (result.length >= limit) {
            break;
          }
        } else if (entry.type === 'directory' && current.depth < depth) {
          stack.push({ path: fullPath, depth: current.depth + 1 });
        }
      }
    }
    return result.sort();
  }

  private async collectFiles(basePath: string, depth: number, limit: number): Promise<string[]> {
    const entries = await this.collectEntries(basePath, depth, limit);
    return entries;
  }
}

function toAgentResult(tool: string, result: WorkspaceToolResult): import('./codingAgent').AgentToolResult {
  return {
    ok: result.ok,
    tool,
    output: result.output,
    error: result.error,
    durationMs: 0,
  };
}
