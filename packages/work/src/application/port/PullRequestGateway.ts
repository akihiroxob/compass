import type { GitHubRepositoryName, PullRequestSnapshot } from "../../domain/PullRequest.ts";

/**
 * GitHubのpull requestの読取（読取専用）。認証情報はServerの環境に置き、Tool入力・結果・記録へ出さない。
 * 失敗は`CoordinationError`で返す。
 * - `GITHUB_UNAVAILABLE`（retryable）: 応答なし・timeout・rate limit・5xx・不正な応答。GitHubの事実は確認できていない
 * - `GITHUB_ACCESS_DENIED`: 認証・権限の不足（401 / 403）
 * - `PULL_REQUEST_NOT_FOUND`: Repository・PRが存在しない、または見えない（404）
 */
export interface PullRequestGateway {
  getPullRequest(repository: GitHubRepositoryName, number: number): Promise<PullRequestSnapshot>;
}
