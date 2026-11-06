import { z } from "zod";
import { ConflictError, NotFoundError, ValidationError, parseWith, trimmedText } from "@compass/shared";
import { parseGitHubRepositoryUrl, type GitHubRepositoryName } from "../domain/PullRequest.ts";
import {
  changePublication,
  isNewerObservation,
  publicationEvidenceKinds,
  type CommitRelation,
  type PublicationEvidence,
  type PublicationObservation,
} from "../domain/Publication.ts";
import { TaskStatus } from "../domain/TaskStatus.ts";
import { CoordinationError } from "./error/CoordinationError.ts";
import type { RevisionGateway } from "./port/RevisionGateway.ts";
import type {
  AcceptedDeliverable,
  PublicationRecord,
  PublicationRevisionRecord,
  TaskPullRequestRecord,
  WorkStore,
} from "./port/WorkStore.ts";

type Clock = () => number;

/** 1件の公開記録で、対象Commitとの関係をRepositoryの履歴で判定する上限（新しい変更から）。超えた古い変更は判定しない（確認できず）。 */
export const maximumComparedCommits = 100;
const compareConcurrency = 5;

/** http(s)のURLだけを受け付け、認証情報を含むURLは拒否する。表記揺れを`URL#href`へ正規化する。 */
const referenceUri = (label: string) =>
  trimmedText(label, 2_000)
    .refine((value) => URL.canParse(value), { message: `${label} must be a valid URL` })
    .refine((value) => !URL.canParse(value) || ["http:", "https:"].includes(new URL(value).protocol), {
      message: `${label} must use http or https`,
    })
    .refine((value) => !URL.canParse(value) || (new URL(value).username === "" && new URL(value).password === ""), {
      message: `${label} must not contain credentials`,
    })
    .transform((value) => new URL(value).href);

/** Runtimeの公開確認の入力。デプロイ方式によらず共通の契約で、方式は`method`のラベルだけで表す。 */
export const recordPublicationSchema = z.object({
  repositoryId: trimmedText("repositoryId", 200),
  revision: z.string().trim().regex(/^[0-9a-f]{40}$/i, "revision must be a full 40-character commit SHA")
    .transform((value) => value.toLowerCase()),
  target: trimmedText("target", 100),
  targetUrl: referenceUri("targetUrl").nullish().transform((value) => value ?? null),
  method: trimmedText("method", 100).nullish().transform((value) => value ?? null),
  observedAt: z.number().int("observedAt must be an integer").positive("observedAt must be a positive epoch milliseconds value"),
  evidence: z.array(z.object({
    kind: z.enum(publicationEvidenceKinds, { error: `kind must be one of: ${publicationEvidenceKinds.join(", ")}` }),
    uri: referenceUri("uri"),
  })).min(1, "evidence must have at least one reference").max(20, "evidence must have 20 items or fewer"),
});

export type RecordPublicationInput = z.infer<typeof recordPublicationSchema>;

const publicationDto = (record: PublicationRecord, revisions: PublicationRevisionRecord[]) => {
  const of = (relation: CommitRelation) =>
    revisions.filter((revision) => revision.publication_id === record.id && revision.relation === relation).map((revision) => revision.commit_sha).sort();
  return {
    id: record.id,
    projectId: record.project_id,
    repositoryId: record.repository_id,
    target: record.target,
    targetUrl: record.target_url,
    revision: record.revision,
    method: record.method,
    observedAt: record.observed_at,
    receivedAt: record.received_at,
    sequence: record.sequence,
    principalId: record.principal_id,
    evidence: JSON.parse(record.evidence) as PublicationEvidence[],
    /** 記録時に判定した対象Commit。どちらにも無いCommitは判定していない。 */
    includedCommits: of("included"),
    notIncludedCommits: of("not_included"),
  };
};

/** 変更の対象Commit。PRはmerge SHA（受入で照合したSHAを優先）、PRのないTaskは受入成果物のCommit。 */
type ChangeRevision = { repositoryId: string; commitSha: string; source: "pull_request_merge" | "accepted_deliverable" };

