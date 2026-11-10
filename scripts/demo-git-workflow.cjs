/**
 * v2.4.0 Git + change-management demonstration.
 *
 * Exercises the real Git service against an isolated temporary repository and
 * the real GitHub REST client against a local mock API fixture. No network,
 * no real accounts, no global state changes.
 *
 * Usage: node scripts/demo-git-workflow.cjs
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const base = path.resolve(__dirname, '..');
const { repoInfo, status, diff, listBranches, log, stage, commit, headSha, createBranch, switchBranch, isClean } =
  require(path.join(base, 'out/src/git/gitService.js'));
const { CheckpointService } = require(path.join(base, 'out/src/git/checkpointService.js'));
const { GitHubService } = require(path.join(base, 'out/src/github/githubService.js'));

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quantsmind-git-wf-'));
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Demo User'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'demo@example.com'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: dir, stdio: 'pipe' });
  return dir;
}

async function scenario(name, fn) {
  console.log(`\n=== ${name} ===`);
  try {
    await fn();
  } catch (error) {
    console.error(`  FAIL: ${error && error.message ? error.message : error}`);
    process.exitCode = 1;
  }
}

function say(label, value) {
  console.log(`  ${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
}

function ok(condition) {
  if (!condition) {
    throw new Error('check failed');
  }
  console.log('  OK');
}

async function main() {
  console.log('Karkain-style multi-language repo demonstrating v2.4.0 Git + checkpoint + GitHub');

  const root = makeRepo();
  const checkpointService = new CheckpointService();

  await scenario('seed repository', async () => {
    fs.writeFileSync(path.join(root, 'main.rs'), 'fn main() { println!("x"); }\n');
    fs.writeFileSync(path.join(root, 'README.md'), '# demo\n');
    await stage(root, ['main.rs', 'README.md']);
    const result = await commit(root, 'seed');
    ok(result.ok && (await headSha(root)).match(/^[0-9a-f]{40}$/));
    console.log('  HEAD:', await headSha(root));
  });

  await scenario('detect repository and clean status', async () => {
    const info = await repoInfo(root);
    ok(info.isRepository);
    console.log('  root:', info.root);
    console.log('  branch:', info.branch);
    console.log('  head:', info.headShort);
    const entries = await status(root);
    ok(entries.length === 0);
    ok(await isClean(root));
  });

  await scenario('modify files, inspect status and diff', async () => {
    fs.writeFileSync(path.join(root, 'main.rs'), 'fn main() { println!("y"); }\n');
    fs.writeFileSync(path.join(root, 'new.py'), 'print("new")\n');
    const entries = await status(root);
    say('status entries', entries.map((e) => `${e.path}:${e.state}`).join(', '));
    ok(entries.some((e) => e.path === 'main.rs'));
    ok(entries.some((e) => e.path === 'new.py' && e.untracked));

    const workDiff = await diff(root, { pathspec: 'main.rs' });
    say('diff lines', workDiff.text.split('\n').length);
    ok(workDiff.text.includes('println!("y")'));
  });

  await scenario('checkpoint restore roundtrip', async () => {
    const checkpoint = await checkpointService.createFromFs('demo', ['main.rs'], root, 'before user edit');
    say('checkpoint id', checkpoint.id);

    // User makes a conflicting edit after the checkpoint
    fs.writeFileSync(path.join(root, 'main.rs'), 'fn main() { println!("USER WON"); }\n');

    // Agent tries to restore; user edit must win
    const result = await checkpointService.restore(checkpoint.id, root);
    say('restore', result);
    ok(result.conflicts.length === 1);
    ok(fs.readFileSync(path.join(root, 'main.rs'), 'utf8') === 'fn main() { println!("USER WON"); }\n');
  });

  await scenario('stage and commit with approval', async () => {
    fs.writeFileSync(path.join(root, 'README.md'), '# demo updated\n');
    const staged = await stage(root, ['README.md']);
    ok(staged.ok);
    const committed = await commit(root, 'update readme');
    ok(committed.ok);
    const head = await headSha(root);
    console.log('  committed as:', head);
  });

  await scenario('branch workflow', async () => {
    const created = await createBranch(root, 'feature/demo', { checkout: true });
    ok(created.ok);
    ok((await repoInfo(root)).branch === 'feature/demo');
    const branches = await listBranches(root);
    say('branches', branches.map((b) => `${b.current ? '*' : ' '}${b.name}`).join(', '));
    const switched = await switchBranch(root, 'master');
    ok(switched.ok);
  });

  await scenario('remotes and log', async () => {
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:example/repo.git'], { cwd: root, stdio: 'pipe' });
    const entries = await log(root, 3);
    say('log', entries.map((e) => `${e.shortSha} ${e.subject}`).join(' | '));
    ok(entries.length >= 1);
  });

  await scenario('GitHub REST with mocked API', async () => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const pathname = url.pathname;
      res.setHeader('content-type', 'application/json');
      if (pathname === '/repos/example/repo/issues' && req.method === 'GET') {
        res.end(JSON.stringify([{ number: 42, title: 'Sample issue', state: 'open', html_url: 'https://github.com/example/repo/issues/42', user: { login: 'demodemo' }, created_at: '2026-11-10T00:00:00Z', comments: 0 }]));
        return;
      }
      if (pathname === '/repos/example/repo/pulls' && req.method === 'GET') {
        res.end(JSON.stringify([{ number: 7, title: 'Sample PR', state: 'open', html_url: 'https://github.com/example/repo/pull/7', user: { login: 'demodemo' }, head: { ref: 'feature' }, base: { ref: 'main' }, created_at: '2026-11-10T00:00:00Z', draft: false }]));
        return;
      }
      if (pathname === '/repos/example/repo/issues' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          const parsed = JSON.parse(body);
          res.end(JSON.stringify({ number: 43, title: parsed.title, state: 'open', html_url: 'https://github.com/example/repo/issues/43', user: { login: 'demodemo' }, created_at: '2026-11-10T00:00:00Z', comments: 0 }));
        });
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    const fetchFn = async (request) => {
      const url = new URL(request.url);
      return new Promise((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port,
            path: url.pathname + url.search,
            method: request.method,
            headers: request.headers,
          },
          (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => {
              let json;
              try {
                json = body.length > 0 ? JSON.parse(body) : undefined;
              } catch {
                json = undefined;
              }
              resolve({ status: res.statusCode ?? 0, text: body, json });
            });
          },
        );
        req.on('error', reject);
        if (request.body !== undefined && request.body !== null) {
          req.write(request.body);
        }
        req.end();
      });
    };
    const github = new GitHubService(fetchFn, async () => 'mock-token', `http://127.0.0.1:${port}`);

    const issues = await github.listIssues('example', 'repo', 'open', 10);
    ok(issues.ok && issues.data.length === 1);
    say('open issues', issues.data.map((i) => `#${i.number} ${i.title}`).join(', '));

    const pr = await github.listPullRequests('example', 'repo', 'open', 10);
    ok(pr.ok && pr.data.length === 1);
    say('open prs', pr.data.map((p) => `#${p.number} ${p.title}`).join(', '));

    const created = await github.createIssue('example', 'repo', 'From demo', 'Created via demo');
    ok(created.ok);
    say('created issue', created.ok ? `#${created.data.number}` : 'FAILED');

    // Confirm token is never leaked into outputs
    const log = JSON.stringify({ issues, pr, created });
    ok(!log.includes('mock-token'));

    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  });

  await scenario('final state', async () => {
    const info = await repoInfo(root);
    console.log('  branch:', info.branch, '| head:', info.headShort);
    say('files', fs.readdirSync(root).join(', '));
  });

  await fsp.rm(root, { recursive: true, force: true });
  console.log('\nDemo complete.');
}

main().catch((error) => {
  console.error('Demonstration failed:', error);
  process.exitCode = 1;
});
