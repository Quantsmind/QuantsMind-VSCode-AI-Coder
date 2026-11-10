import type { Confidence, FileAnalysis } from '../repository/symbols';
import type { RepositoryOverview } from '../repository/discovery';
import type { DependencyGraph } from '../repository/graph';
import { isTestPath, normalizeWorkspacePath } from '../workspace/analyze';

export type ArchitectureLayer = 'backend' | 'frontend' | 'shared' | 'unknown';

export type ArchitectureRole =
  | 'controller'
  | 'service'
  | 'repository'
  | 'model'
  | 'dto'
  | 'database'
  | 'api'
  | 'component'
  | 'route'
  | 'hook'
  | 'config'
  | 'test'
  | 'module';

export interface ArchitectureComponent {
  readonly path: string;
  readonly name: string;
  readonly layer: ArchitectureLayer;
  readonly roles: readonly ArchitectureRole[];
  readonly language: string;
  readonly confidence: Confidence;
  readonly evidence: readonly string[];
  readonly symbols: readonly string[];
  readonly dependencies: readonly string[];
}

export interface ArchitectureRelationship {
  readonly from: string;
  readonly to: string;
  readonly kind: 'imports' | 'renders' | 'routes-to' | 'uses';
  readonly confidence: Confidence;
  readonly evidence: string;
}

export interface ArchitectureLayerSummary {
  readonly layer: ArchitectureLayer;
  readonly files: number;
  readonly components: number;
}

export interface ArchitectureFramework {
  readonly name: string;
  readonly layer: ArchitectureLayer;
  readonly confidence: Confidence;
}

export interface ArchitectureAnalysis {
  readonly layers: readonly ArchitectureLayerSummary[];
  readonly components: readonly ArchitectureComponent[];
  readonly relationships: readonly ArchitectureRelationship[];
  readonly backend: readonly string[];
  readonly frontend: readonly string[];
  readonly shared: readonly string[];
  readonly frameworks: readonly ArchitectureFramework[];
  readonly summaryText: string;
  readonly truncated: boolean;
}

export interface AnalyzeArchitectureOptions {
  readonly maxComponents?: number;
  readonly maxRelationships?: number;
  readonly maxSymbolsPerComponent?: number;
}

const FRONTEND_FRAMEWORKS = new Set([
  'React',
  'Next.js',
  'Vue',
  'Nuxt',
  'Angular',
  'Svelte',
  'Astro',
  'Vite',
  'Electron',
]);

const BACKEND_FRAMEWORKS = new Set([
  'Spring',
  'Spring Boot',
  'Django',
  'Flask',
  'FastAPI',
  'Express',
  'Fastify',
  'NestJS',
  'Gin',
  'Echo',
  'Fiber',
  'SQLAlchemy',
  'Hibernate',
  'Maven',
  'Gradle',
]);

const FRONTEND_IMPORT = /^(?:@angular\/core|react|react-dom|vue|svelte|@sveltejs\/|next\/|nuxt\/|astro\/)/i;
const BACKEND_IMPORT = /^(?:express|fastify|@nestjs\/|django|fastapi|flask|sqlalchemy|hibernate|spring|@springframework|org\.springframework)/i;

const ARCHITECTURE_CONFIG =
  /^(?:package\.json|tsconfig(?:\.[^/]+)?\.json|angular\.json|pyproject\.toml|requirements[^/]*\.txt|pom\.xml|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|Cargo\.toml|go\.mod|karkain\.toml|CMakeLists\.txt|Makefile|Dockerfile|docker-compose\.ya?ml)$/i;

function baseNameOf(path: string): string {
  const normalized = normalizeWorkspacePath(path);
  return normalized.split('/').pop() ?? normalized;
}

function withoutExtension(path: string): string {
  const name = baseNameOf(path);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? name : name.slice(0, dot);
}

function layerForFramework(name: string): ArchitectureLayer {
  if (FRONTEND_FRAMEWORKS.has(name)) {
    return 'frontend';
  }
  if (BACKEND_FRAMEWORKS.has(name)) {
    return 'backend';
  }
  return 'unknown';
}

interface LayerDecision {
  readonly layer: ArchitectureLayer;
  readonly evidence: string;
}

/**
 * Classifies a file into an architectural layer from its path, its analyzed
 * imports, and the frameworks detected for the workspace. The decision is
 * explicit about which rule matched so the result can be reviewed.
 */
