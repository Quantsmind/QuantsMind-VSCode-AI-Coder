import { expect } from 'chai';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  DependencyGraphBuilder,
} from '../../src/repository/graph';
import {
  discoverRepository,
  detectMonorepo,
} from '../../src/repository/discovery';
import { analyzeSourceFile } from '../../src/repository/symbols';
import {
  analyzeArchitecture,
  detectArchitectureRoles,
  detectArchitectureLayer,
} from '../../src/project/architecture';
import { detectFrameworks } from '../../src/workspace/analyze';

const FIXTURE_ROOT = path.join(__dirname, '..', '..', '..', 'test', 'fixtures', 'mixed-monorepo');

function files(): { path: string; content: string }[] {
  const out: { path: string; content: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      const relative = path.relative(FIXTURE_ROOT, absolute).split(path.sep).join('/');
      out.push({ path: relative, content: fs.readFileSync(absolute, 'utf8') });
    }
  };
  walk(FIXTURE_ROOT);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

function entries(): { path: string; size: number }[] {
  return files().map((file) => ({ path: file.path, size: file.content.length }));
}

function configContents(): Record<string, string> {
  const contents: Record<string, string> = {};
  for (const file of files()) {
    if (/(^|\/)(package\.json|pom\.xml|requirements\.txt|go\.mod|CMakeLists\.txt|pnpm-workspace\.yaml|turbo\.json)$/.test(file.path)) {
      contents[file.path] = file.content;
    }
  }
  return contents;
}

function fixtureGraph() {
  const builder = new DependencyGraphBuilder({ maxNodes: 500, maxEdges: 1_000 });
  for (const file of files()) {
    builder.upsert(analyzeSourceFile(file.path, file.content));
  }
  return builder.snapshot();
}

function fixtureArchitecture() {
  const overview = discoverRepository({
    rootName: 'mixed-monorepo',
    entries: entries(),
    configContents: configContents(),
  });
  const analyses = files().map((file) => analyzeSourceFile(file.path, file.content));
  return analyzeArchitecture(analyses, overview, fixtureGraph());
}

suite('framework and monorepo detection', () => {
  const configs = configContents();

  test('detects Spring Boot, React, FastAPI and ignores absent frameworks', () => {
    const frameworks = detectFrameworks(entries(), configs);
    const names = frameworks.map((framework) => framework.name);

    expect(names).to.include('Spring Boot');
    expect(names).to.include('React');
    expect(names).to.include('FastAPI');
    expect(names).to.not.include('Django');
    expect(names).to.not.include('Gin');
  });

  test('detects a package-workspaces monorepo from manifests', () => {
    const monorepo = detectMonorepo(entries().map((entry) => entry.path), configs);

    expect(monorepo.isMonorepo).to.equal(true);
    expect(monorepo.packages).to.include('packages/web');
    expect(monorepo.packages).to.include('packages/shared');
    expect(monorepo.workspaces).to.deep.equal(['packages/*']);
    expect(monorepo.confidence).to.equal('confirmed');
  });

  test('repository discovery reports monorepo, languages and technologies', () => {
    const overview = discoverRepository({
      rootName: 'mixed-monorepo',
      entries: entries(),
      configContents: configs,
    });
    const languageNames = overview.languages.map((language) => language.name);
    const technologyNames = overview.technologies.map((technology) => technology.name);

    expect(overview.monorepo.isMonorepo).to.equal(true);
    expect(languageNames).to.include('TypeScript');
    expect(languageNames).to.include('Java');
    expect(languageNames).to.include('Python');
    expect(languageNames).to.include('Go');
    expect(languageNames).to.include('C++');
    expect(technologyNames).to.include('React');
    expect(technologyNames).to.include('FastAPI');
    expect(technologyNames).to.include('Spring Boot');
    expect(overview.buildSystems.map((system) => system.name)).to.include('Maven');
    expect(overview.buildSystems.map((system) => system.name)).to.include('Python tests');
    expect(overview.buildSystems.map((system) => system.name)).to.include('Go modules');
  });
});

