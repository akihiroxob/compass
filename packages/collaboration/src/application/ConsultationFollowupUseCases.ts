import { randomUUID } from "node:crypto";
import { ConflictError, NotFoundError, ValidationError } from "@compass/shared";
import {
  blocksResumption,
  reflectionStatusOf,
  type Consultation,
  type ConsultationActor,
  type ConsultationArtifact,
  type ConsultationFollowup,
  type ConsultationResolution,
  type ConsultationScope,
  type FollowupKind,
  type ReflectionStatus,
} from "../domain/Consultation.ts";
import { parseArtifactInput, parseFollowupRequestInput, type FollowupRequestInput } from "./consultationSchema.ts";
import { consultationNotFound, requireConsultation, requireScope, requireWritableScope, withReceipt, type Clock } from "./consultationOperation.ts";
import type {
  ConsultationFollowupLinks,
  ConsultationScopeReader,
  ConsultationStore,
  ConsultationUnitOfWork,
  FollowupProject,
  FollowupRepository,
  FollowupTaskState,
} from "./port/ConsultationStore.ts";

/**
 * 文書反映の依頼と、その現在の反映状況。状況は文書反映Task（Work）の状態と受入済み成果物参照から求め、保存しない。
 * `blocksResumption`は元Taskの再開を待たせている（明示的な依存があり、まだ反映済み・取消でない）か。
 */
export type ConsultationFollowupView = ConsultationFollowup & {
  project: FollowupProject | null;
  task: FollowupTaskState | null;
  repository: FollowupRepository | null;
  status: ReflectionStatus;
  blocksResumption: boolean;
  artifacts: ConsultationArtifact[];
};

const followupKindLabels: Record<FollowupKind, string> = { adr: "ADR", specification: "仕様", policy: "Policy" };

/** 相談の文書反映の依頼と反映状況（作成順）。 */
export const describeFollowups = async (
  store: ConsultationStore,
  links: ConsultationFollowupLinks,
  consultationId: string,
): Promise<ConsultationFollowupView[]> => {
  const [followups, artifacts] = await Promise.all([store.listFollowups(consultationId), store.listArtifacts(consultationId)]);
  const views: ConsultationFollowupView[] = [];
  for (const followup of followups) {
    const task = await links.findTask(followup.projectId, followup.taskId);
    const own = artifacts.filter((artifact) => artifact.followupId === followup.id);
    // Taskが見つからない（削除された）依頼は反映済みにせず、対応中として残す。
    const status = task ? reflectionStatusOf(task.status, own.length) : "in_progress";
    views.push({
      ...followup,
      project: await links.findProject(followup.projectId),
      task,
      repository: await links.findRepository(followup.projectId, followup.repositoryId),
      status,
      blocksResumption: blocksResumption(followup, status),
      artifacts: own,
    });
  }
  return views;
};

/**
 * 文書反映の依頼先。反映担当Projectは存在してarchivedでなく、相談の所属に含まれる（Project相談はそのProject自身、Workspace相談は
 * そのWorkspaceに所属するProject）。所属しないProjectからは、相談の存在を区別せずNOT_FOUNDにする。
 */
const requireFollowupProject = async (
  scopes: ConsultationScopeReader,
  scope: ConsultationScope,
  projectId: string,
  consultationId: string,
  access: "read" | "write" = "write",
) => {
  const project = await (access === "write" ? requireWritableScope : requireScope)(scopes, { kind: "project", projectId });
  const belongs = scope.kind === "project" ? scope.projectId === projectId : project.workspaceId === scope.workspaceId;
  if (!belongs) throw consultationNotFound(consultationId);
};

const requireResolved = async (store: ConsultationStore, consultation: Consultation): Promise<ConsultationResolution> => {
  const resolution = consultation.status === "resolved" ? await store.findResolution(consultation.id) : null;
  if (!resolution) {
    throw new ConflictError("Only a resolved Consultation can hand its conclusion to a document Task", {
      conflict: "CONSULTATION_NOT_RESOLVED",
      consultationId: consultation.id,
      consultationStatus: consultation.status,
    });
  }
  return resolution;
};

