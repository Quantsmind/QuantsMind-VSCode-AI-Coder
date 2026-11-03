import { expect } from 'chai';
import * as vscode from 'vscode';
import { SettingsService } from '../../src/config/settings';
import { ContextService } from '../../src/context/contextService';

function workspaceRoot(): vscode.Uri {
  const folder = vscode.workspace.workspaceFolders?.[0];
  expect(folder, 'A test workspace folder should be open').to.not.equal(undefined);
  return folder!.uri;
}

function uriFor(relativePath: string): vscode.Uri {
  return vscode.Uri.joinPath(workspaceRoot(), ...relativePath.split('/'));
}

async function openFixture(relativePath: string): Promise<vscode.TextEditor> {
  const document = await vscode.workspace.openTextDocument(uriFor(relativePath));
  return vscode.window.showTextDocument(document);
}

suite('context selection', () => {
  const settings = new SettingsService();
  const context = new ContextService(settings);

  test('builds a selection candidate with 1-based line numbers', async () => {
    const editor = await openFixture('src/example.ts');
    editor.selection = new vscode.Selection(0, 0, 0, 20);

    const candidate = context.fromSelection(editor);

    expect(candidate).to.not.equal(undefined);
    expect(candidate?.path).to.equal('src/example.ts');
    expect(candidate?.isSelection).to.equal(true);
    expect(candidate?.startLine).to.equal(1);
    expect(candidate?.endLine).to.equal(1);
    expect(candidate?.languageId).to.equal('typescript');
    expect(candidate?.content).to.equal('export interface Gre');
  });

  test('ignores empty selections and returns the whole active file otherwise', async () => {
    const editor = await openFixture('src/example.ts');
    editor.selection = new vscode.Selection(0, 0, 0, 0);

    expect(context.fromSelection(editor)).to.equal(undefined);
    const candidate = context.fromActiveFile(editor);
    expect(candidate?.isSelection).to.equal(false);
    expect(candidate?.content).to.contain('export function greet');
  });

  test('reads selected URIs and reports unreadable files', async () => {
    const result = await context.readUris([
      uriFor('src/utils.ts'),
      uriFor('src/does-not-exist.ts'),
    ]);

    expect(result.failures).to.have.length(1);
    expect(result.failures[0].path).to.contain('does-not-exist');
    expect(result.candidates).to.have.length(1);
    expect(result.candidates[0].path).to.equal('src/utils.ts');
    expect(result.candidates[0].content).to.contain('export function sum');
  });

  test('lists attachable files while excluding sensitive and generated paths', async () => {
    const files = await context.listAttachableFiles();
    const paths = files.map((uri) => context.displayPath(uri));

    expect(paths).to.include('src/example.ts');
    expect(paths).to.include('src/utils.ts');
    expect(paths).to.include('README.md');
    expect(paths).to.not.include('.env');
    expect(paths).to.not.include('secrets/credentials.json');
    expect(paths.some((path) => path.includes('node_modules'))).to.equal(false);
  });
});

suite('context building', () => {
  const settings = new SettingsService();
  const context = new ContextService(settings);

  test('redacts detected secrets before content is usable as context', async () => {
    const editor = await openFixture('src/example.ts');
    const candidate = context.fromActiveFile(editor);
    expect(candidate).to.not.equal(undefined);

    const built = await context.build([candidate!]);

    expect(built.items).to.have.length(1);
    expect(built.items[0].content).to.not.contain('sk-demo-not-a-real-key-000000000000');
    expect(built.items[0].content).to.contain('[REDACTED]');
    expect(built.items[0].redactions).to.be.greaterThan(0);
  });

  test('excludes .env and secrets even when explicitly passed as a candidate', async () => {
    const envBytes = await vscode.workspace.fs.readFile(uriFor('.env'));
    const secretBytes = await vscode.workspace.fs.readFile(uriFor('secrets/credentials.json'));

    const built = await context.build([
      { path: '.env', content: Buffer.from(envBytes).toString('utf8') },
      { path: 'secrets/credentials.json', content: Buffer.from(secretBytes).toString('utf8') },
      {
        path: 'src/utils.ts',
        content: 'export function sum(values: readonly number[]): number { return values.length; }',
      },
    ]);

    expect(built.items.map((item) => item.path)).to.deep.equal(['src/utils.ts']);
    expect(built.skipped.map((item) => item.reason)).to.deep.equal(['excluded', 'excluded']);
  });
});
