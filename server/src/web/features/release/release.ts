// ---- リリース履歴。Web API `GET /api/projects/:projectId/releases`（ADR 0009）の応答の型と、検索・絞り込み・ページングの表示用変換。 ----
// 開発の受入と公開は別の項目として扱う。公開状況はAPIが公開記録だけから導出した値をそのまま表示し、受入・mergeから推測しない。

export type PublicationStatus = "published" | "not_published" | "unconfirmed";
export type UnconfirmedReason = "not_configured" | "no_revision" | "no_record" | "not_compared";
export type EvidenceKind = "deployment" | "ci" | "url";

export type TargetPublication = {
  target: string;
  repositoryId: string;
  status: PublicationStatus;
  reason: UnconfirmedReason | null;
  latestRecordId: string;
  publishedRecordId: string | null;
  publishedAt: number | null;
};

export type ReleaseRevision = { repositoryId: string; commitSha: string; source: "pull_request_merge" | "accepted_deliverable" };

export type ReleaseChange = {
  task: { id: string; title: string; status: string; storyId: string | null; updatedAt: number };
  story: { id: string; title: string; outcomeId: string | null } | null;
  /** 完了したWorkerの実装・検証メモ（原記録はTaskのコメント）。無ければnull。題名では代用しない。 */
  summary: { commentId: string; body: string; truncated: boolean; author: string | null; recordedAt: number } | null;
  development: { status: "accepted" | "not_accepted"; acceptedAt: number | null; acceptedBy: string | null };
  pullRequest: {
    repositoryId: string;
    repository: string;
    number: number;
    url: string;
    state: string;
    headSha: string | null;
    mergeSha: string | null;
    reviewedHeadSha: string | null;
    acceptedMergeSha: string | null;
  } | null;
  revisions: ReleaseRevision[];
  publication: { status: PublicationStatus; reason: UnconfirmedReason | null; publishedAt: number | null; targets: TargetPublication[] };
};

export type PublicationRecordView = {
  id: string;
  repositoryId: string;
  target: string;
  targetUrl: string | null;
  revision: string;
  method: string | null;
  observedAt: number;
  receivedAt: number;
  sequence: number;
  principalId: string;
  evidence: { kind: EvidenceKind; uri: string }[];
  includedCommits: string[];
  notIncludedCommits: string[];
  /** 公開先ごとの最新の記録（現在の状態を決める記録）。 */
  current: boolean;
};

export type ReleaseHistory = {
  projectId: string;
  publicationSource: { configured: boolean; sourceConfigured: boolean; recordCount: number };
  changes: ReleaseChange[];
  publications: PublicationRecordView[];
};

export const releasesPath = (projectId: string) => `/api/projects/${projectId}/releases`;

// ---- ラベル ----

export const publicationStatusLabels: Record<PublicationStatus, string> = { published: "公開済み", not_published: "未公開", unconfirmed: "確認できず" };
export const publicationStatusTones: Record<PublicationStatus, "done" | "waiting" | "muted"> = { published: "done", not_published: "waiting", unconfirmed: "muted" };
export const developmentLabels: Record<ReleaseChange["development"]["status"], string> = { accepted: "受入済み", not_accepted: "未受入" };

export const unconfirmedReasonLabels: Record<UnconfirmedReason, string> = {
  not_configured: "公開確認の入力元が設定されておらず、公開記録もありません。",
  no_revision: "対象Commitがありません（PRが未mergeで、受入成果物のCommitもありません）。",
  no_record: "対象CommitのRepositoryについて、公開記録がまだありません。",
  not_compared: "最新の公開記録で、対象Commitとの関係を判定していません。",
};

export const evidenceKindLabels: Record<EvidenceKind, string> = { deployment: "デプロイ", ci: "CI", url: "URL" };

/** 公開状況の説明。確認できない場合は理由を示し、公開済み・未公開へ分類しない。 */
export const publicationNote = (publication: ReleaseChange["publication"]): string => {
  if (publication.status === "unconfirmed") return publication.reason ? unconfirmedReasonLabels[publication.reason] : "公開状況を確認できません。";
  if (publication.status === "not_published") return "公開先の最新の公開記録に、対象Commitが含まれていません（ロールバックを含みます）。";
  return "公開先の公開記録に、対象Commitがすべて含まれています。";
};