/** 反映担当Projectのmanagerが文書反映を依頼するために読む、解決済みの相談の結論と、そのProjectが担当する依頼。会話本文は含めない。 */
export type ConsultationHandoffContext = {
  consultation: Consultation;
  resolution: ConsultationResolution;
  followups: ConsultationFollowupView[];
};

/**
 * 文書反映の引継ぎContext（反映担当Projectのmanager）。Workspace相談の結論も、そのWorkspaceに所属するProjectから読める
 * （Workspace Grantは要らず、使わない）。所属しないProject・別scopeの相談はNOT_FOUND、未解決は`CONSULTATION_NOT_RESOLVED`。
 */
export class GetConsultationHandoffContextUseCase {
  constructor(private readonly unitOfWork: ConsultationUnitOfWork) {}

  execute(projectId: string, scope: ConsultationScope, consultationId: string): Promise<ConsultationHandoffContext> {
    return this.unitOfWork.execute(async (store, scopes, links) => {
      await requireScope(scopes, scope);
      await requireFollowupProject(scopes, scope, projectId, consultationId, "read");
      const consultation = await requireConsultation(store, scope, consultationId);
      const resolution = await requireResolved(store, consultation);
      const followups = (await describeFollowups(store, links, consultation.id)).filter((followup) => followup.projectId === projectId);
      return { consultation, resolution, followups };
    });
  }
}

/**
 * 文書反映TaskのTask本文。依頼の項目を決まった見出しへ並べるだけで、内容の要約・分類はしない（Agentが入力で行う）。
 * 文書の本文はRepositoryが正本で、Task本文は反映の依頼として結論ID・目的・決定内容・根拠・検証方法を渡す。
 */
const followupTaskDescription = (
  consultation: Consultation,
  resolution: ConsultationResolution,
  repository: FollowupRepository,
  input: FollowupRequestInput,
) =>
  [
    `## 相談の結論を${followupKindLabels[input.kind]}へ反映する`,
    "",
    `- 相談: ${consultation.id}「${consultation.title}」`,
    `- 結論: ${resolution.id}`,
    `- 反映先: ${followupKindLabels[input.kind]} / Repository ${repository.name}（${repository.url}）`,
    "",
    "## 目的",
    "",
    input.purpose,
    "",
    "## 反映する決定内容",
    "",
    input.decision,
    "",
    "## 根拠",
    "",
    input.rationale,
    "",
    "## 検証方法",
    "",
    input.verification,
    "",
    "## 完了と参照",
    "",
    "- Repositoryの規約に従って文書を変更し、通常のReview・Acceptanceで受け入れる。このTaskは相談を待つ元Taskの受入を待たない。",
    "- 受入後、Managerが`record_consultation_artifact`で受け入れたTaskと文書のpath・commit SHA・PR URLを相談へ登録する。",
  ].join("\n");

/** 同じ反映先への再依頼が、保存済みの依頼と同じ内容か（Task本文を変える項目を比べる）。 */
const sameRequest = (followup: ConsultationFollowup, input: FollowupRequestInput) =>
  followup.title === input.title &&
  followup.purpose === input.purpose &&
  followup.decision === input.decision &&
  followup.rationale === input.rationale &&
  followup.verification === input.verification &&
  followup.resumptionDependency === input.resumptionDependency;

/**
 * 結論からの文書反映の依頼（反映担当Projectのmanager）。解決済みの相談（Project相談はそのProject、Workspace相談は所属Projectのいずれか）の
 * 結論について、反映先Repositoryを明示した通常のWork Taskを同じtransactionで起票し、相談に依頼を記録する。同じ結論・種類・反映先への依頼は`requestId`によらず同じ依頼・Taskを返し
 * （内容が違えば`CONFLICT`）、再送や通信断でTaskを二重に作らない。元Taskの再開は`resumptionDependency`を指定したときだけ待たせる。
 */
export class RequestConsultationFollowupUseCase {
  constructor(
    private readonly unitOfWork: ConsultationUnitOfWork,
    private readonly clock: Clock = Date.now,
    private readonly newId: () => string = randomUUID,
  ) {}

