import { redactSecrets } from '../security/redact';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface HttpRequest {
  readonly method: HttpMethod;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
}

export interface HttpResponse {
  readonly status: number;
  readonly json?: unknown;
  readonly text?: string;
  readonly headers?: Record<string, string>;
}

export type FetchFn = (request: HttpRequest) => Promise<HttpResponse>;
export type TokenProvider = () => Promise<string | undefined>;

export interface GitHubError {
  readonly kind: 'unauthenticated' | 'forbidden' | 'rate-limited' | 'not-found' | 'validation' | 'network' | 'unknown';
  readonly status?: number;
  readonly message: string;
}

export interface GitHubViewer {
  readonly login: string;
  readonly name?: string;
}

export interface GitHubIssue {
  readonly number: number;
  readonly title: string;
  readonly state: string;
  readonly url: string;
  readonly author: string;
  readonly createdAt: string;
  readonly comments: number;
}

export interface GitHubPullRequest {
  readonly number: number;
  readonly title: string;
  readonly state: string;
  readonly url: string;
  readonly author: string;
  readonly head: string;
  readonly base: string;
  readonly createdAt: string;
  readonly draft: boolean;
}

export interface GitHubRepo {
  readonly owner: string;
  readonly repo: string;
  readonly fullName: string;
  readonly defaultBranch: string;
  readonly private: boolean;
}