/** 公開入力元の状態。設定の有無・記録件数を、取得できた値だけで示す。 */
export const publicationSourceNote = (source: ReleaseHistory["publicationSource"]): string | null => {
  if (!source.configured) return "公開確認の入力元がProjectに設定されていません。公開状況はすべて「確認できず」として表示します。設定はProjectの設定で、公開確認の記録を許可したRuntime Credentialを発行します。";
  if (source.recordCount === 0) return "公開確認の入力元は設定済みですが、公開記録はまだありません。公開状況はすべて「確認できず」として表示します。";
  return null;
};

export const publicationEffectNote = "公開済みは、利用者や事業への効果が確認できたことを意味しません。効果はOutcomeの評価で別に確認します。";

// ---- 表示する値 ----

/** 変更の時刻。受入済みは受入日時、それ以外はTaskの更新日時（API側の並びと同じ）。 */
export const changeTime = (change: ReleaseChange): number => change.development.acceptedAt ?? change.task.updatedAt;

export const shortSha = (sha: string): string => sha.slice(0, 12);

/** GitHubのRepositoryだけcommitのURLを作る。他のRepositoryは推測せず、URLなしで表示する。 */
export const commitUrl = (repositoryUrl: string | undefined, sha: string): string | null => {
  const match = repositoryUrl?.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  return match ? `https://github.com/${match[1]}/${match[2]}/commit/${sha}` : null;
};

/** 根拠のURI。http(s)のものだけlinkにし、他の方式のURIは文字のまま表示する。 */
export const isHttpUri = (uri: string): boolean => /^https?:\/\//i.test(uri);

/** 変更に関係する公開記録（原記録）。対象Commitを含む・含まない記録に加え、現在の判定が参照する記録（包含未判定を含む）。新しい確認日時から。 */
export const publicationsOfChange = (change: ReleaseChange, publications: readonly PublicationRecordView[]): PublicationRecordView[] => {
  const commits = new Set(change.revisions.map((revision) => `${revision.repositoryId}\u0000${revision.commitSha}`));
  const referenced = new Set(change.publication.targets.flatMap((target) => [target.latestRecordId, target.publishedRecordId]).filter((id): id is string => id !== null));
  return publications
    .filter((record) =>
      referenced.has(record.id) || [...record.includedCommits, ...record.notIncludedCommits].some((sha) => commits.has(`${record.repositoryId}\u0000${sha}`)))
    .sort((a, b) => b.observedAt - a.observedAt || b.sequence - a.sequence);
};

/** 1件の公開記録に関係する変更（Task）。複数Taskを含む公開を、記録から辿れるようにする。 */
export const changesOfPublication = (record: PublicationRecordView, changes: readonly ReleaseChange[]): ReleaseChange[] => {
  const commits = new Set([...record.includedCommits, ...record.notIncludedCommits]);
  return changes.filter((change) => change.revisions.some((revision) => revision.repositoryId === record.repositoryId && commits.has(revision.commitSha)));
};

/** 記録の中で、変更の対象Commitが含まれたか。 */
export const relationOf = (record: PublicationRecordView, change: ReleaseChange): "included" | "not_included" | "not_compared" => {
  const shas = change.revisions.filter((revision) => revision.repositoryId === record.repositoryId).map((revision) => revision.commitSha);
  if (shas.some((sha) => record.notIncludedCommits.includes(sha))) return "not_included";
  if (shas.length > 0 && shas.every((sha) => record.includedCommits.includes(sha))) return "included";
  return "not_compared";
};

// ---- 検索・絞り込み・ページング。条件と開いている詳細はURLのqueryに持つ。 ----

export const releasePageSize = 20;
export const maximumReleaseSearchLength = 200;

export type PublicationFilter = PublicationStatus | "all";
export type ReleaseFilter = { q: string; publication: PublicationFilter; page: number };

const publicationFilters: readonly PublicationFilter[] = ["all", "published", "not_published", "unconfirmed"];

