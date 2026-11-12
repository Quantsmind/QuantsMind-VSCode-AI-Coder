import { expect } from 'chai';
import { findLanguageRelations, explainLanguageRelations } from '../../src/languages/relationships';
import type { FileAnalysis, SymbolInfo, ImportReference } from '../../src/repository/symbols';
import { languageForPath } from '../../src/repository/symbols';
import type { WorkspaceEntry } from '../../src/workspace/analyze';

const entries = (paths: readonly string[]): WorkspaceEntry[] => paths.map((path) => ({ path }));

const symbol = (name: string, kind: SymbolInfo['kind'] = 'class'): SymbolInfo => ({
  name,
  kind,
  line: 1,
  exported: true,
  confidence: 'confirmed',
});

const analysis = (
  path: string,
  symbols: readonly SymbolInfo[] = [],
  imports: readonly ImportReference[] = [],
): FileAnalysis => ({
  path,
  language: languageForPath(path) ?? 'typescript',
  symbols,
  imports,
  exports: [],
  publicApi: symbols.length > 0,
  contentChars: 100,
  truncated: false,
});

suite('cross-language relationships', () => {
  test('links a file that imports a shared proto contract (confirmed)', () => {
    const relations = findLanguageRelations(
      entries(['contracts/user.proto', 'src/client.ts', 'src/other.ts']),
      [
        analysis('src/client.ts', [], [{ specifier: '../contracts/user.proto', kind: 'import', line: 1, confidence: 'confirmed' }]),
        analysis('src/other.ts'),
      ],
    );

    const relation = relations.find((item) => item.from === 'contracts/user.proto' && item.to === 'src/client.ts');
    expect(relation?.kind).to.equal('shared-contract');
    expect(relation?.confidence).to.equal('confirmed');
  });

  test('links co-located bindings beside a shared contract in another language', () => {
    const relations = findLanguageRelations(
      entries(['contracts/orders.proto', 'contracts/orders.service.ts', 'contracts/README.md']),
      [analysis('contracts/orders.service.ts')],
    );

    const relation = relations.find(
      (item) => item.from === 'contracts/orders.proto' && item.to === 'contracts/orders.service.ts',
    );
    expect(relation?.kind).to.equal('shared-contract');
    expect(relation?.confidence).to.equal('heuristic');
  });

  test('matches CREATE TABLE names to model symbols (confirmed)', () => {
    const relations = findLanguageRelations(
      entries(['db/schema.sql', 'src/models/user-account.ts']),
      [analysis('src/models/user-account.ts', [symbol('UserAccount')])],
      { fileContents: { 'db/schema.sql': 'CREATE TABLE user_accounts (id serial primary key, email text);' } },
    );

    const relation = relations.find(
      (item) => item.from === 'db/schema.sql' && item.to === 'src/models/user-account.ts',
    );
    expect(relation?.kind).to.equal('schema-model');
    expect(relation?.confidence).to.equal('confirmed');
  });

  test('matches CREATE TABLE names after per-part singularization', () => {
    const relations = findLanguageRelations(
      entries(['migrations/001.sql', 'src/models/UserAccount.java']),
      [analysis('src/models/UserAccount.java', [symbol('UserAccount')])],
      { fileContents: { 'migrations/001.sql': 'CREATE TABLE IF NOT EXISTS public.user_accounts (id bigint);' } },
    );

    expect(relations.some((item) => item.to === 'src/models/UserAccount.java' && item.kind === 'schema-model')).to.equal(true);
  });

  test('pairs SQL files with modelish files by path tokens without contents', () => {
    const relations = findLanguageRelations(
      entries(['db/orders.sql', 'src/models/orders.ts', 'src/components/orders-widget.ts']),
      [],
    );

    const paired = relations.find(
      (item) => item.from === 'db/orders.sql' && item.to === 'src/models/orders.ts',
    );
    expect(paired?.kind).to.equal('schema-model');
    expect(paired?.confidence).to.equal('heuristic');
  });

  test('links client API layers to server route layers by shared tokens', () => {
    const relations = findLanguageRelations(
      entries(['src/api/users.ts', 'server/routes/users.ts', 'docs/unrelated.md']),
      [],
    );

    const relation = relations.find(
      (item) => item.from === 'src/api/users.ts' && item.to === 'server/routes/users.ts',
    );
    expect(relation?.kind).to.equal('client-server');
  });

  test('links build files to compiled sources in the same tree', () => {
    const relations = findLanguageRelations(
      entries(['CMakeLists.txt', 'src/native/widget.c', 'src/main.ts']),
      [],
    );

    const relation = relations.find(
      (item) => item.from === 'CMakeLists.txt' && item.to === 'src/native/widget.c',
    );
    expect(relation?.kind).to.equal('build-config');
  });

  test('produces no relations for unrelated workspaces', () => {
    const relations = findLanguageRelations(
      entries(['src/a.ts', 'src/b.py', 'docs/readme.md']),
      [analysis('src/a.ts'), analysis('src/b.py')],
    );

    expect(relations).to.deep.equal([]);
  });

  test('relations are self-contained and deterministic', () => {
    const input = entries([
      'contracts/orders.proto',
      'contracts/orders.service.ts',
      'src/api/inventory.ts',
      'server/routes/inventory.ts',
    ]);
    const analyses = [analysis('contracts/orders.service.ts')];
    const first = findLanguageRelations(input, analyses);
    const second = findLanguageRelations(input, analyses);

    expect(first).to.deep.equal(second);
    for (const relation of first) {
      expect(relation.from).to.not.equal(relation.to);
    }
  });

  test('the relations explanation never includes file contents', () => {
    const relations = findLanguageRelations(
      entries(['db/schema.sql', 'src/models/schema-model.ts']),
      [analysis('src/models/schema-model.ts', [symbol('SchemaModel')])],
      { fileContents: { 'db/schema.sql': 'CREATE TABLE schema_models (secret text);' } },
    );

    const explanation = explainLanguageRelations(relations);
    expect(explanation).to.contain('schema_models');
    expect(explanation).to.not.contain('secret text');
  });
});
