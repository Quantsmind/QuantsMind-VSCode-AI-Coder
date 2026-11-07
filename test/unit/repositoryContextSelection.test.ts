import { expect } from 'chai';
import {
  explainContextSelection,
  selectRepositoryContext,
} from '../../src/repository/contextSelection';
import { buildDependencyGraph } from '../../src/repository/graph';
import { analyzeSourceFile, type FileAnalysis } from '../../src/repository/symbols';

function items(): FileAnalysis[] {
  return [
    analyzeSourceFile(
      'src/auth.ts',
      'export function login(): boolean { return true; }\nexport class AuthService {}\n',
    ),
    analyzeSourceFile(
      'src/session.ts',
      "import { login } from './auth';\nexport function session(): boolean { return login(); }\n",
    ),
    analyzeSourceFile('src/unrelated.ts', 'export const unrelated = 1;\n'),
    analyzeSourceFile('README.md', '# Demo'),
  ];
}

suite('repository context selection', () => {
  test('ranks symbol matches and explains each selection', () => {
    const entries = items().map((item) => ({ path: item.path }));
    const selection = selectRepositoryContext(
      'update login behavior',
      entries,
      items(),
      buildDependencyGraph(items()),
      { maxFiles: 5, maxChars: 100_000 },
    );

    const auth = selection.selections.find((item) => item.path === 'src/auth.ts');
    expect(auth).to.not.equal(undefined);
    expect(auth?.reason).to.match(/login/);
    expect(auth?.confidence).to.equal('heuristic');
    expect(auth?.relationship).to.equal('public-api');
    expect(selection.selections[0]?.path).to.equal('src/auth.ts');
    expect(explainContextSelection(selection)).to.match(/src\/auth\.ts/);
  });

  test('adds direct dependency context for the highest-ranked files', () => {
    const entries = items().map((item) => ({ path: item.path }));
    const selection = selectRepositoryContext(
      'login',
      entries,
      items(),
      buildDependencyGraph(items()),
      { maxFiles: 8, maxChars: 100_000 },
    );

    const session = selection.selections.find((item) => item.path === 'src/session.ts');
    expect(session).to.not.equal(undefined);
    expect(session?.relationship).to.equal('dependent');
    expect(session?.reason).to.match(/imports src\/auth\.ts/);
  });

  test('respects the character budget and reports truncation', () => {
    const entries = items().map((item) => ({ path: item.path }));
    const selection = selectRepositoryContext(
      'login',
      entries,
      items(),
      buildDependencyGraph(items()),
      { maxFiles: 1, maxChars: 100_000 },
    );

    expect(selection.selections).to.have.length(1);
    expect(selection.truncated).to.equal(true);
  });
});
