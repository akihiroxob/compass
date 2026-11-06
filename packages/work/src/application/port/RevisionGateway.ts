import type { GitHubRepositoryName } from "../../domain/PullRequest.ts";

/**
 * Repositoryのcommitの関係の読取（読取専用）。公開記録のrevisionに変更の対象Commitが含まれるかを、Runtimeの申告ではなく
 * Repositoryの履歴で判定する。失敗は`CoordinationError`で返す（`GITHUB_UNAVAILABLE`はretryable、`GITHUB_ACCESS_DENIED`は設定の問題）。
 */
export interface RevisionGateway {
  /** commitがRepositoryにあるか。無い・見えない（404）はfalse。 */
  commitExists(repository: GitHubRepositoryName, sha: string): Promise<boolean>;
  /**
   * `head`の履歴に`base`が含まれるか。`base`と同じ、または`head`が`base`より先ならtrue、`head`が`base`より前・分岐ならfalse。
   * どちらかのcommitが無い（404）はnull（判定できない）。
   */
  containsCommit(repository: GitHubRepositoryName, base: string, head: string): Promise<boolean | null>;
}