const latestAcceptances = async (store: WorkStore, projectId: string) => {
  const accepted = new Map<string, { acceptedAt: number; acceptedBy: string; deliverables: AcceptedDeliverable[]; verification: unknown }>();
  for (const change of await store.listAcceptances(projectId)) {
    const payload = JSON.parse(change.payload) as { deliverables?: AcceptedDeliverable[]; verification?: unknown };
    accepted.set(change.entity_id, {
      acceptedAt: change.occurred_at, acceptedBy: change.principal_id, deliverables: payload.deliverables ?? [], verification: payload.verification ?? null,
    });
  }
  return accepted;
};

const currentPullRequests = (rows: TaskPullRequestRecord[]) => {
  const current = new Map<string, TaskPullRequestRecord>();
  for (const row of rows) {
    const known = current.get(row.task_id);
    if (!known || row.sequence > known.sequence) current.set(row.task_id, row);
  }
  return current;
};

const changeRevisions = (pullRequest: TaskPullRequestRecord | undefined, acceptance: { deliverables: AcceptedDeliverable[] } | undefined) => {
  const revisions: ChangeRevision[] = [];
  const mergeSha = pullRequest?.accepted_merge_sha ?? pullRequest?.merge_sha ?? null;
  if (pullRequest && pullRequest.state === "merged" && mergeSha) {
    revisions.push({ repositoryId: pullRequest.repository_id, commitSha: mergeSha, source: "pull_request_merge" });
  } else if (!pullRequest) {
    for (const deliverable of acceptance?.deliverables ?? []) {
      const commitSha = deliverable.commitSha.toLowerCase();
      if (!revisions.some((revision) => revision.repositoryId === deliverable.repositoryId && revision.commitSha === commitSha)) {
        revisions.push({ repositoryId: deliverable.repositoryId, commitSha, source: "accepted_deliverable" });
      }
    }
  }
  return revisions;
};

/**
 * Project内の変更（PRを登録したTask・受入成果物のあるTask）と対象Commit。新しい変更（受入・更新の新しい順）から並べる。
 */
const projectChanges = async (store: WorkStore, projectId: string) => {
  const [tasks, stories, pullRequests, acceptances] = await Promise.all([
    store.listTasks(projectId),
    store.listStories(projectId),
    store.listProjectPullRequests(projectId),
    latestAcceptances(store, projectId),
  ]);
  const current = currentPullRequests(pullRequests);
  const storyById = new Map(stories.map((story) => [story.id, story]));
  return tasks.flatMap((task) => {
    const pullRequest = current.get(task.id);
    const acceptance = task.status === TaskStatus.ACCEPTED ? acceptances.get(task.id) : undefined;
    if (!pullRequest && !acceptance?.deliverables.length) return [];
    const story = task.story_id ? storyById.get(task.story_id) : undefined;
    return [{ task, story, pullRequest, acceptance, revisions: changeRevisions(pullRequest, acceptance) }];
  }).sort((a, b) =>
    (b.acceptance?.acceptedAt ?? b.task.updated_at) - (a.acceptance?.acceptedAt ?? a.task.updated_at) || a.task.id.localeCompare(b.task.id));
};

const githubRepositoryOf = (url: string): GitHubRepositoryName | null => parseGitHubRepositoryUrl(url);

/**
 * Runtime（CD・デプロイ通知・稼働確認）からの公開確認を原記録として残す。認可（Project Runtime Credentialの`publication:write`）は
 * 入口が先に行い、ここでは記録した主体（principalId）を受け取る。
 *
 * - revisionに変更の対象Commitが含まれるかは、Runtimeの申告ではなくGitHubの履歴（compare）で判定し、記録と同時に保存する。
 *   GitHub以外のRepositoryは同一SHAだけを含むと判定し、他は判定しない（確認できず）。
 * - GitHubの読取はtransactionの外で行い、失敗（`GITHUB_UNAVAILABLE`）なら何も記録しない。同じ入力の再送は同じ記録を返す。
 * - 同じ公開先の後の確認日時の記録が既にあっても、古い通知は原記録として残すだけで現在の状況を戻さない（`superseded: true`）。
 */
export class RecordPublicationUseCase {
  constructor(
    private readonly store: WorkStore,
    private readonly revisions: RevisionGateway | null,
    private readonly clock: Clock = () => Date.now(),
  ) {}

