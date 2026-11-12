import { expect } from 'chai';
import { selectRepositoryContext } from '../../src/repository/contextSelection';
import { findLanguageRelations } from '../../src/languages/relationships';
import { buildLanguageInventory } from '../../src/languages/inventory';
import {
  buildChatLanguageGuidance,
  buildLanguageGuidance,
  buildLanguageDiagnostics,
} from '../../src/languages/prompts';
import { buildSystemPrompt, buildUserContent, buildMessages } from '../../src/chat/prompts';
import { RepositoryTools, type RepositoryIntelligenceLike } from '../../src/agent/repositoryTools';
import type { WorkspaceEntry } from '../../src/workspace/analyze';
import type { FileAnalysis, SymbolInfo } from '../../src/repository/symbols';
import { DependencyGraphBuilder } from '../../src/repository/graph';

const entriesOf = (paths: readonly string[]): WorkspaceEntry[] => paths.map((path) => ({ path }));

const symbol = (name: string): SymbolInfo => ({
  name,
  kind: 'class',
  line: 1,
  exported: true,
  confidence: 'confirmed',
});

const analysis = (path: string, symbols: readonly SymbolInfo[] = []): FileAnalysis => ({
  path,
  language: path.endsWith('.java') ? 'java' : 'typescript',
  symbols,
  imports: [],
  exports: [],
  publicApi: symbols.length > 0,
  contentChars: 120,
  truncated: false,
});

const graphSnapshot = () => new DependencyGraphBuilder().snapshot();

suite('language-adaptive prompt construction', () => {
  const inventory = buildLanguageInventory(
    entriesOf([...Array.from({ length: 8 }, (_, index) => `src/a${index}.ts`), 'pkg/b.py', 'deploy/c.yaml']),
  );

  test('guidance names the primary language, a secondary language and stays bounded', () => {
    const guidance = buildLanguageGuidance(inventory);

    expect(guidance).to.contain('Primary language: TypeScript');
    expect(guidance).to.contain('Also present: Python');
    expect(guidance.length).to.be.lessThanOrEqual(2_000);
  });

  test('guidance is deterministic across calls with the same input', () => {
    expect(buildLanguageGuidance(inventory)).to.equal(buildLanguageGuidance(inventory));
  });

  test('partial or unknown detection explicitly requires the model to say so', () => {
    const partial = buildLanguageInventory(entriesOf(['only/x.ts', 'other/y.py']));
    const guidance = buildLanguageGuidance(partial);

    expect(guidance).to.contain('Detection confidence: partial');
    expect(guidance).to.contain('say so explicitly');

    const unknown = buildLanguageInventory(entriesOf([]));
    expect(buildLanguageGuidance(unknown)).to.contain('Detection confidence: unknown');
  });

  test('an unknown active language degrades to an explicit note', () => {
    const guidance = buildLanguageGuidance(buildLanguageInventory(entriesOf(['src/a.ts'])), {
      activeLanguageId: 'cobol',
    });

    expect(guidance).to.contain('cobol');
    expect(guidance).to.contain('unrecognized');
  });

  test('the chat system prompt embeds guidance verbatim when provided', () => {
    const prompt = buildSystemPrompt('ask', 'Active language: TypeScript.\n- Explicit types at boundaries.');

    expect(prompt).to.contain('Active language: TypeScript.');
    expect(prompt).to.contain('Current task:');
    expect(buildSystemPrompt('ask')).to.not.contain('Active language:');
  });

  test('guidance flows into the system message, provider-agnostically', () => {
    const messages = buildMessages({
      mode: 'generate',
      question: 'Write a function',
      attachments: [],
      languageGuidance: 'Active language: Rust.\n- Ownership and borrowing apply.',
    });

    expect(messages[0]?.role).to.equal('system');
    expect(messages[0]?.content).to.contain('Active language: Rust.');
    expect(messages.map((m) => m.role)).to.deep.equal(['system', 'user']);
  });

  test('chat guidance is bounded and empty without an active language', () => {
    expect(buildChatLanguageGuidance(undefined)).to.equal('');
    expect(buildChatLanguageGuidance('cobol')).to.contain('cobol');
    expect(buildChatLanguageGuidance('typescript').length).to.be.lessThanOrEqual(600);
  });

  test('the user-content framing is unchanged when guidance is injected', () => {
    const userContent = buildUserContent('hello', []);
    expect(userContent).to.equal('hello');
  });

  test('diagnostics list detection, primary and markers without file contents', () => {
    const withMarkers = buildLanguageInventory(entriesOf(['package.json', 'src/a.ts', 'src/b.ts', 'src/c.ts']));
    const text = buildLanguageDiagnostics(withMarkers);

    expect(text).to.contain('Detection: confident');
    expect(text).to.contain('Primary language: TypeScript');
    expect(text).to.contain('package.json');
    expect(text).to.not.contain('secret');
  });
});

