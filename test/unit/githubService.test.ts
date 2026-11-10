import { expect } from 'chai';
import {
  GitHubService,
  parseRemote,
  type FetchFn,
  type HttpRequest,
} from '../../src/github/githubService';

interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly body: string | undefined;
  readonly authorization: string | undefined;
}

function mockGitHub(handler: (request: HttpRequest) => { status: number; body: unknown }): {
  service: GitHubService;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const fetchFn: FetchFn = async (request) => {
    const url = new URL(request.url);
    const response = handler(request);
    requests.push({
      method: request.method,
      path: url.pathname + url.search,
      body: request.body,
      authorization: request.headers.Authorization,
    });
    return {
      status: response.status,
      json: response.body,
      text: typeof response.body === 'string' ? response.body : JSON.stringify(response.body),
    };
  };
  const service = new GitHubService(fetchFn, async () => 'test-token');
  return { service, requests };
}

suite('github remote parsing', () => {
  test('parses HTTPS remotes', () => {
    expect(parseRemote('https://github.com/owner/repo.git')).to.deep.equal({ owner: 'owner', repo: 'repo' });
    expect(parseRemote('https://github.com/owner/repo')).to.deep.equal({ owner: 'owner', repo: 'repo' });
    expect(parseRemote('https://example.com/owner/repo.git')).to.deep.equal({ owner: 'owner', repo: 'repo' });
  });

  test('parses SSH remotes', () => {
    expect(parseRemote('git@github.com:owner/repo.git')).to.deep.equal({ owner: 'owner', repo: 'repo' });
    expect(parseRemote('ssh://git@github.com/owner/repo.git')).to.deep.equal({ owner: 'owner', repo: 'repo' });
  });

  test('rejects invalid remotes', () => {
    expect(parseRemote('')).to.equal(undefined);
    expect(parseRemote('not a url')).to.equal(undefined);
  });
});

suite('github service requests', () => {
  test('lists open issues and excludes pull requests', async () => {
    const { service } = mockGitHub(() => ({
      status: 200,
      body: [
        { number: 1, title: 'Bug', state: 'open', html_url: 'https://x/1', user: { login: 'a' }, created_at: '2026-01-01', comments: 0 },
        { number: 2, title: 'PR', state: 'open', html_url: 'https://x/2', user: { login: 'b' }, created_at: '2026-01-02', comments: 1, pull_request: {} },
      ],
    }));

    const result = await service.listIssues('o', 'r');

    expect(result.ok).to.equal(true);
    if (result.ok) {
      expect(result.data.map((issue) => issue.number)).to.deep.equal([1]);
    }
  });

  test('creates an issue with approval-style payload', async () => {
    const { service, requests } = mockGitHub(() => ({
      status: 201,
      body: { number: 42, title: 'New', state: 'open', html_url: 'https://x/42', user: { login: 'me' }, created_at: '2026-01-01' },
    }));

    const result = await service.createIssue('o', 'r', 'New', 'Body text');

    expect(result.ok).to.equal(true);
    expect(requests[0]?.method).to.equal('POST');
    expect(requests[0]?.path).to.equal('/repos/o/r/issues');
    expect(requests[0]?.body).to.contain('Body text');
  });

  test('creates a pull request with head/base', async () => {
    const { service, requests } = mockGitHub(() => ({
      status: 201,
      body: { number: 7, title: 'PR', state: 'open', html_url: 'https://x/7', user: { login: 'me' }, head: { ref: 'feature' }, base: { ref: 'main' }, created_at: '2026-01-01', draft: false },
    }));

    const result = await service.createPullRequest('o', 'r', 'PR', 'body', 'feature', 'main');

    expect(result.ok).to.equal(true);
    expect(requests[0]?.body).to.contain('feature');
    expect(requests[0]?.body).to.contain('main');
  });

  test('classifies API errors', async () => {
    const cases: Array<[number, string]> = [
      [401, 'unauthenticated'],
      [403, 'forbidden'],
      [404, 'not-found'],
      [422, 'validation'],
      [429, 'rate-limited'],
      [500, 'network'],
    ];

    for (const [status, kind] of cases) {
      const { service } = mockGitHub(() => ({ status, body: { message: 'nope' } }));
      const result = await service.listIssues('o', 'r');
      expect(result.ok).to.equal(false);
      if (!result.ok) {
        expect(result.error.kind, `status ${status}`).to.equal(kind);
        expect(result.error.message).to.not.contain('test-token');
      }
    }
  });

  test('never sends the token in logs or URLs; only in Authorization header', async () => {
    const { service, requests } = mockGitHub(() => ({ status: 200, body: [] }));

    await service.listIssues('owner', 'repo');

    expect(requests).to.have.length(1);
    expect(requests[0]?.path).to.equal('/repos/owner/repo/issues?state=open&per_page=30');
    expect(requests[0]?.authorization).to.equal('Bearer test-token');
    expect(requests[0]?.body).to.equal(undefined);
  });

  test('reports unauthenticated when no token is configured', async () => {
    const service = new GitHubService(async () => ({ status: 200, json: [] }), async () => undefined);

    const result = await service.listIssues('o', 'r');

    expect(result.ok).to.equal(false);
    if (!result.ok) {
      expect(result.error.kind).to.equal('unauthenticated');
    }
  });
});
