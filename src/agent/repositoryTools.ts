import type { RepositoryOverview } from '../repository/discovery';
import type { RepositoryContextSelection } from '../repository/contextSelection';
import type { ContextSelectionOptions } from '../repository/contextSelection';
import type { FileChange } from '../changes/model';
import type { AgentTool, AgentToolResult } from './codingAgent';

export interface RepositoryIntelligenceLike {
  overview(): Promise<RepositoryOverview>;
  selectContext(query: string, options: ContextSelectionOptions): Promise<RepositoryContextSelection>;
  analyzeChanges(changes: readonly FileChange[], validationCommands?: readonly string[]): Promise<unknown>;
  findSymbols(query: string, limit?: number): Promise<readonly { readonly path: string; readonly name: string; readonly kind: string; readonly line: number; readonly exported: boolean; readonly confidence: string }[]>;
}

export class RepositoryTools {
  constructor(private readonly intelligence: RepositoryIntelligenceLike) {}

  async getRepositoryOverview(): Promise<AgentToolResult> {
    try {
      const overview = await this.intelligence.overview();
      const summary = {
        rootName: overview.rootName,
        fileCount: overview.fileCount,
        sourceFileCount: overview.sourceFileCount,
        testFileCount: overview.testFileCount,
        languages: overview.languages.map((language) => language.name),
        technologies: overview.technologies.map((technology) => technology.name),
        entryPoints: [...overview.entryPoints],
        manifests: overview.manifests.map((manifest) => manifest.path),
        buildSystems: overview.buildSystems.map((system) => system.name),
      };
      return { ok: true, tool: 'get_repository_overview', output: JSON.stringify(summary, null, 2), durationMs: 0 };
    } catch (error) {
      return { ok: false, tool: 'get_repository_overview', error: error instanceof Error ? error.message : 'Unable to inspect repository.', durationMs: 0 };
    }
  }

  async selectRepositoryContext(query: unknown, maxFiles = 8, maxChars = 40000): Promise<AgentToolResult> {
    if (typeof query !== 'string' || query.trim().length === 0) {
      return { ok: false, tool: 'select_repository_context', error: 'A query is required.', durationMs: 0 };
    }
    const files = Math.max(1, Math.min(Number(maxFiles) || 8, 50));
    const chars = Math.max(1000, Math.min(Number(maxChars) || 40000, 200000));
    try {
      const selection = await this.intelligence.selectContext(query.trim(), { maxFiles: files, maxChars: chars });
      const output = {
        truncated: selection.truncated,
        budgetChars: selection.budgetChars,
        selections: selection.selections.map((item) => ({
          path: item.path,
          score: item.score,
          reason: item.reason,
          relationship: item.relationship,
          confidence: item.confidence,
        })),
      };
      return { ok: true, tool: 'select_repository_context', output: JSON.stringify(output, null, 2), durationMs: 0 };
    } catch (error) {
      return { ok: false, tool: 'select_repository_context', error: error instanceof Error ? error.message : 'Unable to select repository context.', durationMs: 0 };
    }
  }

  async analyzeChangeImpact(input: { changes?: unknown; validationCommands?: unknown }): Promise<AgentToolResult> {
    const rawChanges = Array.isArray(input.changes) ? input.changes : [];
    const changes: FileChange[] = [];
    for (const value of rawChanges) {
      if (typeof value !== 'object' || value === null) {
        continue;
      }
      const record = value as Record<string, unknown>;
      if (typeof record.kind !== 'string' || typeof record.path !== 'string') {
        continue;
      }
      changes.push({
        id: typeof record.id === 'string' ? record.id : `change-${changes.length + 1}`,
        kind: record.kind as FileChange['kind'],
        path: record.path,
        fromPath: typeof record.fromPath === 'string' ? record.fromPath : undefined,
        content: typeof record.content === 'string' ? record.content : undefined,
        summary: typeof record.summary === 'string' ? record.summary : '',
      });
    }
    if (changes.length === 0) {
      return { ok: false, tool: 'analyze_change_impact', error: 'At least one change is required.', durationMs: 0 };
    }
    const validationCommands = Array.isArray(input.validationCommands)
      ? input.validationCommands.filter((value): value is string => typeof value === 'string')
      : [];
    try {
      const impact = await this.intelligence.analyzeChanges(changes, validationCommands);
      return { ok: true, tool: 'analyze_change_impact', output: JSON.stringify(impact, null, 2), durationMs: 0 };
    } catch (error) {
      return { ok: false, tool: 'analyze_change_impact', error: error instanceof Error ? error.message : 'Unable to analyze change impact.', durationMs: 0 };
    }
  }

  async findSymbols(query: unknown, limit = 50): Promise<AgentToolResult> {
    if (typeof query !== 'string' || query.trim().length === 0) {
      return { ok: false, tool: 'find_symbols', error: 'A query is required.', durationMs: 0 };
    }
    try {
      const symbols = await this.intelligence.findSymbols(query.trim(), Number(limit) || 50);
      return { ok: true, tool: 'find_symbols', output: JSON.stringify(symbols, null, 2), durationMs: 0 };
    } catch (error) {
      return { ok: false, tool: 'find_symbols', error: error instanceof Error ? error.message : 'Unable to find symbols.', durationMs: 0 };
    }
  }

  toAgentTools(): readonly AgentTool[] {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return [
      {
        name: 'get_repository_overview',
        description: 'Inspect the repository structure, languages, technologies, entry points, manifests, and build systems.',
        parameters: { type: 'object', properties: {} },
        async execute() {
          return self.getRepositoryOverview();
        },
      },
      {
        name: 'select_repository_context',
        description: 'Select relevant repository files for a task using the local repository intelligence service.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            maxFiles: { type: 'number' },
            maxChars: { type: 'number' },
          },
          required: ['query'],
        },
        async execute(args) {
          return self.selectRepositoryContext(args.query, Number(args.maxFiles), Number(args.maxChars));
        },
      },
      {
        name: 'find_symbols',
        description: 'Find declarations and symbols in analyzed source files.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            limit: { type: 'number' },
          },
          required: ['query'],
        },
        async execute(args) {
          return self.findSymbols(args.query, Number(args.limit));
        },
      },
      {
        name: 'analyze_change_impact',
        description: 'Analyze the likely impact, affected files, tests, and validation commands for proposed changes.',
        parameters: {
          type: 'object',
          properties: {
            changes: { type: 'array' },
            validationCommands: { type: 'array', items: { type: 'string' } },
          },
          required: ['changes'],
        },
        async execute(args) {
          return self.analyzeChangeImpact({ changes: args.changes, validationCommands: args.validationCommands });
        },
      },
    ];
  }
}
