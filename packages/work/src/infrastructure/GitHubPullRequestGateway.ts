import { CoordinationError } from "../application/error/CoordinationError.ts";
import type { PullRequestGateway } from "../application/port/PullRequestGateway.ts";
import type { GitHubRepositoryName, PullRequestSnapshot } from "../domain/PullRequest.ts";

type GitHubPullRequest = {
  number?: number;
  html_url?: string;
  state?: string;
  draft?: boolean;
  merged?: boolean;
  merge_commit_sha?: string | null;
  user?: { login?: string };
  head?: { ref?: string; sha?: string };
  base?: { ref?: string; repo?: { full_name?: string } };
};

const shaPattern = /^[a-f0-9]{40}$/i;

export type GitHubPullRequestGatewayOptions = {
  /** 既定は`https://api.github.com`。検証用のGitHub互換adapterへ向けるときだけ変える。 */
  apiBaseUrl?: string;
  /** 任意のtoken。公開Repositoryは無しで読める。ログ・結果へ出さない。 */
  token?: string | null;
  timeoutMs?: number;
  request?: typeof fetch;
};

/** GitHub REST APIからPRを1件読む。書込みはしない。 */
export class GitHubPullRequestGateway implements PullRequestGateway {
  private readonly apiBaseUrl: string;
  private readonly token: string | null;
  private readonly timeoutMs: number;
  private readonly request: typeof fetch;

  constructor(options: GitHubPullRequestGatewayOptions = {}) {
    this.apiBaseUrl = (options.apiBaseUrl ?? "https://api.github.com").replace(/\/+$/, "");
    this.token = options.token?.trim() || null;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.request = options.request ?? fetch;
  }

  async getPullRequest(repository: GitHubRepositoryName, number: number): Promise<PullRequestSnapshot> {
    const path = `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/pulls/${number}`;
    let response: Response;
    try {
      response = await this.request(`${this.apiBaseUrl}${path}`, {
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "compass-server",
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: "error",
      });
    } catch (error) {
      throw new CoordinationError("GITHUB_UNAVAILABLE", `GitHub request failed: ${error instanceof Error ? error.name : "unknown error"}`);
    }
    if (!response.ok) {
      const limited = response.status === 429 || response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after");
      if (!limited && response.status === 404) {
        throw new CoordinationError("PULL_REQUEST_NOT_FOUND", `Pull request ${repository.owner}/${repository.name}#${number} was not found or is not visible`);
      }
      if (!limited && (response.status === 401 || response.status === 403)) {
        throw new CoordinationError("GITHUB_ACCESS_DENIED", `GitHub denied access (HTTP ${response.status})`);
      }
      throw new CoordinationError("GITHUB_UNAVAILABLE", `GitHub returned HTTP ${response.status}`);
    }
    let body: GitHubPullRequest;
    try {
      body = (await response.json()) as GitHubPullRequest;
    } catch {
      throw new CoordinationError("GITHUB_UNAVAILABLE", "GitHub returned an invalid response");
    }
    return this.toSnapshot(body, number);
  }

  private toSnapshot(pr: GitHubPullRequest, number: number): PullRequestSnapshot {
    const merged = pr.merged === true;
    const fullName = pr.base?.repo?.full_name;
    if (pr.number !== number || typeof pr.html_url !== "string" || !shaPattern.test(pr.head?.sha ?? "") ||
      typeof pr.head?.ref !== "string" || typeof pr.base?.ref !== "string" || typeof fullName !== "string" ||
      typeof pr.user?.login !== "string" || (pr.state !== "open" && pr.state !== "closed") ||
      (merged && !shaPattern.test(pr.merge_commit_sha ?? ""))) {
      throw new CoordinationError("GITHUB_UNAVAILABLE", "GitHub returned an invalid pull request response");
    }
    return {
      repository: fullName.toLowerCase(),
      number,
      url: pr.html_url,
      state: merged ? "merged" : pr.state,
      draft: pr.draft === true,
      headBranch: pr.head.ref,
      headSha: pr.head.sha!.toLowerCase(),
      baseBranch: pr.base.ref,
      mergeSha: merged ? pr.merge_commit_sha!.toLowerCase() : null,
      author: pr.user.login,
    };
  }
}