export function detectArchitectureLayer(
  path: string,
  analysis: FileAnalysis | undefined,
  overview: RepositoryOverview,
): LayerDecision {
  const normalized = normalizeWorkspacePath(path).toLowerCase();
  const frameworkNames = overview.technologies.map((technology) => technology.name);
  const hasFrontendFramework = frameworkNames.some((framework) => FRONTEND_FRAMEWORKS.has(framework));
  const hasBackendFramework = frameworkNames.some((framework) => BACKEND_FRAMEWORKS.has(framework));

  if (/(^|\/)(web|frontend|client|ui|design-system)\//.test(normalized)) {
    return { layer: 'frontend', evidence: 'frontend directory' };
  }
  if (/(^|\/)(server|backend|api|services|service|controllers?|repositories?|models?|dto|daos?|mappers?|endpoints?)\//.test(normalized)) {
    return { layer: 'backend', evidence: 'backend directory' };
  }
  if (/(^|\/)(shared|common|core|types|interfaces|utils|helpers|lib|libs)\//.test(normalized)) {
    return { layer: 'shared', evidence: 'shared directory' };
  }
  if (/(^|\/)(packages|apps)\/[^/]+\/src\//.test(normalized)) {
    return { layer: 'shared', evidence: 'monorepo package source' };
  }

  if (/(^|\/)[^/]+\.component\.[jt]sx?$/.test(normalized) || /(^|\/)app-routing\.module\.ts$/.test(normalized)) {
    return { layer: 'frontend', evidence: 'Angular component/routing convention' };
  }
  if (/\.(tsx|jsx|vue|svelte)$/.test(normalized) && hasFrontendFramework) {
    return { layer: 'frontend', evidence: 'frontend framework file type' };
  }
  if (/(^|\/)(components?|pages?|views?|layouts?|hooks?)\//.test(normalized) && hasFrontendFramework) {
    return { layer: 'frontend', evidence: 'frontend directory with detected frontend framework' };
  }
  if (/(^|\/)(components?|pages?|views?|layouts?|hooks?)\//.test(normalized) && /\.(tsx|jsx|vue|svelte)$/.test(normalized)) {
    return { layer: 'frontend', evidence: 'frontend component path' };
  }
  if (/(^|\/)(routes?|router|navigation)\//.test(normalized) && hasFrontendFramework) {
    return { layer: 'frontend', evidence: 'frontend routing directory' };
  }

  if (/(^|\/)(controllers?|services?|repositories?|models?|dto|daos?|mappers?|entities|handlers?|endpoints?|routes?|routers?|views|serializers?|urls)\//.test(normalized)) {
    return { layer: 'backend', evidence: 'backend directory' };
  }
  if (/(^|\/)(manage|settings|wsgi|asgi|urls)\.py$/.test(normalized)) {
    return { layer: 'backend', evidence: 'Python application entry/config' };
  }
  if (/(^|\/)(models|views|routers|serializers|admin|apps)\.py$/.test(normalized)) {
    return { layer: 'backend', evidence: 'Python backend module convention' };
  }
  if (/(^|\/)(main|program|startup)\.(go|cs)$/.test(normalized)) {
    return { layer: 'backend', evidence: 'native service entry point' };
  }
  if (/\.(java|py|go|cs|kark)$/.test(normalized) && hasBackendFramework) {
    return { layer: 'backend', evidence: 'backend framework language' };
  }
  if (/\.(c|cc|cpp|cxx|h|hh|hpp|hxx)$/.test(normalized)) {
    return { layer: 'backend', evidence: 'native source' };
  }

  if (analysis !== undefined) {
    for (const reference of analysis.imports) {
      if (FRONTEND_IMPORT.test(reference.specifier)) {
        return { layer: 'frontend', evidence: `imports ${reference.specifier}` };
      }
      if (BACKEND_IMPORT.test(reference.specifier)) {
        return { layer: 'backend', evidence: `imports ${reference.specifier}` };
      }
    }
  }

  return { layer: 'unknown', evidence: 'no layer rule matched' };
}

interface RoleDecision {
  readonly roles: readonly ArchitectureRole[];
  readonly evidence: readonly string[];
}