suite('language-aware context selection', () => {
  const entries = entriesOf([
    'src/api/inventory.ts',
    'server/routes/inventory.ts',
    'src/components/button.tsx',
    'docs/readme.md',
    'src/models/Order.ts',
    'db/orders.sql',
  ]);
  const analyses = [
    analysis('src/api/inventory.ts'),
    analysis('server/routes/inventory.ts'),
    analysis('src/models/Order.ts', [symbol('Order')]),
  ];
  const relations = findLanguageRelations(entries, analyses, {
    fileContents: { 'db/orders.sql': 'CREATE TABLE orders (id serial primary key);' },
  });

  test('cross-language neighbors are selectable with explicit reasons', () => {
    const selection = selectRepositoryContext('inventory', entries, analyses, graphSnapshot(), {
      maxFiles: 6,
      maxChars: 50_000,
      relations,
    });

    const target = selection.selections.find((item) => item.path === 'server/routes/inventory.ts');
    expect(target, 'expected the server route to be selected via the cross-language relation').to.not.equal(undefined);
    expect(target?.relationship).to.equal('cross-language');
    expect(target?.reason).to.contain('inventory');
  });

  test('unaffordable relation candidates are excluded, not force-fit', () => {
    // docs/readme.md is not analyzable; its 4,000-char estimate exceeds the
    // (minimum clamp of) 500-char budget, so it must be cut with `truncated`.
    const selection = selectRepositoryContext('readme', entries, analyses, graphSnapshot(), {
      maxFiles: 6,
      maxChars: 100,
      relations,
    });

    expect(selection.selections.some((item) => item.path === 'docs/readme.md')).to.equal(false);
    expect(selection.truncated).to.equal(true);
  });

  test('selection without relations keeps prior behavior (no cross-language entries)', () => {
    const selection = selectRepositoryContext('inventory', entries, analyses, graphSnapshot(), {
      maxFiles: 4,
      maxChars: 50_000,
    });

    expect(selection.selections.every((item) => item.relationship !== 'cross-language')).to.equal(true);
  });

  test('sql schema relations connect the query to the model file', () => {
    const selection = selectRepositoryContext('orders', entries, analyses, graphSnapshot(), {
      maxFiles: 6,
      maxChars: 50_000,
      relations,
    });

    expect(selection.selections.some((item) => item.path === 'db/orders.sql')).to.equal(true);
    expect(selection.selections.some((item) => item.path === 'src/models/Order.ts')).to.equal(true);
  });
});

suite('repository overview exposes the language inventory', () => {
  test('get_repository_overview reports detection and primary language', async () => {
    const inventory = buildLanguageInventory(entriesOf(['src/a.ts', 'src/b.ts', 'src/c.ts']));
    const intelligence: RepositoryIntelligenceLike = {
      overview: async () =>
        ({
          rootName: 'fixture',
          fileCount: 3,
          sourceFileCount: 3,
          testFileCount: 0,
          languages: [{ name: 'TypeScript', files: 3, extensions: ['ts'], confidence: 'heuristic' }],
          technologies: [],
          entryPoints: [],
          manifests: [],
          buildSystems: [],
          inventory,
        }) as never,
      selectContext: async () => ({ selections: [], truncated: false, budgetChars: 0 }),
      analyzeChanges: async () => ({}),
      findSymbols: async () => [],
    };
    const tools = new RepositoryTools(intelligence);

    const result = await tools.getRepositoryOverview();

    expect(result.ok).to.equal(true);
    const parsed = JSON.parse(String(result.output)) as Record<string, unknown>;
    expect(parsed['languageDetection']).to.equal('confident');
    expect(parsed['primaryLanguage']).to.equal('TypeScript');
    expect(Array.isArray(parsed['supportingLanguages'])).to.equal(true);
  });
});
