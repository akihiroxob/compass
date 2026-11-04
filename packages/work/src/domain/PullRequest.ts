/**
 * GitHubで確認したpull requestの事実（確認時点のsnapshot）。Taskの成果物参照（`accept_task`の`pullRequestUrl`等）とは別で、
 * Serverが実際にGitHubから読んだ値だけをこの形で保存する。
 */
export type PullRequestState = "open" | "closed" | "merged";

export type GitHubRepositoryName = { owner: string; name: string };

export type PullRequestSnapshot = {
  /** `owner/name`（小文字）。PRのbase Repository。 */
  repository: string;
  number: number;
  url: string;
  state: PullRequestState;
  draft: boolean;
  headBranch: string;
  /** 完全な40桁のcommit SHA（小文字）。 */
  headSha: string;
  baseBranch: string;
  /** mergeされたときだけ値を持つ。 */
  mergeSha: string | null;
  author: string;
};

const ownerPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const namePattern = /^[A-Za-z0-9_.-]{1,100}$/;

/**
 * ProjectのRepository URLからGitHubの`owner/name`を得る。`https://github.com/{owner}/{name}`（末尾`/`・`.git`可）だけを受け付け、
 * それ以外（GitHub以外・ローカルの検証用Repository・認証情報やquery付き）はnull。
 */
export const parseGitHubRepositoryUrl = (url: string): GitHubRepositoryName | null => {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "github.com" || parsed.port || parsed.username ||
    parsed.password || parsed.search || parsed.hash) return null;
  const segments = parsed.pathname.replace(/\/+$/, "").replace(/\.git$/i, "").split("/").filter(Boolean);
  if (segments.length !== 2) return null;
  const [owner, name] = segments as [string, string];
  if (!ownerPattern.test(owner) || !namePattern.test(name) || name === "." || name === "..") return null;
  return { owner, name };
};

export const repositoryFullName = (repository: GitHubRepositoryName): string =>
  `${repository.owner}/${repository.name}`.toLowerCase();
