import type { Kysely, Selectable } from "kysely";
import type {
  Consultation,
  ConsultationActor,
  ConsultationArtifact,
  ConsultationFollowup,
  ConsultationHandoff,
  ConsultationActorKind,
  ConsultationLease,
  ConsultationMessage,
  ConsultationOption,
  ConsultationReference,
  ConsultationResolution,
  ConsultationScope,
  ConsultationScopeKind,
  ConsultationStatus,
  FollowupKind,
  ResolutionSource,
} from "../domain/Consultation.ts";
import type { AccessibleConsultationQuery, ConsultationStore } from "../application/port/ConsultationStore.ts";
import type {
  CollaborationDatabase,
  ConsultationArtifactTable,
  ConsultationFollowupTable,
  ConsultationHandoffTable,
  ConsultationLeaseTable,
  ConsultationMessageTable,
  ConsultationResolutionTable,
  ConsultationTable,
} from "./schema.ts";

const actor = (kind: string, principalId: string, role: string): ConsultationActor => ({
  kind: kind as ConsultationActorKind,
  principalId,
  role,
});

const toConsultation = (row: Selectable<ConsultationTable>): Consultation => ({
  id: row.id,
  scope: row.scope as ConsultationScopeKind,
  workspaceId: row.workspace_id,
  projectId: row.project_id,
  title: row.title,
  question: row.question,
  blockingReason: row.blocking_reason,
  options: JSON.parse(row.options) as ConsultationOption[],
  recommendation: row.recommendation,
  impact: row.impact,
  refs: JSON.parse(row.refs) as ConsultationReference[],
  status: row.status as ConsultationStatus,
  revision: row.revision,
  supersedesConsultationId: row.supersedes_consultation_id,
  createdBy: actor(row.created_by_kind, row.created_by_principal_id, row.created_by_role),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  cancellation:
    row.cancel_reason !== null && row.canceled_by_kind !== null && row.canceled_by_principal_id !== null && row.canceled_at !== null
      ? { reason: row.cancel_reason, by: actor(row.canceled_by_kind, row.canceled_by_principal_id, row.canceled_by_role ?? ""), at: row.canceled_at }
      : null,
});

const toMessage = (row: Selectable<ConsultationMessageTable>): ConsultationMessage => ({
  id: row.id,
  consultationId: row.consultation_id,
  sequence: row.sequence,
  author: actor(row.author_kind, row.principal_id, row.role),
  body: row.body,
  correctsMessageId: row.corrects_message_id,
  revision: row.revision,
  createdAt: row.created_at,
});

const toResolution = (row: Selectable<ConsultationResolutionTable>): ConsultationResolution => ({
  id: row.id,
  consultationId: row.consultation_id,
  source: row.source as ResolutionSource,
  conclusion: row.conclusion,
  rationale: row.rationale,
  applicability: row.applicability,
  selectedOption: row.selected_option,
  basisMessageIds: JSON.parse(row.basis_message_ids) as string[],
  basisRevision: row.basis_revision,
  recordedBy: actor(row.recorded_by_kind, row.recorded_by_principal_id, row.recorded_by_role),
  createdAt: row.created_at,
});

const toLease = (row: Selectable<ConsultationLeaseTable>): ConsultationLease => ({
  id: row.id,
  consultationId: row.consultation_id,
  inputRevision: row.input_revision,
  principalId: row.principal_id,
  role: row.role,
  acquiredAt: row.acquired_at,
  expiresAt: row.expires_at,
  releasedAt: row.released_at,
});

const toFollowup = (row: Selectable<ConsultationFollowupTable>): ConsultationFollowup => ({
  id: row.id,
  consultationId: row.consultation_id,
  resolutionId: row.resolution_id,
  kind: row.kind as FollowupKind,
  projectId: row.project_id,
  repositoryId: row.repository_id,
  taskId: row.task_id,
  title: row.title,
  purpose: row.purpose,
  decision: row.decision,
  rationale: row.rationale,
  verification: row.verification,
  resumptionDependency: row.resumption_dependency,
  requestedBy: actor("agent", row.requested_by_principal_id, row.requested_by_role),
  createdAt: row.created_at,
});

