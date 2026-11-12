import type { RepositoryOverview } from '../repository/discovery';
import type { RepositoryContextSelection } from '../repository/contextSelection';
import type { ContextSelectionOptions } from '../repository/contextSelection';
import type { FileChange } from '../changes/model';
import type { ArchitectureAnalysis } from '../project/architecture';
import type {
  KarkainContextOptions,
  KarkainContextResult,
  KarkainProjectSummary,
} from '../project/karkain';
import type { AgentTool, AgentToolResult } from './codingAgent';

export interface RepositoryIntelligenceLike {
  overview(): Promise<RepositoryOverview>;
  selectContext(query: string, options: ContextSelectionOptions): Promise<RepositoryContextSelection>;
  analyzeChanges(changes: readonly FileChange[], validationCommands?: readonly string[]): Promise<unknown>;
  findSymbols(query: string, limit?: number): Promise<readonly { readonly path: string; readonly name: string; readonly kind: string; readonly line: number; readonly exported: boolean; readonly confidence: string }[]>;
  architecture?(): Promise<ArchitectureAnalysis>;
  karkainContext?(query: string, options?: KarkainContextOptions): Promise<KarkainContextResult>;
  karkainProject?(): Promise<KarkainProjectSummary | undefined>;
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
        ...(overview.inventory !== undefined
          ? {
              languageDetection: overview.inventory.detection,
              ...(overview.inventory.primary !== undefined
                ? {
                    primaryLanguage: overview.inventory.primary.displayName,
                    primaryLanguageConfidence: overview.inventory.primary.confidence,
                  }
                : {}),
              supportingLanguages: overview.inventory.supporting.map((language) => ({
                name: language.displayName,
                files: language.files,
                kind: language.kind,
              })),
            }
          : {}),
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

  async getArchitecture(): Promise<AgentToolResult> {
    if (this.intelligence.architecture === undefined) {
      return { ok: false, tool: 'get_architecture', error: 'Architecture analysis is unavailable.', durationMs: 0 };
    }
    try {
      const architecture = await this.intelligence.architecture();
      const summary = {
        layers: architecture.layers,
        frameworks: architecture.frameworks,
        backend: architecture.backend.slice(0, 40),
        frontend: architecture.frontend.slice(0, 40),
        shared: architecture.shared.slice(0, 40),
        components: architecture.components.slice(0, 40).map((component) => ({
          path: component.path,
          name: component.name,
          layer: component.layer,
          roles: component.roles,
          language: component.language,
          confidence: component.confidence,
          evidence: component.evidence,
          symbols: component.symbols.slice(0, 12),
          dependencies: component.dependencies.slice(0, 12),
        })),
        relationships: architecture.relationships.slice(0, 80).map((relationship) => ({
          from: relationship.from,
          to: relationship.to,
          kind: relationship.kind,
          confidence: relationship.confidence,
          evidence: relationship.evidence,
        })),
        summaryText: architecture.summaryText,
        truncated: architecture.truncated,
      };
      return { ok: true, tool: 'get_architecture', output: JSON.stringify(summary, null, 2), durationMs: 0 };
    } catch (error) {
      return { ok: false, tool: 'get_architecture', error: error instanceof Error ? error.message : 'Unable to inspect architecture.', durationMs: 0 };
    }
  }

  async getKarkainProject(): Promise<AgentToolResult> {
    if (this.intelligence.karkainProject === undefined) {
      return { ok: false, tool: 'get_karkain_project', error: 'Karkain analysis is unavailable.', durationMs: 0 };
    }
    try {
      const project = await this.intelligence.karkainProject();
      if (project === undefined) {
        return { ok: false, tool: 'get_karkain_project', error: 'No Karkain (.kark) sources were found in the workspace.', durationMs: 0 };
      }
      return { ok: true, tool: 'get_karkain_project', output: JSON.stringify(project, null, 2), durationMs: 0 };
    } catch (error) {
      return { ok: false, tool: 'get_karkain_project', error: error instanceof Error ? error.message : 'Unable to inspect the Karkain project.', durationMs: 0 };
    }
  }

  async getKarkainContext(query: unknown, maxFiles = 8): Promise<AgentToolResult> {
    if (this.intelligence.karkainContext === undefined) {
      return { ok: false, tool: 'get_karkain_context', error: 'Karkain analysis is unavailable.', durationMs: 0 };
    }
    if (typeof query !== 'string' || query.trim().length === 0) {
      return { ok: false, tool: 'get_karkain_context', error: 'A query is required.', durationMs: 0 };
    }
    const files = Math.max(1, Math.min(Number(maxFiles) || 8, 40));
    try {
      const context = await this.intelligence.karkainContext(query.trim(), { maxFiles: files });
      return { ok: true, tool: 'get_karkain_context', output: JSON.stringify(context, null, 2), durationMs: 0 };
    } catch (error) {
      return { ok: false, tool: 'get_karkain_context', error: error instanceof Error ? error.message : 'Unable to collect Karkain context.', durationMs: 0 };
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
        name: 'get_architecture',
        description:
          'Inspect the source-based architecture: backend/frontend/shared layers, controllers, services, repositories, models, DTOs, database access, frontend components and routing relationships.',
        parameters: { type: 'object', properties: {} },
        async execute() {
          return self.getArchitecture();
        },
      },
      {
        name: 'get_karkain_project',
        description:
          'Inspect a Karkain (.kark) project: modules, imports, cross-file relationships, types and entry points.',
        parameters: { type: 'object', properties: {} },
        async execute() {
          return self.getKarkainProject();
        },
      },
      {
        name: 'get_karkain_context',
        description:
          'Collect relevant multi-file Karkain context for a query, expanded along module imports.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            maxFiles: { type: 'number' },
          },
          required: ['query'],
        },
        async execute(args) {
          return self.getKarkainContext(args.query, Number(args.maxFiles));
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