/** Classifies a file into architecture roles from path, name and symbols. */
export function detectArchitectureRoles(
  path: string,
  analysis: FileAnalysis | undefined,
): RoleDecision {
  const normalized = normalizeWorkspacePath(path).toLowerCase();
  const name = withoutExtension(normalized);
  const segments = normalized.split('/');
  const roles = new Set<ArchitectureRole>();
  const evidence: string[] = [];

  if (isTestPath(normalized)) {
    roles.add('test');
    evidence.push('test path');
  }

  // The directory segment closest to the file wins, so a repository under
  // services/api-java/.../repository/ is a repository, not a service.
  const segmentRoles: ReadonlyArray<readonly [RegExp, ArchitectureRole, string]> = [
    [/^(controllers?|views|endpoints?|handlers?|routers?)$/, 'controller', 'controller directory'],
    [/^(service|usecases?|interactors?)$/, 'service', 'service directory'],
    [/^(repositories?|dal|daos?|mappers?)$/, 'repository', 'repository directory'],
    [/^(models?|entities|domain|schemas?)$/, 'model', 'model directory'],
    [/^(dto|dtos|request|response|payload|vo)$/, 'dto', 'DTO directory'],
    [/^(database|db|databases|migrations?|seeds?)$/, 'database', 'database directory'],
    [/^(routes?|router|navigation|routers?)$/, 'route', 'routing directory'],
    [/^hooks?$/, 'hook', 'hooks directory'],
    [/^(components?|pages?|views?|layouts?)$/, 'component', 'component directory'],
  ];
  for (let index = segments.length - 2; index >= 0; index -= 1) {
    const segment = segments[index] ?? '';
    for (const [pattern, role, label] of segmentRoles) {
      if (pattern.test(segment)) {
        roles.add(role);
        evidence.push(label);
        break;
      }
    }
    if (roles.size > 0) {
      break;
    }
  }

  if (/controller/.test(name)) {
    roles.add('controller');
    evidence.push('controller name');
  } else if (/service/.test(name) && !roles.has('service') && !roles.has('repository')) {
    roles.add('service');
    evidence.push('service name');
  } else if (/(repository|dao|mapper)/.test(name) && !roles.has('repository')) {
    roles.add('repository');
    evidence.push('repository name');
  } else if (/(model|entity|schema|models)/.test(name) && !roles.has('model')) {
    roles.add('model');
    evidence.push('model name');
  } else if (/(dto|request|response|payload)/.test(name) && !roles.has('dto')) {
    roles.add('dto');
    evidence.push('DTO name');
  }

  if (/(database|migration)/.test(name)) {
    roles.add('database');
    evidence.push('database name');
  }

  if (roles.size === 0) {
    if (/\.(tsx|jsx|vue|svelte)$/.test(normalized) || /component/.test(name)) {
      roles.add('component');
      evidence.push('component file type or name');
    }
  }

  if (/(^|\/)(routes?|router|navigation|routers?)\//.test(normalized) ||
      /(route|router|navigation)/.test(name) ||
      /(^|\/)app-routing\.module\.ts$/.test(normalized) ||
      /(^|\/)(urls)\.py$/.test(normalized)) {
    roles.add('route');
    evidence.push('routing path or name');
  }

  if (/^use[A-Z]/.test(baseNameOf(path))) {
    roles.add('hook');
    evidence.push('hook name');
  } else if (/(^|\/)hooks?\//.test(normalized)) {
    roles.add('hook');
    evidence.push('hooks directory');
  }

  if (ARCHITECTURE_CONFIG.test(baseNameOf(normalized))) {
    roles.add('config');
    evidence.push('configuration file');
  }

  if (roles.size === 0) {
    roles.add('module');
    evidence.push('no specific role matched');
    if (analysis !== undefined && analysis.symbols.length > 0) {
      evidence.push(`${analysis.symbols.length} declared symbol(s)`);
    }
  }

  return { roles: [...roles].sort(), evidence: [...new Set(evidence)].sort() };
}

function componentName(path: string, analysis: FileAnalysis | undefined): string {
  if (analysis !== undefined && analysis.symbols.length > 0) {
    const primary =
      analysis.symbols.find((symbol) => symbol.kind === 'class' || symbol.kind === 'struct') ??
      analysis.symbols.find((symbol) => symbol.kind === 'interface' || symbol.kind === 'enum') ??
      analysis.symbols[0];
    if (primary !== undefined) {
      return primary.name;
    }
  }
  return withoutExtension(path);
}

/**
 * Builds a source-based architecture view from analyzed files and the existing
 * dependency graph. Layers, roles and relationships are derived from syntax
 * and imports, not from file-name guesses alone.
 */