  async execute(principalId: string, projectId: string, raw: unknown) {
    const input = parseWith(recordPublicationSchema, raw, "Publication");
    if (input.observedAt > this.clock()) {
      throw new ValidationError("Publication input is invalid", [{ path: "observedAt", message: "observedAt must not be in the future" }]);
    }
    const repository = await this.assertWritable(this.store, projectId, input.repositoryId);
    const key = { project_id: projectId, repository_id: input.repositoryId, target: input.target, revision: input.revision, observed_at: input.observedAt };
    const existing = await this.store.findPublication(key);
    if (existing) return this.resend(this.store, existing, input);

    const relations = await this.compare(projectId, repository, input);
    return this.store.transaction(async (store) => {
      await this.assertWritable(store, projectId, input.repositoryId);
      const raced = await store.findPublication(key);
      if (raced) return this.resend(store, raced, input);
      const record: PublicationRecord = {
        id: crypto.randomUUID(),
        ...key,
        target_url: input.targetUrl,
        method: input.method,
        evidence: JSON.stringify(input.evidence),
        received_at: this.clock(),
        sequence: await store.nextPublicationSequence(projectId),
        principal_id: principalId,
      };
      const revisions = [...relations].map(([commit_sha, relation]) => ({ publication_id: record.id, commit_sha, relation }));
      await store.insertPublication(record, revisions);
      return { recorded: true, superseded: await this.superseded(store, record), publication: publicationDto(record, revisions) };
    });
  }

  private async assertWritable(store: WorkStore, projectId: string, repositoryId: string) {
    if (!(await store.projects.exists(projectId))) throw new NotFoundError(`Project ${projectId} was not found`);
    if (await store.projects.isArchived(projectId)) {
      throw new ConflictError(`Project ${projectId} is archived`, { projectId, projectStatus: "archived" });
    }
    const repository = await store.projects.findRepository(projectId, repositoryId);
    if (!repository) {
      throw new ValidationError("Publication input is invalid", [
        { path: "repositoryId", message: `Repository ${repositoryId} is not registered in the Project` },
      ]);
    }
    return repository;
  }

  /** 同じ公開先・revision・確認日時の再送。内容（公開先URL・方式・根拠）が違えば別の観測を上書きしない。 */
  private async resend(store: WorkStore, existing: PublicationRecord, input: RecordPublicationInput) {
    const same = existing.target_url === input.targetUrl && existing.method === input.method &&
      existing.evidence === JSON.stringify(input.evidence);
    if (!same) {
      throw new ConflictError("A publication with the same target, revision and observedAt was already recorded with different content", {
        publicationId: existing.id,
        reason: "publication_conflict",
      });
    }
    const revisions = (await store.listPublicationRevisions(existing.project_id)).filter((revision) => revision.publication_id === existing.id);
    return { recorded: false, superseded: await this.superseded(store, existing), publication: publicationDto(existing, revisions) };
  }

  private async superseded(store: WorkStore, record: PublicationRecord) {
    const toObservation = (row: PublicationRecord) => ({ observedAt: row.observed_at, sequence: row.sequence });
    return (await store.listPublications(record.project_id)).some((other) =>
      other.id !== record.id && other.target === record.target && other.repository_id === record.repository_id &&
      isNewerObservation(toObservation(other), toObservation(record)));
  }

  /** revisionと、同じRepositoryの変更の対象Commit（新しい変更から上限まで）の関係。判定できないCommitは含めない。 */
  private async compare(projectId: string, repository: { id: string; url: string }, input: RecordPublicationInput) {
    const commits = [...new Set((await projectChanges(this.store, projectId))
      .flatMap((change) => change.revisions)
      .filter((revision) => revision.repositoryId === repository.id)
      .map((revision) => revision.commitSha))].slice(0, maximumComparedCommits);
    const relations = new Map<string, CommitRelation>();
    for (const commit of commits) if (commit === input.revision) relations.set(commit, "included");
    const github = githubRepositoryOf(repository.url);
    if (!github) return relations;
    if (!this.revisions) throw new CoordinationError("GITHUB_UNAVAILABLE", "GitHub is not configured on this server; nothing was recorded");
    if (!(await this.revisions.commitExists(github, input.revision))) {
      throw new ValidationError("Publication input is invalid", [
        { path: "revision", message: `revision ${input.revision} was not found in ${github.owner}/${github.name}` },
      ]);
    }
    const pending = commits.filter((commit) => !relations.has(commit));
    for (let index = 0; index < pending.length; index += compareConcurrency) {
      const batch = pending.slice(index, index + compareConcurrency);
      const results = await Promise.all(batch.map((commit) => this.revisions!.containsCommit(github, commit, input.revision)));
      batch.forEach((commit, position) => {
        const contained = results[position];
        if (contained !== null && contained !== undefined) relations.set(commit, contained ? "included" : "not_included");
      });
    }
    return relations;
  }
}

