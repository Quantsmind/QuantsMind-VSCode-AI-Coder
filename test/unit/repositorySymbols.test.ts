import { expect } from 'chai';
import {
  analyzeSourceFile,
  exportedNames,
  isBinaryPath,
  isSupportedSourcePath,
  languageForPath,
  symbolNames,
} from '../../src/repository/symbols';

suite('repository symbol analysis', () => {
  test('extracts TypeScript declarations, imports, exports, and masked comments', () => {
    const analysis = analyzeSourceFile(
      'src/widget.ts',
      [
        "import { helper } from './helper';",
        "import type { Shape } from './shape';",
        '// export function commentedOut() {}',
        '/* export class AlsoCommented {} */',
        'export class Widget {',
        '  run(): number { return helper(); }',
        '}',
        'export interface Tool {}',
        'export const makeWidget = (value: number) => value;',
        'export default Widget;',
      ].join('\n'),
    );

    expect(analysis.error).to.equal(undefined);
    expect(analysis.language).to.equal('typescript');
    expect(analysis.publicApi).to.equal(true);
    expect(analysis.symbols.map((symbol) => symbol.name)).to.include.members([
      'Widget',
      'Tool',
      'makeWidget',
    ]);
    expect(analysis.symbols.some((symbol) => symbol.name === 'commentedOut')).to.equal(false);
    expect(analysis.imports.map((item) => item.specifier)).to.include.members([
      './helper',
      './shape',
    ]);
    expect(analysis.imports.every((item) => item.confidence === 'confirmed')).to.equal(true);
    expect(exportedNames(analysis)).to.include.members(['Widget', 'Tool', 'makeWidget']);
    expect(symbolNames(analysis)).to.include('Widget');
  });

  test('extracts Python classes, methods, functions, and relative imports', () => {
    const analysis = analyzeSourceFile(
      'pkg/service.py',
      [
        'from .utils import helper, other',
        'import os',
        '',
        'class Service:',
        '    def run(self):',
        '        return helper()',
        '',
        'def public_entry():',
        '    return Service()',
      ].join('\n'),
    );

    expect(analysis.language).to.equal('python');
    expect(analysis.imports.some((item) => item.specifier === '.utils')).to.equal(true);
    expect(analysis.imports.some((item) => item.specifier === 'os')).to.equal(true);
    const run = analysis.symbols.find((symbol) => symbol.name === 'run');
    expect(run?.kind).to.equal('method');
    expect(run?.container).to.equal('Service');
    expect(analysis.symbols.some((symbol) => symbol.name === 'public_entry')).to.equal(true);
  });

  test('extracts Java, Go, and C/C++ declarations', () => {
    const java = analyzeSourceFile(
      'src/main/java/demo/Service.java',
      [
        'package demo;',
        'import demo.util.Helper;',
        'public class Service {',
        '  public void run() {}',
        '  private int count;',
        '}',
      ].join('\n'),
    );
    expect(java.language).to.equal('java');
    expect(java.imports.map((item) => item.specifier)).to.include('demo.util.Helper');
    expect(java.symbols.some((symbol) => symbol.name === 'Service' && symbol.exported)).to.equal(
      true,
    );
    expect(java.symbols.some((symbol) => symbol.name === 'run')).to.equal(true);

    const go = analyzeSourceFile(
      'internal/widget/widget.go',
      [
        'package widget',
        'import (',
        '  "fmt"',
        '  "example.com/demo/util"',
        ')',
        'type Widget struct { Name string }',
        'func NewWidget() Widget { return Widget{} }',
        'func (w Widget) Run() { fmt.Println(util.Name) }',
      ].join('\n'),
    );
    expect(go.language).to.equal('go');
    expect(go.imports.map((item) => item.specifier)).to.include.members([
      'fmt',
      'example.com/demo/util',
    ]);
    expect(go.symbols.some((symbol) => symbol.name === 'Widget' && symbol.kind === 'struct')).to.equal(
      true,
    );
    expect(go.symbols.some((symbol) => symbol.name === 'NewWidget' && symbol.exported)).to.equal(
      true,
    );

    const cpp = analyzeSourceFile(
      'include/widget.hpp',
      [
        '#include <string>',
        '#include "local.hpp"',
        'class Widget {',
        ' public:',
        '  void run();',
        '};',
        'int compute(int value);',
      ].join('\n'),
    );
    expect(cpp.language).to.equal('cpp');
    expect(cpp.imports.map((item) => item.specifier)).to.include.members([
      'string',
      'local.hpp',
    ]);
    expect(cpp.symbols.some((symbol) => symbol.name === 'Widget')).to.equal(true);
    expect(cpp.publicApi).to.equal(true);
  });

  test('reports unsupported, binary, and truncated input without throwing', () => {
    const unsupported = analyzeSourceFile('README.md', '# title');
    expect(unsupported.error).to.equal('unsupported-language');

    const binary = analyzeSourceFile('src/a.ts', 'const a = 1;\u0000');
    expect(binary.error).to.equal('binary-content');

    const truncated = analyzeSourceFile('src/a.ts', 'export const a = 1;\n'.repeat(100), {
      maxFileChars: 40,
      maxSymbols: 2,
    });
    expect(truncated.truncated).to.equal(true);
    expect(truncated.symbols.length).to.be.at.most(2);

    expect(languageForPath('src/a.ts')).to.equal('typescript');
    expect(languageForPath('src/a.py')).to.equal('python');
    expect(languageForPath('src/a.txt')).to.equal(undefined);
    expect(isSupportedSourcePath('src/a.go')).to.equal(true);
    expect(isBinaryPath('assets/logo.png')).to.equal(true);
  });
});