  execute(
    projectId: string,
    scope: ConsultationScope,
    consultationId: string,
    actor: ConsultationActor,
    input: unknown,
  ): Promise<{ followup: ConsultationFollowupView }> {
    const { requestId, ...content } = parseFollowupRequestInput(input);
    return this.unitOfWork.execute((store, scopes, links) =>
      withReceipt(store, actor, "request_consultation_followup", requestId, { ...scope, targetProjectId: projectId, consultationId, ...content }, this.clock, async () => {
        await requireWritableScope(scopes, scope);
        await requireFollowupProject(scopes, scope, projectId, consultationId);
        const consultation = await requireConsultation(store, scope, consultationId);
        const resolution = await requireResolved(store, consultation);
        const repository = await links.findRepository(projectId, content.repositoryId);
        if (!repository) {
          throw new ValidationError("Consultation follow-up input is invalid", [
            { path: "repositoryId", message: `Repository ${content.repositoryId} is not registered in this Project` },
          ]);
        }
        const target = { kind: content.kind, projectId, repositoryId: repository.id };
        const existing = await store.findFollowupByTarget(consultation.id, target);
        if (existing) {
          if (!sameRequest(existing, { requestId, ...content })) {
            throw new ConflictError("A document follow-up for this conclusion, kind and Repository already exists with different content", {
              conflict: "FOLLOWUP_EXISTS",
              consultationId: consultation.id,
              followupId: existing.id,
            });
          }
          return { followup: (await describeFollowups(store, links, consultation.id)).find((view) => view.id === existing.id)! };
        }
        const id = this.newId();
        const task = await links.issueTask(
          actor,
          { projectId, storyId: content.storyId ?? null, title: content.title, description: followupTaskDescription(consultation, resolution, repository, { requestId, ...content }) },
          `consultation-followup:${id}`,
        );
        const now = this.clock();
        const followup: ConsultationFollowup = {
          id,
          consultationId: consultation.id,
          resolutionId: resolution.id,
          ...target,
          taskId: task.id,
          title: content.title,
          purpose: content.purpose,
          decision: content.decision,
          rationale: content.rationale,
          verification: content.verification,
          resumptionDependency: content.resumptionDependency,
          requestedBy: actor,
          createdAt: now,
        };
        await store.insertFollowup(followup);
        await links.recordActivity({
          type: "consultation.followup_requested",
          projectId,
          actor,
          summary: `相談「${consultation.title}」の結論を${followupKindLabels[content.kind]}へ反映するTaskを依頼した`,
          consultationId: consultation.id,
          consultationScope: scope.kind,
          taskId: task.id,
          artifact: null,
          occurredAt: now,
        });
        return { followup: (await describeFollowups(store, links, consultation.id)).find((view) => view.id === id)! };
      }),
    );
  }
}

/** 登録する参照が、文書反映Taskの受入で残した受入成果物（Repository・commit・path・PR）のいずれかと一致するか。 */
const matchesAcceptance = (
  deliverables: { repositoryId: string; commitSha: string; paths: string[]; pullRequestUrl: string | null }[],
  artifact: { repositoryId: string; commitSha: string; path: string; pullRequestUrl: string | null },
) =>
  deliverables.some(
    (deliverable) =>
      deliverable.repositoryId === artifact.repositoryId &&
      deliverable.commitSha === artifact.commitSha &&
      deliverable.paths.includes(artifact.path) &&
      deliverable.pullRequestUrl === artifact.pullRequestUrl,
  );

/**
 * 受入済みの文書反映Taskの成果物参照の登録（反映担当Projectのmanager）。依頼のTask・Repositoryと一致し、Taskが受入済み（`accepted`）で、
 * path・commit SHA・PR URLがそのTaskの受入で残した受入成果物（Workの受入証跡）と一致することを検査してから参照を保存する。
 * 未受入・無関係なTask・別Repository・受入証跡に無いpath / commit / PRの参照では反映済みにしない。
 * 同じ依頼・path・commitの参照は1件で、`requestId`によらず再送は保存済みの参照を返す。本文は複製せず、Activityへも参照だけを残す。
 */
export class RecordConsultationArtifactUseCase {
  constructor(
    private readonly unitOfWork: ConsultationUnitOfWork,
    private readonly clock: Clock = Date.now,
    private readonly newId: () => string = randomUUID,
  ) {}