/**
 * Projectのリリース履歴の取得（Human向け読取。認可は入口のMembership）。変更（Task・PR・対象Commit）ごとに、開発の受入と公開の状況を
 * 別の項目として返す。公開の状況は公開記録だけから判定し、PRのmerge・Taskの受入を公開済みとしない。原記録（`publications`）も返す。
 */
export class ListProjectReleasesUseCase {
  constructor(
    private readonly store: WorkStore,
    /** Projectに公開確認の入力元（`publication:write`の有効なRuntime Credential）が設定されているか。Accessが判定する。 */
    private readonly publicationSourceConfigured: (projectId: string) => Promise<boolean>,
  ) {}

  async execute(projectId: string) {
    if (!(await this.store.projects.exists(projectId))) throw new NotFoundError(`Project ${projectId} was not found`);
    const [changes, records, revisions, sourceConfigured] = await Promise.all([
      projectChanges(this.store, projectId),
      this.store.listPublications(projectId),
      this.store.listPublicationRevisions(projectId),
      this.publicationSourceConfigured(projectId),
    ]);
    const configured = sourceConfigured || records.length > 0;
    const observations: PublicationObservation[] = records.map((record) => ({
      id: record.id,
      repositoryId: record.repository_id,
      target: record.target,
      observedAt: record.observed_at,
      sequence: record.sequence,
      relations: new Map(revisions.filter((revision) => revision.publication_id === record.id)
        .map((revision) => [revision.commit_sha, revision.relation] as const)),
    }));
    const latest = new Map<string, PublicationObservation>();
    for (const observation of observations) {
      const key = `${observation.target}\u0000${observation.repositoryId}`;
      const known = latest.get(key);
      if (!known || isNewerObservation(observation, known)) latest.set(key, observation);
    }
    const currentIds = new Set([...latest.values()].map((observation) => observation.id));
    return {
      projectId,
      publicationSource: { configured, sourceConfigured, recordCount: records.length },
      changes: changes.map(({ task, story, pullRequest, acceptance, revisions: commits }) => {
        const byRepository = new Map<string, string[]>();
        for (const commit of commits) byRepository.set(commit.repositoryId, [...(byRepository.get(commit.repositoryId) ?? []), commit.commitSha]);
        return {
          task: { id: task.id, title: task.title, status: task.status, storyId: task.story_id, updatedAt: task.updated_at },
          story: story ? { id: story.id, title: story.title, outcomeId: story.outcome_ref } : null,
          development: {
            status: task.status === TaskStatus.ACCEPTED ? "accepted" as const : "not_accepted" as const,
            acceptedAt: acceptance?.acceptedAt ?? null,
            acceptedBy: acceptance?.acceptedBy ?? null,
          },
          pullRequest: pullRequest
            ? {
              repositoryId: pullRequest.repository_id, repository: pullRequest.repository, number: pullRequest.number, url: pullRequest.url,
              state: pullRequest.state, headSha: pullRequest.head_sha, mergeSha: pullRequest.merge_sha,
              reviewedHeadSha: pullRequest.reviewed_head_sha, acceptedMergeSha: pullRequest.accepted_merge_sha,
            }
            : null,
          revisions: commits,
          publication: changePublication(configured, byRepository, observations),
        };
      }),
      publications: records.map((record) => ({ ...publicationDto(record, revisions), current: currentIds.has(record.id) })),
    };
  }
}