/** Parses a git remote URL into owner/repo. Credentials are never required. */
export function parseRemote(url: string): { owner: string; repo: string } | undefined {
  if (typeof url !== 'string' || url.trim().length === 0) {
    return undefined;
  }
  const trimmed = url.trim();
  // HTTPS-style: https://github.com/owner/repo(.git)
  const https = /^https?:\/\/[^/]+\/([^/]+)\/([^/\s#?]+?)(?:\.git)?\/*(?:#.*)?$/.exec(trimmed);
  if (https !== null) {
    const owner = https[1] ?? '';
    const repo = (https[2] ?? '').replace(/\.git$/, '');
    return owner.length > 0 && repo.length > 0 ? { owner, repo } : undefined;
  }
  // SCP-style SSH: git@github.com:owner/repo(.git)
  const ssh = /^(?:ssh:\/\/)?(?:[^@/]+@)?([^:/]+)[:/]([^/]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(trimmed);
  if (ssh !== null) {
    const owner = ssh[2] ?? '';
    const repo = (ssh[3] ?? '').replace(/\.git$/, '');
    return owner.length > 0 && repo.length > 0 ? { owner, repo } : undefined;
  }
  return undefined;
}

function errorOf(response: HttpResponse): GitHubError {
  const text = typeof response.text === 'string' ? redactSecrets(response.text).text : '';
  let message = text.slice(0, 400);
  try {
    const parsed = typeof response.text === 'string' && response.text.length > 0 ? JSON.parse(response.text) : undefined;
    const msg = (parsed as Record<string, unknown> | undefined)?.message;
    if (typeof msg === 'string') {
      message = redactSecrets(msg).text.slice(0, 400);
    }
  } catch {
    // Keep the raw text slice.
  }
  switch (response.status) {
    case 401:
      return { kind: 'unauthenticated', status: 401, message: 'GitHub authentication is invalid or missing.' };
    case 403:
      return { kind: 'forbidden', status: 403, message: `GitHub refused the request: ${message}` };
    case 404:
      return { kind: 'not-found', status: 404, message: 'The GitHub resource was not found.' };
    case 422:
      return { kind: 'validation', status: 422, message: `GitHub rejected the request: ${message}` };
    case 429:
      return { kind: 'rate-limited', status: 429, message: 'GitHub rate limit reached.' };
    default:
      if (response.status >= 500) {
        return { kind: 'network', status: response.status, message: `GitHub server error (${response.status}).` };
      }
      return { kind: 'unknown', status: response.status, message };
  }
}

function ok(response: HttpResponse): boolean {
  return response.status >= 200 && response.status < 300;
}

/**
 * Thin GitHub REST client. The token is only ever passed inside the
 * Authorization header; error paths never include it. The fetch function is
 * injectable so tests can serve controlled fixtures.
 */
export class GitHubService {
  constructor(
    private readonly fetchFn: FetchFn,
    private readonly tokenProvider: TokenProvider,
    private readonly apiBase = 'https://api.github.com',
  ) {}

  private async request<T>(method: HttpMethod, path: string, body?: unknown): Promise<{ ok: true; data: T } | { ok: false; error: GitHubError }> {
    const token = await this.tokenProvider();
    if (token === undefined || token.trim().length === 0) {
      return { ok: false, error: { kind: 'unauthenticated', message: 'No GitHub credential is configured.' } };
    }
    const url = `${this.apiBase}${path}`;
    const requestBody = body !== undefined ? JSON.stringify(body) : undefined;
    let response: HttpResponse;
    try {
      response = await this.fetchFn({
        method,
        url,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'QuantsMind-VSCode-AI-Coder',
          ...(requestBody !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(requestBody !== undefined ? { body: requestBody } : {}),
      });
    } catch (error) {
      return {
        ok: false,
        error: { kind: 'network', message: `GitHub request failed: ${error instanceof Error ? error.message : 'network error'}` },
      };
    }
    if (!ok(response)) {
      return { ok: false, error: errorOf(response) };
    }
    return { ok: true, data: (response.json ?? {}) as T };
  }

  async getViewer(): Promise<{ ok: true; data: GitHubViewer } | { ok: false; error: GitHubError }> {
    const result = await this.request<{ login?: string; name?: string }>('GET', '/user');
    if (!result.ok) {
      return result;
    }
    return { ok: true, data: { login: result.data.login ?? '(unknown)', ...(result.data.name !== undefined ? { name: result.data.name } : {}) } };
  }

  async getRepo(owner: string, repo: string): Promise<{ ok: true; data: GitHubRepo } | { ok: false; error: GitHubError }> {
    const result = await this.request<{ owner?: { login?: string }; name?: string; default_branch?: string; private?: boolean }>('GET', `/repos/${owner}/${repo}`);
    if (!result.ok) {
      return result;
    }
    const ownerLogin = result.data.owner?.login ?? owner;
    const name = result.data.name ?? repo;
    return {
      ok: true,
      data: {
        owner: ownerLogin,
        repo: name,
        fullName: `${ownerLogin}/${name}`,
        defaultBranch: result.data.default_branch ?? 'main',
        private: result.data.private === true,
      },
    };
  }

  async listIssues(owner: string, repo: string, state: 'open' | 'closed' | 'all' = 'open', limit = 30): Promise<{ ok: true; data: GitHubIssue[] } | { ok: false; error: GitHubError }> {
    const result = await this.request<Array<Record<string, unknown>>>('GET', `/repos/${owner}/${repo}/issues?state=${state}&per_page=${Math.max(1, Math.min(limit, 100))}`);
    if (!result.ok) {
      return result;
    }
    const issues: GitHubIssue[] = [];
    for (const raw of result.data) {
      if (rawIsPullRequest(raw)) {
        continue; // GitHub returns PRs inside the issues feed; exclude them.
      }
      const number = Number(raw.number);
      if (!Number.isFinite(number)) {
        continue;
      }
      issues.push({
        number,
        title: String(raw.title ?? ''),
        state: String(raw.state ?? 'open'),
        url: String(raw.html_url ?? ''),
        author: String((raw.user as Record<string, unknown> | undefined)?.login ?? ''),
        createdAt: String(raw.created_at ?? ''),
        comments: Number(raw.comments ?? 0),
      });
    }
    return { ok: true, data: issues };
  }

  async createIssue(owner: string, repo: string, title: string, body: string): Promise<{ ok: true; data: GitHubIssue } | { ok: false; error: GitHubError }> {
    const result = await this.request<Record<string, unknown>>('POST', `/repos/${owner}/${repo}/issues`, { title, body });
    if (!result.ok) {
      return result;
    }
    return {
      ok: true,
      data: {
        number: Number(result.data.number ?? 0),
        title: String(result.data.title ?? title),
        state: String(result.data.state ?? 'open'),
        url: String(result.data.html_url ?? ''),
        author: String((result.data.user as Record<string, unknown> | undefined)?.login ?? ''),
        createdAt: String(result.data.created_at ?? ''),
        comments: 0,
      },
    };
  }

  async listPullRequests(owner: string, repo: string, state: 'open' | 'closed' | 'all' = 'open', limit = 30): Promise<{ ok: true; data: GitHubPullRequest[] } | { ok: false; error: GitHubError }> {
    const result = await this.request<Array<Record<string, unknown>>>('GET', `/repos/${owner}/${repo}/pulls?state=${state}&per_page=${Math.max(1, Math.min(limit, 100))}`);
    if (!result.ok) {
      return result;
    }
    const pulls: GitHubPullRequest[] = [];
    for (const raw of result.data) {
      const number = Number(raw.number);
      if (!Number.isFinite(number)) {
        continue;
      }
      pulls.push({
        number,
        title: String(raw.title ?? ''),
        state: String(raw.state ?? 'open'),
        url: String(raw.html_url ?? ''),
        author: String((raw.user as Record<string, unknown> | undefined)?.login ?? ''),
        head: String((raw.head as Record<string, unknown> | undefined)?.ref ?? ''),
        base: String((raw.base as Record<string, unknown> | undefined)?.ref ?? ''),
        createdAt: String(raw.created_at ?? ''),
        draft: raw.draft === true,
      });
    }
    return { ok: true, data: pulls };
  }

  async getPullRequest(owner: string, repo: string, number: number): Promise<{ ok: true; data: GitHubPullRequest } | { ok: false; error: GitHubError }> {
    const result = await this.request<Record<string, unknown>>('GET', `/repos/${owner}/${repo}/pulls/${number}`);
    if (!result.ok) {
      return result;
    }
    const raw = result.data;
    return {
      ok: true,
      data: {
        number: Number(raw.number ?? number),
        title: String(raw.title ?? ''),
        state: String(raw.state ?? 'open'),
        url: String(raw.html_url ?? ''),
        author: String((raw.user as Record<string, unknown> | undefined)?.login ?? ''),
        head: String((raw.head as Record<string, unknown> | undefined)?.ref ?? ''),
        base: String((raw.base as Record<string, unknown> | undefined)?.ref ?? ''),
        createdAt: String(raw.created_at ?? ''),
        draft: raw.draft === true,
      },
    };
  }

  async createPullRequest(
    owner: string,
    repo: string,
    title: string,
    body: string,
    head: string,
    base: string,
  ): Promise<{ ok: true; data: GitHubPullRequest } | { ok: false; error: GitHubError }> {
    const result = await this.request<Record<string, unknown>>('POST', `/repos/${owner}/${repo}/pulls`, { title, body, head, base });
    if (!result.ok) {
      return result;
    }
    const raw = result.data;
    return {
      ok: true,
      data: {
        number: Number(raw.number ?? 0),
        title: String(raw.title ?? title),
        state: String(raw.state ?? 'open'),
        url: String(raw.html_url ?? ''),
        author: String((raw.user as Record<string, unknown> | undefined)?.login ?? ''),
        head,
        base,
        createdAt: String(raw.created_at ?? ''),
        draft: raw.draft === true,
      },
    };
  }
}

function rawIsPullRequest(raw: Record<string, unknown> | undefined): boolean {
  if (raw === undefined) {
    return false;
  }
  const pull = (raw as Record<string, unknown>).pull_request;
  return typeof pull === 'object' && pull !== null;
}