const toHandoff = (row: Selectable<ConsultationHandoffTable>): ConsultationHandoff => ({
  consultationId: row.consultation_id,
  projectId: row.project_id,
  handedOffBy: actor("agent", row.handed_off_by_principal_id, row.handed_off_by_role),
  createdAt: row.created_at,
});

const toArtifact = (row: Selectable<ConsultationArtifactTable>): ConsultationArtifact => ({
  id: row.id,
  followupId: row.followup_id,
  consultationId: row.consultation_id,
  taskId: row.task_id,
  repositoryId: row.repository_id,
  path: row.path,
  commitSha: row.commit_sha,
  pullRequestUrl: row.pull_request_url,
  recordedBy: actor("agent", row.recorded_by_principal_id, row.recorded_by_role),
  createdAt: row.created_at,
});

/** `ConsultationStore`のKysely（SQLite）実装。transactionを受け取れば、その中で読み書きする。 */
export class KyselyConsultationStore implements ConsultationStore {
  constructor(private readonly db: Kysely<CollaborationDatabase>) {}

  async insertConsultation(consultation: Consultation) {
    await this.db
      .insertInto("consultation")
      .values({
        id: consultation.id,
        scope: consultation.scope,
        workspace_id: consultation.workspaceId,
        project_id: consultation.projectId,
        title: consultation.title,
        question: consultation.question,
        blocking_reason: consultation.blockingReason,
        options: JSON.stringify(consultation.options),
        recommendation: consultation.recommendation,
        impact: consultation.impact,
        refs: JSON.stringify(consultation.refs),
        status: consultation.status,
        revision: consultation.revision,
        supersedes_consultation_id: consultation.supersedesConsultationId,
        created_by_kind: consultation.createdBy.kind,
        created_by_principal_id: consultation.createdBy.principalId,
        created_by_role: consultation.createdBy.role,
        created_at: consultation.createdAt,
        updated_at: consultation.updatedAt,
        cancel_reason: null,
        canceled_by_kind: null,
        canceled_by_principal_id: null,
        canceled_by_role: null,
        canceled_at: null,
      })
      .execute();
  }

  async updateConsultation(consultation: Consultation) {
    const { cancellation } = consultation;
    await this.db
      .updateTable("consultation")
      .set({
        status: consultation.status,
        revision: consultation.revision,
        updated_at: consultation.updatedAt,
        cancel_reason: cancellation?.reason ?? null,
        canceled_by_kind: cancellation?.by.kind ?? null,
        canceled_by_principal_id: cancellation?.by.principalId ?? null,
        canceled_by_role: cancellation?.by.role ?? null,
        canceled_at: cancellation?.at ?? null,
      })
      .where("id", "=", consultation.id)
      .execute();
  }

  /** scopeの相談だけを選ぶ。Workspace scopeはProject scopeの相談（同じWorkspaceに属するもの）を含めない。 */
  private selectInScope(scope: ConsultationScope) {
    const select = this.db.selectFrom("consultation").selectAll();
    return scope.kind === "project"
      ? select.where("scope", "=", "project").where("project_id", "=", scope.projectId)
      : select.where("scope", "=", "workspace").where("workspace_id", "=", scope.workspaceId);
  }

  async findConsultation(scope: ConsultationScope, consultationId: string) {
    const row = await this.selectInScope(scope).where("id", "=", consultationId).executeTakeFirst();
    return row ? toConsultation(row) : null;
  }

  async listConsultations(scope: ConsultationScope, query: { status?: ConsultationStatus }) {
    let select = this.selectInScope(scope);
    if (query.status !== undefined) select = select.where("status", "=", query.status);
    const rows = await select.orderBy("updated_at", "desc").orderBy("id").execute();
    return rows.map(toConsultation);
  }

  async listAccessibleConsultations(query: AccessibleConsultationQuery) {
    const { projectIds, workspaceIds, after } = query;
    let select = this.db
      .selectFrom("consultation")
      .selectAll()
      .where(({ and, or, eb }) =>
        or([
          ...(projectIds.length ? [and([eb("scope", "=", "project"), eb("project_id", "in", [...projectIds])])] : []),
          ...(workspaceIds.length ? [and([eb("scope", "=", "workspace"), eb("workspace_id", "in", [...workspaceIds])])] : []),
        ]),
      );
    if (query.status !== undefined) select = select.where("status", "=", query.status);
    if (query.workspaceId !== undefined) select = select.where("workspace_id", "=", query.workspaceId);
    if (query.projectId !== undefined) select = select.where("project_id", "=", query.projectId);
    if (after !== undefined) {
      select = select.where(({ or, and, eb }) =>
        or([eb("updated_at", "<", after.updatedAt), and([eb("updated_at", "=", after.updatedAt), eb("id", ">", after.id)])]),
      );
    }
    const rows = await select.orderBy("updated_at", "desc").orderBy("id").limit(query.limit).execute();
    return rows.map(toConsultation);
  }

