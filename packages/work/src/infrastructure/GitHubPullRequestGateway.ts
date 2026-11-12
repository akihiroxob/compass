import { CoordinationError } from "../application/error/CoordinationError.ts";
import type { PullRequestGateway } from "../application/port/PullRequestGateway.ts";
import type { RevisionGateway } from "../application/port/RevisionGateway.ts";
import {
  parseReviewMarker,
  type GitHubRepositoryName,
  type PullRequestCheck,
  type PullRequestReviewEvidence,
  type PullRequestSnapshot,
} from "../domain/PullRequest.ts";

const shaPattern = /^[a-f0-9]{40}$/i;
/** 一覧の読取上限（100件 × page数）。超えたら一部だけで判断しない。 */
const maxPages = 20;

type JsonObject = Record<string, unknown>;
const isObject = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);
const stringField = (object: JsonObject | undefined, key: string): string | null => {
  const value = object?.[key];
  return typeof value === "string" ? value : null;
};
const objectField = (object: JsonObject | undefined, key: string): JsonObject | undefined => {
  const value = object?.[key];
  return isObject(value) ? value : undefined;
};

export type GitHubPullRequestGatewayOptions = {
  /** 既定は`https://api.github.com`。検証用のGitHub互換adapterへ向けるときだけ変える。 */
  apiBaseUrl?: string;
  /** 任意のtoken。公開Repositoryは無しで読める。ログ・結果へ出さない。 */
  token?: string | null;
  timeoutMs?: number;
  request?: typeof fetch;
};

/** GitHub REST APIからPR・コメント・CI結果・commitの関係を読む。書込み（merge・コメント）はしない。 */
export class GitHubPullRequestGateway implements PullRequestGateway, RevisionGateway {
  private readonly apiBaseUrl: string;
  private readonly token: string | null;
  private readonly timeoutMs: number;
  private readonly request: typeof fetch;

  constructor(options: GitHubPullRequestGatewayOptions = {}) {
    this.apiBaseUrl = (options.apiBaseUrl ?? "https://api.github.com").replace(/\/+$/, "");
    this.token = options.token?.trim() || null;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.request = options.request ?? globalThis.fetch.bind(globalThis);
  }