export const parseReleaseFilter = (params: URLSearchParams): ReleaseFilter => {
  const publication = params.get("publication");
  const page = Number(params.get("page"));
  return {
    q: (params.get("q") ?? "").trim().slice(0, maximumReleaseSearchLength),
    publication: publicationFilters.includes(publication as PublicationFilter) ? (publication as PublicationFilter) : "all",
    page: Number.isInteger(page) && page >= 1 ? page : 1,
  };
};

/** 開いている詳細（変更のTask id）。 */
export const parseReleaseChange = (params: URLSearchParams): string | null => params.get("change") || null;

export const hasReleaseFilter = (filter: ReleaseFilter): boolean => filter.q !== "" || filter.publication !== "all";

/** 条件を変えたら1ページ目へ戻る。詳細（change）は条件の変更で閉じず、view等の他のqueryは維持する。 */
export const releaseSearch = (current: URLSearchParams, patch: Partial<ReleaseFilter> & { change?: string | null }): string => {
  const next = new URLSearchParams(current);
  const filterChanged = patch.q !== undefined || patch.publication !== undefined;
  const set = (key: string, value: string | null) => { if (value === null || value === "") next.delete(key); else next.set(key, value); };
  if (patch.q !== undefined) set("q", patch.q);
  if (patch.publication !== undefined) set("publication", patch.publication === "all" ? null : patch.publication);
  if (filterChanged && patch.page === undefined) next.delete("page");
  if (patch.page !== undefined) set("page", patch.page > 1 ? String(patch.page) : null);
  if (patch.change !== undefined) set("change", patch.change);
  const text = next.toString();
  return text ? `?${text}` : "";
};

export const clearedReleaseSearch = (current: URLSearchParams): string => releaseSearch(current, { q: "", publication: "all" });

/** 題名・変更の要約・Story・PR番号・Repository・Commit（前方一致）・公開先・主体の部分一致。空白区切りはすべてを満たす（AND）。 */
const searchText = (change: ReleaseChange): string => [
  change.task.title,
  change.summary?.body ?? "",
  change.story?.title ?? "",
  change.pullRequest ? `#${change.pullRequest.number} ${change.pullRequest.number} ${change.pullRequest.repository}` : "",
  ...change.revisions.map((revision) => revision.commitSha),
  ...change.publication.targets.map((target) => target.target),
  change.development.acceptedBy ?? "",
].join("\n").toLowerCase();

export const filterReleaseChanges = (changes: readonly ReleaseChange[], filter: ReleaseFilter): ReleaseChange[] => {
  const words = filter.q.toLowerCase().split(/\s+/).filter(Boolean);
  return changes.filter((change) =>
    (filter.publication === "all" || change.publication.status === filter.publication) && words.every((word) => searchText(change).includes(word)));
};

export type ReleasePage = { items: ReleaseChange[]; page: number; pageCount: number; total: number };

/** 新しい順の一覧からページを切り出す。範囲外のページは最後のページへ寄せる。 */
export const paginateReleaseChanges = (changes: readonly ReleaseChange[], page: number, size = releasePageSize): ReleasePage => {
  const sorted = [...changes].sort((a, b) => changeTime(b) - changeTime(a) || a.task.id.localeCompare(b.task.id));
  const pageCount = Math.max(1, Math.ceil(sorted.length / size));
  const current = Math.min(Math.max(1, page), pageCount);
  return { items: sorted.slice((current - 1) * size, current * size), page: current, pageCount, total: sorted.length };
};

/** 公開状況ごとの件数。絞り込みの選択肢に添える。 */
export const countByPublication = (changes: readonly ReleaseChange[]): Record<PublicationStatus, number> => {
  const counts: Record<PublicationStatus, number> = { published: 0, not_published: 0, unconfirmed: 0 };
  for (const change of changes) counts[change.publication.status] += 1;
  return counts;
};

/** 一覧に出す要約の抜粋。空白を畳み、長い場合は省略する。要約が無ければnull。 */
export const summaryExcerpt = (change: ReleaseChange, length = 140): string | null => {
  if (!change.summary) return null;
  const text = change.summary.body.replace(/\s+/g, " ").trim();
  return text.length > length ? `${text.slice(0, length)}…` : text;
};