export function analyzeArchitecture(
  analyses: readonly FileAnalysis[],
  overview: RepositoryOverview,
  graph: DependencyGraph,
  options: AnalyzeArchitectureOptions = {},
): ArchitectureAnalysis {
  const maxComponents = Math.max(1, Math.min(options.maxComponents ?? 200, 600));
  const maxRelationships = Math.max(1, Math.min(options.maxRelationships ?? 600, 2_000));
  const maxSymbols = Math.max(1, Math.min(options.maxSymbolsPerComponent ?? 20, 80));

  const components: ArchitectureComponent[] = [];
  const backend: string[] = [];
  const frontend: string[] = [];
  const shared: string[] = [];
  const truncated = analyses.length > maxComponents;

  for (const analysis of analyses.slice(0, maxComponents)) {
    if (analysis.error !== undefined) {
      continue;
    }
    const path = normalizeWorkspacePath(analysis.path);
    const layerDecision = detectArchitectureLayer(path, analysis, overview);
    const roleDecision = detectArchitectureRoles(path, analysis);
    const dependencies = graph.edges
      .filter((edge) => edge.from === path)
      .map((edge) => edge.to)
      .slice(0, maxSymbols);
    components.push({
      path,
      name: componentName(path, analysis),
      layer: layerDecision.layer,
      roles: roleDecision.roles,
      language: analysis.language,
      confidence: layerDecision.layer === 'unknown' ? 'heuristic' : 'confirmed',
      evidence: [layerDecision.evidence, ...roleDecision.evidence].slice(0, 6),
      symbols: analysis.symbols.map((symbol) => symbol.name).slice(0, maxSymbols),
      dependencies: [...new Set(dependencies)].sort(),
    });
    if (layerDecision.layer === 'backend') {
      backend.push(path);
    } else if (layerDecision.layer === 'frontend') {
      frontend.push(path);
    } else if (layerDecision.layer === 'shared') {
      shared.push(path);
    }
  }

  const componentByPath = new Map(components.map((component) => [component.path, component]));
  const relationships: ArchitectureRelationship[] = [];
  for (const edge of graph.edges) {
    const from = componentByPath.get(edge.from);
    const to = componentByPath.get(edge.to);
    if (from === undefined || to === undefined) {
      continue;
    }
    let kind: ArchitectureRelationship['kind'] = 'imports';
    if (from.roles.includes('route') && to.roles.includes('component')) {
      kind = 'routes-to';
    } else if (
      from.layer === 'frontend' &&
      to.layer === 'frontend' &&
      (from.roles.includes('component') || from.roles.includes('route')) &&
      to.roles.includes('component')
    ) {
      kind = 'renders';
    } else if (
      (from.roles.includes('controller') && (to.roles.includes('service') || to.roles.includes('repository'))) ||
      (from.roles.includes('service') && to.roles.includes('repository'))
    ) {
      kind = 'uses';
    }
    relationships.push({
      from: edge.from,
      to: edge.to,
      kind,
      confidence: edge.confidence,
      evidence: edge.evidence,
    });
  }
  relationships.sort(
    (left, right) =>
      left.from.localeCompare(right.from) || left.to.localeCompare(right.to) || left.kind.localeCompare(right.kind),
  );

  const layerCounts = new Map<ArchitectureLayer, { files: number; components: number }>();
  for (const layer of ['backend', 'frontend', 'shared', 'unknown'] as const) {
    layerCounts.set(layer, { files: 0, components: 0 });
  }
  for (const component of components) {
    const entry = layerCounts.get(component.layer) ?? { files: 0, components: 0 };
    entry.files += 1;
    entry.components += 1;
    layerCounts.set(component.layer, entry);
  }
  const layers = (['backend', 'frontend', 'shared', 'unknown'] as const).map((layer) => ({
    layer,
    files: layerCounts.get(layer)?.files ?? 0,
    components: layerCounts.get(layer)?.components ?? 0,
  }));

  const frameworks: ArchitectureFramework[] = overview.technologies.map((technology) => ({
    name: technology.name,
    layer: layerForFramework(technology.name),
    confidence: technology.confidence,
  }));

  const lines = [
    `Architecture: ${components.length} component(s), ${relationships.length} relationship(s).`,
    `Layers: ${layers
      .filter((layer) => layer.components > 0)
      .map((layer) => `${layer.layer} (${layer.components})`)
      .join(', ')}.`,
    `Backend: ${backend.slice(0, 8).join(', ') || 'none detected'}.`,
    `Frontend: ${frontend.slice(0, 8).join(', ') || 'none detected'}.`,
    `Shared: ${shared.slice(0, 8).join(', ') || 'none detected'}.`,
    `Frameworks: ${frameworks.map((framework) => `${framework.name} (${framework.layer})`).join(', ') || 'none detected'}.`,
  ];
  const detectedRoles = new Map<ArchitectureRole, number>();
  for (const component of components) {
    for (const role of component.roles) {
      detectedRoles.set(role, (detectedRoles.get(role) ?? 0) + 1);
    }
  }
  const roleSummary = [...detectedRoles.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 8)
    .map(([role, count]) => `${role} (${count})`)
    .join(', ');
  if (roleSummary.length > 0) {
    lines.push(`Roles: ${roleSummary}.`);
  }

  return {
    layers,
    components,
    relationships: relationships.slice(0, maxRelationships),
    backend,
    frontend,
    shared,
    frameworks,
    summaryText: lines.join('\n'),
    truncated,
  };
}

export function architectureComponentByPath(
  analysis: ArchitectureAnalysis,
): ReadonlyMap<string, ArchitectureComponent> {
  return new Map(analysis.components.map((component) => [component.path, component]));
}
