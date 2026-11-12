import { expect } from 'chai';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { status, repoInfo } from '../../src/git/gitService';

const tempRoots: string[] = [];

/** Language fixture file signatures, kept minimal and language-accurate. */
const LANGUAGE_FIXTURES: ReadonlyArray<{ readonly language: string; readonly path: string; readonly content: string }> = [
  { language: 'Java/Spring', path: 'src/main/java/App.java', content: 'public class App { public static void main(String[] args) {} }\n' },
  { language: 'Python/FastAPI', path: 'app/main.py', content: 'from fastapi import FastAPI\napp = FastAPI()\n' },
  { language: 'Python/Django', path: 'myapp/models.py', content: 'from django.db import models\n' },
  { language: 'Angular', path: 'src/app/app.component.ts', content: 'export class AppComponent {}\n' },
  { language: 'React', path: 'src/App.tsx', content: 'export function App() { return <div/> }\n' },
  { language: 'Go', path: 'cmd/main.go', content: 'package main\nimport "fmt"\nfunc main() { fmt.Println("x") }\n' },
  { language: 'Rust', path: 'src/main.rs', content: 'fn main() { println!("x"); }\n' },
  { language: 'C', path: 'src/main.c', content: 'int main(void) { return 0; }\n' },
  { language: 'C++', path: 'src/engine.cpp', content: 'int answer() { return 42; }\n' },
  { language: 'C#', path: 'Program.cs', content: 'class Program { static void Main() {} }\n' },
  { language: 'PHP', path: 'index.php', content: '<?php echo "x";\n' },
  { language: 'Ruby', path: 'lib/demo.rb', content: 'puts "x"\n' },
  { language: 'Dart/Flutter', path: 'lib/main.dart', content: 'void main() {}\n' },
  { language: 'Karkain', path: 'src/main.kark', content: 'func main() {\n    print("x")\n}\n' },
];

function makeMultiLanguageRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quantsmind-multilang-'));
  tempRoots.push(dir);

  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, stdio: 'pipe' });

  for (const fixture of LANGUAGE_FIXTURES) {
    const target = path.join(dir, fixture.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, fixture.content);
    execFileSync('git', ['add', fixture.path], { cwd: dir, stdio: 'pipe' });
  }
  execFileSync('git', ['commit', '-qm', 'seed'], { cwd: dir, stdio: 'pipe' });

  // Touch one file per language so every entry becomes modified.
  for (const fixture of LANGUAGE_FIXTURES) {
    fs.writeFileSync(path.join(dir, fixture.path), `${fixture.content}\n# modified by test\n`);
  }
  return dir;
}

suiteTeardown(() => {
  for (const root of tempRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

suite('git status on multi-language repository', function () {
  // Creates and inspects a 14-language repo; on loaded machines this
  // exceeds the default 20s budget without changing any assertion.
  this.timeout(45_000);

  test('every language file is tracked and reported as modified', async () => {
    const dir = makeMultiLanguageRepo();

    const info = await repoInfo(dir);
    expect(info.isRepository).to.equal(true);

    const entries = await status(dir);

    expect(entries).to.have.length(LANGUAGE_FIXTURES.length);
    for (const fixture of LANGUAGE_FIXTURES) {
      const entry = entries.find((candidate) => candidate.path === fixture.path.replace(/\\/g, '/'));
      expect(entry, `${fixture.language} should be reported`).to.not.equal(undefined);
      expect(entry?.state).to.equal('modified');
    }
  });

  test('git diff captures all language changes', async () => {
    const dir = makeMultiLanguageRepo();
    const diff = execFileSync('git', ['diff', '--stat'], { cwd: dir, encoding: 'utf8' });

    expect(diff).to.contain('14 files changed');
  });
});