suite('architecture role and layer detection', () => {
  const overview = discoverRepository({
    rootName: 'mixed-monorepo',
    entries: entries(),
    configContents: configContents(),
  });

  test('classifies backend, frontend and shared layers', () => {
    const backend = detectArchitectureLayer('services/api-java/src/main/java/com/demo/controller/UserController.java', undefined, overview);
    const frontend = detectArchitectureLayer('packages/web/src/components/Button.tsx', undefined, overview);
    const shared = detectArchitectureLayer('packages/shared/src/utils.ts', undefined, overview);
    const native = detectArchitectureLayer('cpp/src/engine.cpp', undefined, overview);

    expect(backend.layer).to.equal('backend');
    expect(frontend.layer).to.equal('frontend');
    expect(shared.layer).to.equal('shared');
    expect(native.layer).to.equal('backend');
  });

  test('assigns controller, service, repository, model and dto roles to Java sources', () => {
    const controller = detectArchitectureRoles('services/api-java/src/main/java/com/demo/controller/UserController.java', undefined);
    const service = detectArchitectureRoles('services/api-java/src/main/java/com/demo/service/UserService.java', undefined);
    const repository = detectArchitectureRoles('services/api-java/src/main/java/com/demo/repository/UserRepository.java', undefined);
    const model = detectArchitectureRoles('services/api-java/src/main/java/com/demo/model/User.java', undefined);
    const dto = detectArchitectureRoles('services/api-java/src/main/java/com/demo/dto/CreateUserRequest.java', undefined);

    expect(controller.roles).to.include('controller');
    expect(service.roles).to.include('service');
    expect(repository.roles).to.include('repository');
    expect(model.roles).to.include('model');
    expect(dto.roles).to.include('dto');
  });

  test('assigns component and hook roles to frontend sources', () => {
    const component = detectArchitectureRoles('packages/web/src/components/Button.tsx', undefined);
    const hook = detectArchitectureRoles('packages/web/src/hooks/useAuth.tsx', undefined);
    const route = detectArchitectureRoles('packages/web/src/routes.tsx', undefined);

    expect(component.roles).to.include('component');
    expect(hook.roles).to.include('hook');
    expect(route.roles).to.include('route');
  });

  test('assigns controller and model roles to Python FastAPI sources', () => {
    const router = detectArchitectureRoles('services/api-python/app/routers/users.py', undefined);
    const model = detectArchitectureRoles('services/api-python/app/models.py', undefined);

    expect(router.roles).to.include('controller');
    expect(model.roles).to.include('model');
  });
});

suite('source-based architecture analysis', () => {
  test('separates backend, frontend and shared layers from real files', () => {
    const architecture = fixtureArchitecture();

    expect(architecture.backend).to.include('services/api-java/src/main/java/com/demo/controller/UserController.java');
    expect(architecture.backend).to.include('services/api-python/app/main.py');
    expect(architecture.backend).to.include('services/api-go/main.go');
    expect(architecture.backend).to.include('cpp/src/engine.cpp');
    expect(architecture.frontend).to.include('packages/web/src/components/Button.tsx');
    expect(architecture.frontend).to.include('packages/web/src/hooks/useAuth.tsx');
    expect(architecture.frontend).to.include('packages/web/src/routes.tsx');
    expect(architecture.shared).to.include('packages/shared/src/utils.ts');
  });

  test('identifies frameworks with their architectural layer', () => {
    const architecture = fixtureArchitecture();
    const byName = new Map(architecture.frameworks.map((framework) => [framework.name, framework]));

    expect(byName.get('React')?.layer).to.equal('frontend');
    expect(byName.get('FastAPI')?.layer).to.equal('backend');
    expect(byName.get('Spring Boot')?.layer).to.equal('backend');
  });

  test('reports components with roles, evidence and symbols', () => {
    const architecture = fixtureArchitecture();
    const byPath = new Map(architecture.components.map((component) => [component.path, component]));

    expect(byPath.get('services/api-java/src/main/java/com/demo/controller/UserController.java')?.roles).to.include('controller');
    expect(byPath.get('services/api-java/src/main/java/com/demo/service/UserService.java')?.roles).to.include('service');
    expect(byPath.get('packages/web/src/components/Button.tsx')?.roles).to.include('component');
    expect(byPath.get('packages/web/src/hooks/useAuth.tsx')?.roles).to.include('hook');
    expect(byPath.get('services/api-python/app/routers/users.py')?.layer).to.equal('backend');
    const controller = byPath.get('services/api-java/src/main/java/com/demo/controller/UserController.java');
    expect(controller?.evidence.length).to.be.greaterThan(0);
    expect(controller?.symbols).to.include('UserController');
  });

  test('derives dependency relationships across layers and services', () => {
    const architecture = fixtureArchitecture();
    const relationship = (from: string, to: string) =>
      architecture.relationships.find((candidate) => candidate.from === from && candidate.to === to);

    const controllerToService = relationship(
      'services/api-java/src/main/java/com/demo/controller/UserController.java',
      'services/api-java/src/main/java/com/demo/service/UserService.java',
    );
    expect(controllerToService?.kind).to.equal('uses');

    const serviceToRepository = relationship(
      'services/api-java/src/main/java/com/demo/service/UserService.java',
      'services/api-java/src/main/java/com/demo/repository/UserRepository.java',
    );
    expect(serviceToRepository?.kind).to.equal('uses');

    const routeToComponent = relationship(
      'packages/web/src/routes.tsx',
      'packages/web/src/components/Button.tsx',
    );
    expect(routeToComponent?.kind).to.equal('routes-to');

    const pythonEdge = relationship(
      'services/api-python/app/main.py',
      'services/api-python/app/routers/users.py',
    );
    expect(pythonEdge).to.not.equal(undefined);

    expect(architecture.relationships.length).to.be.greaterThan(3);
  });

  test('summarizes layers and roles in the analysis text', () => {
    const architecture = fixtureArchitecture();

    expect(architecture.summaryText).to.contain('Architecture:');
    expect(architecture.summaryText).to.contain('backend');
    expect(architecture.summaryText).to.contain('frontend');
    expect(architecture.layers.find((layer) => layer.layer === 'backend')?.components).to.be.greaterThan(0);
    expect(architecture.layers.find((layer) => layer.layer === 'frontend')?.components).to.be.greaterThan(0);
  });
});