  /**
   * GitHub REST APIを1回読む。HTTPの失敗は`GITHUB_*`・`PULL_REQUEST_NOT_FOUND`に分け、本文はJSONとして返す。
   * `notFoundStatuses`は「対象が無い」とするHTTP状態（commitの読取ではGitHubが不明なSHAを422で返す）。
   */
  private async get(path: string, notFound: string, notFoundStatuses: readonly number[] = [404]): Promise<unknown> {
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
        redirect: "manual",
      });
    } catch (error) {
      throw new CoordinationError("GITHUB_UNAVAILABLE", `GitHub request failed: ${error instanceof Error ? error.name : "unknown error"}`);
    }
    if (!response.ok) {
      const limited = response.status === 429 || response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after");
      if (!limited && notFoundStatuses.includes(response.status)) throw new CoordinationError("PULL_REQUEST_NOT_FOUND", notFound);
      if (!limited && (response.status === 401 || response.status === 403)) {
        throw new CoordinationError("GITHUB_ACCESS_DENIED", `GitHub denied access (HTTP ${response.status})`);
      }
      throw new CoordinationError("GITHUB_UNAVAILABLE", `GitHub returned HTTP ${response.status}`);
    }
    try {
      return await response.json();
    } catch {
      throw new CoordinationError("GITHUB_UNAVAILABLE", "GitHub returned an invalid response");
    }
  }

  /** 一覧APIを最後のpageまで読む。上限を超えたら一部だけで判断せず`GITHUB_UNAVAILABLE`にする。 */
  private async pages(path: string, notFound: string, key?: string): Promise<unknown[]> {
    const entries: unknown[] = [];
    for (let page = 1; page <= maxPages; page += 1) {
      const body = await this.get(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`, notFound);
      const items = key ? (isObject(body) ? body[key] : undefined) : body;
      if (!Array.isArray(items)) throw new CoordinationError("GITHUB_UNAVAILABLE", "GitHub returned an invalid list response");
      entries.push(...items);
      if (items.length < 100) return entries;
    }
    throw new CoordinationError("GITHUB_UNAVAILABLE", `GitHub list exceeded ${maxPages * 100} entries`);
  }

  private repositoryPath(repository: GitHubRepositoryName) {
    return `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`;
  }

  async getPullRequest(repository: GitHubRepositoryName, number: number): Promise<PullRequestSnapshot> {
    const body = await this.get(`${this.repositoryPath(repository)}/pulls/${number}`,
      `Pull request ${repository.owner}/${repository.name}#${number} was not found or is not visible`);
    return this.toSnapshot(body, number);
  }

  async listReviewEvidence(repository: GitHubRepositoryName, number: number): Promise<PullRequestReviewEvidence[]> {
    const comments = await this.pages(`${this.repositoryPath(repository)}/issues/${number}/comments`,
      `Pull request ${repository.owner}/${repository.name}#${number} was not found or is not visible`);
    return comments.flatMap((comment) => {
      if (!isObject(comment)) throw new CoordinationError("GITHUB_UNAVAILABLE", "GitHub returned an invalid comment");
      const body = stringField(comment, "body");
      const marker = body === null ? null : parseReviewMarker(body);
      if (!marker) return [];
      const url = stringField(comment, "html_url");
      const author = stringField(objectField(comment, "user"), "login");
      const commentId = comment.id;
      if (typeof commentId !== "number" || !Number.isSafeInteger(commentId) || url === null || author === null) {
        throw new CoordinationError("GITHUB_UNAVAILABLE", "GitHub returned an invalid comment");
      }
      return [{ commentId, url, author, ...marker }];
    });
  }

  async listChecks(repository: GitHubRepositoryName, sha: string): Promise<PullRequestCheck[]> {
    const path = this.repositoryPath(repository);
    const notFound = `Commit ${sha} was not found in ${repository.owner}/${repository.name}`;
    const [runs, statuses] = await Promise.all([
      this.pages(`${path}/commits/${sha}/check-runs?filter=latest`, notFound, "check_runs"),
      this.pages(`${path}/commits/${sha}/statuses`, notFound),
    ]);
    const invalid = () => new CoordinationError("GITHUB_UNAVAILABLE", "GitHub returned an invalid check");
    const checks: PullRequestCheck[] = runs.map((run) => {
      if (!isObject(run)) throw invalid();
      const name = stringField(run, "name");
      const status = stringField(run, "status");
      const conclusion = stringField(run, "conclusion");
      if (name === null || status === null) throw invalid();
      return { name, state: status === "completed" ? conclusion ?? "pending" : "pending" };
    });
    // commit statusは新しい順に返る。contextごとに最新の1件だけを使う。
    const latest = new Map<string, string>();
    for (const status of statuses) {
      if (!isObject(status)) throw invalid();
      const context = stringField(status, "context");
      const state = stringField(status, "state");
      if (context === null || state === null) throw invalid();
      if (!latest.has(context)) latest.set(context, state);
    }
    return [...checks, ...[...latest].map(([name, state]) => ({ name, state }))];
  }

  async commitExists(repository: GitHubRepositoryName, sha: string): Promise<boolean> {
    try {
      const body = await this.get(`${this.repositoryPath(repository)}/commits/${encodeURIComponent(sha)}`, "commit not found", [404, 422]);
      if (!isObject(body) || typeof body.sha !== "string" || !shaPattern.test(body.sha)) {
        throw new CoordinationError("GITHUB_UNAVAILABLE", "GitHub returned an invalid commit response");
      }
      return body.sha.toLowerCase() === sha.toLowerCase();
    } catch (error) {
      if (error instanceof CoordinationError && error.code === "PULL_REQUEST_NOT_FOUND") return false;
      throw error;
    }
  }

  async containsCommit(repository: GitHubRepositoryName, base: string, head: string): Promise<boolean | null> {
    let body: unknown;
    try {
      body = await this.get(
        `${this.repositoryPath(repository)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?per_page=1`,
        "commit not found",
        [404, 422],
      );
    } catch (error) {
      if (error instanceof CoordinationError && error.code === "PULL_REQUEST_NOT_FOUND") return null;
      throw error;
    }
    const status = isObject(body) ? body.status : undefined;
    if (status === "identical" || status === "ahead") return true;
    if (status === "behind" || status === "diverged") return false;
    throw new CoordinationError("GITHUB_UNAVAILABLE", "GitHub returned an invalid compare response");
  }

  /** 応答は信頼せず、保存する事実の型をすべて実行時に検証する。不正な応答は再確認できる`GITHUB_UNAVAILABLE`にする。 */
  private toSnapshot(body: unknown, number: number): PullRequestSnapshot {
    const invalid = () => new CoordinationError("GITHUB_UNAVAILABLE", "GitHub returned an invalid pull request response");
    if (!isObject(body)) throw invalid();
    const head = objectField(body, "head");
    const base = objectField(body, "base");
    const url = stringField(body, "html_url");
    const state = stringField(body, "state");
    const headBranch = stringField(head, "ref");
    const headSha = stringField(head, "sha");
    const baseBranch = stringField(base, "ref");
    const fullName = stringField(objectField(base, "repo"), "full_name");
    const author = stringField(objectField(body, "user"), "login");
    const { draft, merged } = body;
    const mergeSha = body.merge_commit_sha;
    if (body.number !== number || url === null || (state !== "open" && state !== "closed") ||
      typeof draft !== "boolean" || typeof merged !== "boolean" ||
      headBranch === null || headSha === null || !shaPattern.test(headSha) ||
      baseBranch === null || fullName === null || author === null ||
      (merged && (state !== "closed" || typeof mergeSha !== "string" || !shaPattern.test(mergeSha)))) {
      throw invalid();
    }
    return {
      repository: fullName.toLowerCase(),
      number,
      url,
      state: merged ? "merged" : state,
      draft,
      headBranch,
      headSha: headSha.toLowerCase(),
      baseBranch,
      mergeSha: merged ? (mergeSha as string).toLowerCase() : null,
      author,
    };
  }
}