  async appendMessage(message: ConsultationMessage) {
    await this.db
      .insertInto("consultation_message")
      .values({
        id: message.id,
        consultation_id: message.consultationId,
        sequence: message.sequence,
        author_kind: message.author.kind,
        principal_id: message.author.principalId,
        role: message.author.role,
        body: message.body,
        corrects_message_id: message.correctsMessageId,
        revision: message.revision,
        created_at: message.createdAt,
      })
      .execute();
  }

  async listMessages(consultationId: string) {
    const rows = await this.db
      .selectFrom("consultation_message")
      .selectAll()
      .where("consultation_id", "=", consultationId)
      .orderBy("sequence")
      .execute();
    return rows.map(toMessage);
  }

  async insertResolution(resolution: ConsultationResolution) {
    await this.db
      .insertInto("consultation_resolution")
      .values({
        id: resolution.id,
        consultation_id: resolution.consultationId,
        source: resolution.source,
        conclusion: resolution.conclusion,
        rationale: resolution.rationale,
        applicability: resolution.applicability,
        selected_option: resolution.selectedOption,
        basis_message_ids: JSON.stringify(resolution.basisMessageIds),
        basis_revision: resolution.basisRevision,
        recorded_by_kind: resolution.recordedBy.kind,
        recorded_by_principal_id: resolution.recordedBy.principalId,
        recorded_by_role: resolution.recordedBy.role,
        created_at: resolution.createdAt,
      })
      .execute();
  }

  async findResolution(consultationId: string) {
    const row = await this.db
      .selectFrom("consultation_resolution")
      .selectAll()
      .where("consultation_id", "=", consultationId)
      .executeTakeFirst();
    return row ? toResolution(row) : null;
  }

  async insertLease(lease: ConsultationLease) {
    await this.db
      .insertInto("consultation_lease")
      .values({
        id: lease.id,
        consultation_id: lease.consultationId,
        input_revision: lease.inputRevision,
        principal_id: lease.principalId,
        role: lease.role,
        acquired_at: lease.acquiredAt,
        expires_at: lease.expiresAt,
        released_at: lease.releasedAt,
      })
      .execute();
  }

  async findLease(consultationId: string, leaseId: string) {
    const row = await this.db
      .selectFrom("consultation_lease")
      .selectAll()
      .where("id", "=", leaseId)
      .where("consultation_id", "=", consultationId)
      .executeTakeFirst();
    return row ? toLease(row) : null;
  }

  async findActiveLease(consultationId: string, revision: number, now: number) {
    const row = await this.db
      .selectFrom("consultation_lease")
      .selectAll()
      .where("consultation_id", "=", consultationId)
      .where("input_revision", "=", revision)
      .where("released_at", "is", null)
      .where("expires_at", ">", now)
      .orderBy("acquired_at", "desc")
      .executeTakeFirst();
    return row ? toLease(row) : null;
  }

  async extendLease(leaseId: string, expiresAt: number) {
    await this.db.updateTable("consultation_lease").set({ expires_at: expiresAt }).where("id", "=", leaseId).execute();
  }

  async releaseLeases(consultationId: string, releasedAt: number) {
    await this.db
      .updateTable("consultation_lease")
      .set({ released_at: releasedAt })
      .where("consultation_id", "=", consultationId)
      .where("released_at", "is", null)
      .execute();
  }

  async findReceipt(principalId: string, operation: string, requestId: string) {
    const row = await this.db
      .selectFrom("consultation_command_receipt")
      .select(["input_hash", "result_json"])
      .where("principal_id", "=", principalId)
      .where("operation", "=", operation)
      .where("request_id", "=", requestId)
      .executeTakeFirst();
    return row ? { inputHash: row.input_hash, result: JSON.parse(row.result_json) as unknown } : null;
  }