  execute(
    projectId: string,
    scope: ConsultationScope,
    consultationId: string,
    actor: ConsultationActor,
    input: unknown,
  ): Promise<{ artifact: ConsultationArtifact; followup: ConsultationFollowupView }> {
    const { requestId, ...content } = parseArtifactInput(input);
    return this.unitOfWork.execute((store, scopes, links) =>
      withReceipt(store, actor, "record_consultation_artifact", requestId, { ...scope, targetProjectId: projectId, consultationId, ...content }, this.clock, async () => {
        await requireWritableScope(scopes, scope);
        await requireFollowupProject(scopes, scope, projectId, consultationId);
        const consultation = await requireConsultation(store, scope, consultationId);
        const followup = await store.findFollowup(consultation.id, content.followupId);
        // 別Projectが担当する依頼は、そのProjectのmanagerだけが登録する（存在は区別しない）。
        if (!followup || followup.projectId !== projectId) throw new NotFoundError(`Follow-up ${content.followupId} was not found in this Consultation`);
        const issues: { path: string; message: string }[] = [];
        if (content.taskId !== followup.taskId) issues.push({ path: "taskId", message: "taskId must be the document Task of this follow-up" });
        if (content.repositoryId !== followup.repositoryId) issues.push({ path: "repositoryId", message: "repositoryId must be the Repository of this follow-up" });
        const repository = issues.length ? null : await links.findRepository(followup.projectId, followup.repositoryId);
        if (!issues.length && !repository) issues.push({ path: "repositoryId", message: `Repository ${followup.repositoryId} is no longer registered in this Project` });
        if (issues.length) throw new ValidationError("Consultation artifact input is invalid", issues);
        const task = await links.findTask(followup.projectId, followup.taskId);
        if (!task || task.status !== "accepted") {
          throw new ConflictError("Only an accepted document Task can be recorded as reflected", {
            conflict: "FOLLOWUP_TASK_NOT_ACCEPTED",
            followupId: followup.id,
            taskId: followup.taskId,
            taskStatus: task?.status ?? "missing",
          });
        }
        const deliverables = await links.findAcceptedDeliverables(followup.projectId, followup.taskId);
        if (!matchesAcceptance(deliverables, { repositoryId: followup.repositoryId, commitSha: content.commitSha, path: content.path, pullRequestUrl: content.pullRequestUrl })) {
          throw new ConflictError("The path, commit and pull request are not among the deliverables accepted for the document Task", {
            conflict: "ARTIFACT_NOT_ACCEPTED",
            followupId: followup.id,
            taskId: followup.taskId,
            acceptedDeliverables: String(deliverables.length),
          });
        }
        const view = async () => (await describeFollowups(store, links, consultation.id)).find((item) => item.id === followup.id)!;
        const existing = await store.findArtifact(followup.id, content.path, content.commitSha);
        if (existing) {
          if (existing.pullRequestUrl !== content.pullRequestUrl) {
            throw new ConflictError("This path and commit are already recorded with a different pull request", {
              conflict: "ARTIFACT_EXISTS",
              followupId: followup.id,
              artifactId: existing.id,
            });
          }
          return { artifact: existing, followup: await view() };
        }
        const now = this.clock();
        const artifact: ConsultationArtifact = {
          id: this.newId(),
          followupId: followup.id,
          consultationId: consultation.id,
          taskId: followup.taskId,
          repositoryId: followup.repositoryId,
          path: content.path,
          commitSha: content.commitSha,
          pullRequestUrl: content.pullRequestUrl,
          recordedBy: actor,
          createdAt: now,
        };
        await store.insertArtifact(artifact);
        await links.recordActivity({
          type: "consultation.followup_reflected",
          projectId: followup.projectId,
          actor,
          summary: `相談「${consultation.title}」の結論を${followupKindLabels[followup.kind]}へ反映した（${content.path}）`,
          consultationId: consultation.id,
          consultationScope: scope.kind,
          taskId: followup.taskId,
          artifact: { repositoryId: followup.repositoryId, path: content.path, commitSha: content.commitSha, pullRequestUrl: content.pullRequestUrl },
          occurredAt: now,
        });
        return { artifact, followup: await view() };
      }),
    );
  }
}
