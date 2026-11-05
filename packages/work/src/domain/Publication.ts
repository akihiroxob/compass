/**
 * 公開確認（Publication）。外部のRuntime（CD・デプロイ通知・稼働確認）が「公開先（target）で、あるRepositoryのrevisionが公開されている」と
 * 観測した原記録。開発の受入（Taskの`accepted`）・PRのmerge・Outcomeの効果とは別の事実として扱い、mergeだけで公開済みにしない。
 * デプロイ方式（Cloudflare・GitHub Actions・手動等）は`method`のラベルとEvidence参照で表し、方式ごとの専用Entityや画面を持たない。
 */

/** 公開記録のrevisionに、変更の対象Commitが含まれるか（GitHubのcompareまたは同一SHAで判定した事実）。判定できなければ記録しない。 */
export type CommitRelation = "included" | "not_included";

/**
 * 変更の公開状況。
 * - `published`: 公開先の最新の記録のrevisionに、変更の対象Commitがすべて含まれる
 * - `not_published`: 公開先の最新の記録のrevisionに、対象Commitが含まれないことを確認した（未公開）
 * - `unconfirmed`: 確認できない（理由は`UnconfirmedReason`）。公開済み・未公開のどちらにも分類しない
 */
export type PublicationStatus = "published" | "not_published" | "unconfirmed";

/**
 * 確認できない理由。
 * - `not_configured`: Projectに公開確認の入力元（`publication:write`のRuntime Credential）も記録もない
 * - `no_revision`: 変更に対象Commitがない（PRが未mergeで、受入成果物のCommitもない）
 * - `no_record`: 対象CommitのRepositoryについて、公開記録がまだない
 * - `not_compared`: 最新の公開記録で、対象Commitとの関係を判定していない（記録後にmergeが判明した・GitHubで判定できなかった）
 */
export type UnconfirmedReason = "not_configured" | "no_revision" | "no_record" | "not_compared";

export const publicationEvidenceKinds = ["deployment", "ci", "url"] as const;
export type PublicationEvidenceKind = (typeof publicationEvidenceKinds)[number];
/** 公開の根拠の参照（本文は持たない）。 */
export type PublicationEvidence = { kind: PublicationEvidenceKind; uri: string };

/** 公開先ごとの状況の判定に使う、公開記録1件と判定済みのCommitの関係。 */
export type PublicationObservation = {
  id: string;
  repositoryId: string;
  target: string;
  observedAt: number;
  /** 受信順（同じ確認日時の記録の後勝ち）。 */
  receivedAt: number;
  relations: ReadonlyMap<string, CommitRelation>;
};

export type TargetPublication = {
  target: string;
  repositoryId: string;
  status: PublicationStatus;
  reason: UnconfirmedReason | null;
  /** 判定に使った最新の記録。 */
  latestRecordId: string;
  /** 対象Commitがすべて含まれた最初の記録と、その確認日時（`published`のときだけ）。 */
  publishedRecordId: string | null;
  publishedAt: number | null;
};

/** 同じ公開先・Repositoryでは、確認日時（同時刻は受信順）の新しい記録が現在の状態を表す。古い通知が後から届いても現在を戻さない。 */
export const isNewerObservation = (a: Pick<PublicationObservation, "observedAt" | "receivedAt" | "id">, b: typeof a) =>
  a.observedAt !== b.observedAt ? a.observedAt > b.observedAt : a.receivedAt !== b.receivedAt ? a.receivedAt > b.receivedAt : a.id > b.id;

const allIncluded = (observation: PublicationObservation, commits: readonly string[]) =>
  commits.every((commit) => observation.relations.get(commit) === "included");

/**
 * 変更の対象Commit（同じRepository）について、公開先ごとの状況を判定する。公開先は記録の（target, Repository）の組。
 * 最新の記録だけで現在を判定し、含まれないCommitが1つでもあれば未公開、判定していないCommitがあれば確認できずとする。
 */
export const targetPublications = (
  commitsByRepository: ReadonlyMap<string, readonly string[]>,
  observations: readonly PublicationObservation[],
): TargetPublication[] => {
  const latest = new Map<string, PublicationObservation>();
  for (const observation of observations) {
    const key = `${observation.target}\u0000${observation.repositoryId}`;
    const current = latest.get(key);
    if (!current || isNewerObservation(observation, current)) latest.set(key, observation);
  }
  return [...latest.values()].flatMap((current): TargetPublication[] => {
    const commits = commitsByRepository.get(current.repositoryId);
    if (!commits || commits.length === 0) return [];
    const relations = commits.map((commit) => current.relations.get(commit));
    const status: PublicationStatus = relations.some((relation) => relation === "not_included")
      ? "not_published"
      : relations.every((relation) => relation === "included") ? "published" : "unconfirmed";
    const published = status === "published"
      ? observations
        .filter((observation) => observation.target === current.target && observation.repositoryId === current.repositoryId &&
          allIncluded(observation, commits))
        .reduce<PublicationObservation | null>((first, observation) => (!first || isNewerObservation(first, observation) ? observation : first), null)
      : null;
    return [{
      target: current.target,
      repositoryId: current.repositoryId,
      status,
      reason: status === "unconfirmed" ? "not_compared" : null,
      latestRecordId: current.id,
      publishedRecordId: published?.id ?? null,
      publishedAt: published?.observedAt ?? null,
    }];
  }).sort((a, b) => a.target.localeCompare(b.target) || a.repositoryId.localeCompare(b.repositoryId));
};

/**
 * 変更全体の公開状況。いずれかの公開先で公開済みなら`published`、そうでなく未公開を確認した公開先があれば`not_published`。
 * 公開先ごとの詳細は`targets`で区別する（例: stagingだけ公開済み）。入力元の設定がなければ`not_configured`で確認できずとする。
 */
export const changePublication = (
  configured: boolean,
  commitsByRepository: ReadonlyMap<string, readonly string[]>,
  observations: readonly PublicationObservation[],
): { status: PublicationStatus; reason: UnconfirmedReason | null; publishedAt: number | null; targets: TargetPublication[] } => {
  const hasCommit = [...commitsByRepository.values()].some((commits) => commits.length > 0);
  if (!configured) return { status: "unconfirmed", reason: "not_configured", publishedAt: null, targets: [] };
  if (!hasCommit) return { status: "unconfirmed", reason: "no_revision", publishedAt: null, targets: [] };
  const targets = targetPublications(commitsByRepository, observations);
  const published = targets.filter((target) => target.status === "published");
  if (published.length > 0) {
    return { status: "published", reason: null, publishedAt: Math.min(...published.map((target) => target.publishedAt!)), targets };
  }
  if (targets.some((target) => target.status === "not_published")) return { status: "not_published", reason: null, publishedAt: null, targets };
  return { status: "unconfirmed", reason: targets.length === 0 ? "no_record" : "not_compared", publishedAt: null, targets };
};