  async insertReceipt(receipt: { principalId: string; operation: string; requestId: string; inputHash: string; result: unknown; createdAt: number }) {
    await this.db
      .insertInto("consultation_command_receipt")
      .values({
        principal_id: receipt.principalId,
        operation: receipt.operation,
        request_id: receipt.requestId,
        input_hash: receipt.inputHash,
        result_json: JSON.stringify(receipt.result),
        created_at: receipt.createdAt,
      })
      .execute();
  }

  async insertHandoff(handoff: ConsultationHandoff) {
    await this.db
      .insertInto("consultation_handoff")
      .values({
        consultation_id: handoff.consultationId,
        project_id: handoff.projectId,
        handed_off_by_principal_id: handoff.handedOffBy.principalId,
        handed_off_by_role: handoff.handedOffBy.role,
        created_at: handoff.createdAt,
      })
      .execute();
  }

  async findHandoff(consultationId: string, projectId: string) {
    const row = await this.db
      .selectFrom("consultation_handoff")
      .selectAll()
      .where("consultation_id", "=", consultationId)
      .where("project_id", "=", projectId)
      .executeTakeFirst();
    return row ? toHandoff(row) : null;
  }

  async insertFollowup(followup: ConsultationFollowup) {
    await this.db
      .insertInto("consultation_followup")
      .values({
        id: followup.id,
        consultation_id: followup.consultationId,
        resolution_id: followup.resolutionId,
        kind: followup.kind,
        project_id: followup.projectId,
        repository_id: followup.repositoryId,
        task_id: followup.taskId,
        title: followup.title,
        purpose: followup.purpose,
        decision: followup.decision,
        rationale: followup.rationale,
        verification: followup.verification,
        resumption_dependency: followup.resumptionDependency,
        requested_by_principal_id: followup.requestedBy.principalId,
        requested_by_role: followup.requestedBy.role,
        created_at: followup.createdAt,
      })
      .execute();
  }

  async findFollowupByTarget(consultationId: string, target: Pick<ConsultationFollowup, "kind" | "projectId" | "repositoryId">) {
    const row = await this.db
      .selectFrom("consultation_followup")
      .selectAll()
      .where("consultation_id", "=", consultationId)
      .where("kind", "=", target.kind)
      .where("project_id", "=", target.projectId)
      .where("repository_id", "=", target.repositoryId)
      .executeTakeFirst();
    return row ? toFollowup(row) : null;
  }

  async findFollowup(consultationId: string, followupId: string) {
    const row = await this.db
      .selectFrom("consultation_followup")
      .selectAll()
      .where("id", "=", followupId)
      .where("consultation_id", "=", consultationId)
      .executeTakeFirst();
    return row ? toFollowup(row) : null;
  }

  async listFollowups(consultationId: string) {
    const rows = await this.db
      .selectFrom("consultation_followup")
      .selectAll()
      .where("consultation_id", "=", consultationId)
      .orderBy("created_at")
      .orderBy("id")
      .execute();
    return rows.map(toFollowup);
  }

  async insertArtifact(artifact: ConsultationArtifact) {
    await this.db
      .insertInto("consultation_artifact")
      .values({
        id: artifact.id,
        followup_id: artifact.followupId,
        consultation_id: artifact.consultationId,
        task_id: artifact.taskId,
        repository_id: artifact.repositoryId,
        path: artifact.path,
        commit_sha: artifact.commitSha,
        pull_request_url: artifact.pullRequestUrl,
        recorded_by_principal_id: artifact.recordedBy.principalId,
        recorded_by_role: artifact.recordedBy.role,
        created_at: artifact.createdAt,
      })
      .execute();
  }

  async findArtifact(followupId: string, path: string, commitSha: string) {
    const row = await this.db
      .selectFrom("consultation_artifact")
      .selectAll()
      .where("followup_id", "=", followupId)
      .where("path", "=", path)
      .where("commit_sha", "=", commitSha)
      .executeTakeFirst();
    return row ? toArtifact(row) : null;
  }

  async listArtifacts(consultationId: string) {
    const rows = await this.db
      .selectFrom("consultation_artifact")
      .selectAll()
      .where("consultation_id", "=", consultationId)
      .orderBy("created_at")
      .orderBy("id")
      .execute();
    return rows.map(toArtifact);
  }
}
