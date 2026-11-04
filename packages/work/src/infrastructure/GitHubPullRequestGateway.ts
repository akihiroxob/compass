import { CoordinationError } from "../application/error/CoordinationError.ts";
import type { PullRequestGateway } from "../application/port/PullRequestGateway.ts";
import type { GitHubRepositoryName, PullRequestSnapshot } from "../domain/PullRequest.ts";

const shaPattern = /^[a-f0-9]{40}$/i;

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
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new CoordinationError("GITHUB_UNAVAILABLE", "GitHub returned an invalid response");
    }
    return this.toSnapshot(body, number);
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
