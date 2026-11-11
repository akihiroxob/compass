import type { D1Database } from "@cloudflare/workers-types";
import { sql, type Kysely, type Selectable } from "kysely";
import { ConflictError, inputHash } from "@compass/shared";
import { buildAdrHandoffPayload, findDecisionForHandoff, adrHandoffRequestFromRow, adrReferenceFromRow,
  type DirectionDatabase, type AdrHandoffRepository, type AdrHandoffRequestTable, type AdrReferenceTable,
  type CreateAdrHandoffRequestInput, type CreateAdrHandoffRequestResult, type RecordAdrReferenceInput, type RecordAdrReferenceResult } from "@compass/direction";
import { asOrganizationDatabase } from "../../database/contextDatabase.ts";
import { D1AtomicBatch, D1PreconditionFailedError } from "../../database/d1/D1AtomicBatch.ts";

export class D1AdrHandoffRepository implements AdrHandoffRepository {
  private readonly atomic: D1AtomicBatch;
  constructor(private readonly database: Kysely<DirectionDatabase>, binding: D1Database, private readonly clock: () => number = Date.now) {
    this.atomic = new D1AtomicBatch(binding);
  }

  async createRequest(workspaceId: string, input: CreateAdrHandoffRequestInput): Promise<CreateAdrHandoffRequestResult> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const state = await this.state(workspaceId, input.projectId);
      if (state.kind !== "ready") return state;
      const sameKey = this.database.selectFrom("adr_handoff_request").selectAll().where("workspace_id", "=", workspaceId).where("request_key", "=", input.requestKey);
      const existing = await sameKey.executeTakeFirst();
      if (existing) return existing.input_hash === inputHash(input) ? { kind: "replayed", request: adrHandoffRequestFromRow(existing) } : { kind: "key_conflict", requestKey: input.requestKey };
      const decision = await findDecisionForHandoff(this.database, workspaceId, input.decisionId);
      if (!decision) return { kind: "decision_not_found" };
      if (decision.type !== "adr_candidate") return { kind: "decision_not_adr_candidate", type: decision.type };
      const repositoryQuery = this.repository(input.projectId, input.repositoryId);
      const repository = await repositoryQuery.executeTakeFirst();
      if (!repository) return { kind: "repository_not_found", repositoryId: input.repositoryId };
      const constraints = await asOrganizationDatabase(this.database).selectFrom("workspace_constraint").select("value").where("workspace_id", "=", workspaceId).orderBy("sort_order").execute();
      const payload = await buildAdrHandoffPayload(this.database, decision, repository, constraints.map(({ value }) => value), workspaceId, input.projectId);
      const row: Selectable<AdrHandoffRequestTable> = { id: crypto.randomUUID(), workspace_id: workspaceId, project_id: input.projectId,
        decision_id: input.decisionId, repository_id: input.repositoryId, correlation_id: input.correlationId, request_key: input.requestKey,
        input_hash: inputHash(input), payload: JSON.stringify(payload), principal_id: input.principalId, created_at: this.clock() };
      try {
        await this.atomic.execute([state.guard, sql`SELECT 1 WHERE NOT EXISTS ${sameKey}`.compile(this.database), this.decision(workspaceId, input.decisionId).compile(),
          repositoryQuery.where("name", "=", repository.name).where("url", "=", repository.url).compile()], [this.database.insertInto("adr_handoff_request").values(row).compile()]);
        return { kind: "created", request: adrHandoffRequestFromRow(row) };
      } catch (error) { if (!(error instanceof D1PreconditionFailedError)) throw error; }
    }
    throw new ConflictError("ADR handoff configuration changed repeatedly", { projectId: input.projectId, requestKey: input.requestKey });
  }

  async recordReference(workspaceId: string, input: RecordAdrReferenceInput): Promise<RecordAdrReferenceResult> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const state = await this.state(workspaceId, input.projectId);
      if (state.kind !== "ready") return state;
      const sameKey = this.database.selectFrom("adr_reference").selectAll().where("workspace_id", "=", workspaceId).where("request_key", "=", input.requestKey);
      const existing = await sameKey.executeTakeFirst();
      if (existing) return existing.input_hash === inputHash(input) ? { kind: "replayed", reference: adrReferenceFromRow(existing) } : { kind: "key_conflict", requestKey: input.requestKey };
      const decision = await findDecisionForHandoff(this.database, workspaceId, input.decisionId);
      if (!decision) return { kind: "decision_not_found" };
      if (decision.type !== "adr_candidate") return { kind: "decision_not_adr_candidate", type: decision.type };
      const repository = this.repository(input.projectId, input.repositoryId);
      if (!await repository.executeTakeFirst()) return { kind: "repository_not_found", repositoryId: input.repositoryId };
      const handoff = this.database.selectFrom("adr_handoff_request").select("id").where("workspace_id", "=", workspaceId).where("project_id", "=", input.projectId)
        .where("decision_id", "=", input.decisionId).where("repository_id", "=", input.repositoryId).where("correlation_id", "=", input.correlationId);
      if (!await handoff.executeTakeFirst()) return { kind: "handoff_request_not_found" };
      const row: Selectable<AdrReferenceTable> = { id: crypto.randomUUID(), workspace_id: workspaceId, project_id: input.projectId, decision_id: input.decisionId,
        repository_id: input.repositoryId, path: input.path, commit_sha: input.commitSha, pull_request_url: input.pullRequestUrl,
        correlation_id: input.correlationId, request_key: input.requestKey, input_hash: inputHash(input), principal_id: input.principalId, created_at: this.clock() };
      try {
        await this.atomic.execute([state.guard, sql`SELECT 1 WHERE NOT EXISTS ${sameKey}`.compile(this.database), this.decision(workspaceId, input.decisionId).compile(),
          repository.compile(), handoff.compile()], [this.database.insertInto("adr_reference").values(row).compile()]);
        return { kind: "created", reference: adrReferenceFromRow(row) };
      } catch (error) { if (!(error instanceof D1PreconditionFailedError)) throw error; }
    }
    throw new ConflictError("ADR reference changed repeatedly", { projectId: input.projectId, requestKey: input.requestKey });
  }

  async findReferencesByWorkspace(workspaceId: string) {
    return (await this.database.selectFrom("adr_reference").selectAll().where("workspace_id", "=", workspaceId).orderBy("created_at", "desc").orderBy(sql`rowid`, "desc").execute()).map(adrReferenceFromRow);
  }
  private repository(projectId: string, repositoryId: string) { return asOrganizationDatabase(this.database).selectFrom("project_repository_link").select(["id", "name", "url"]).where("project_id", "=", projectId).where("id", "=", repositoryId); }
  private decision(workspaceId: string, id: string) { return this.database.selectFrom("direction_decision").select("id").where("workspace_id", "=", workspaceId).where("id", "=", id).where("type", "=", "adr_candidate"); }
  private async state(workspaceId: string, projectId: string) {
    const query = asOrganizationDatabase(this.database).selectFrom("project").innerJoin("workspace", "workspace.id", "project.workspace_id")
      .select(["project.id", "project.status", "project.updated_at", "workspace.status as workspace_status", "workspace.updated_at as workspace_updated_at"])
      .where("project.id", "=", projectId).where("project.workspace_id", "=", workspaceId);
    const row = await query.executeTakeFirst();
    if (!row) return { kind: "project_not_in_workspace" as const };
    if (row.workspace_status === "archived") return { kind: "workspace_archived" as const };
    if (row.status === "archived") return { kind: "project_archived" as const };
    return { kind: "ready" as const, guard: query.where("project.status", "=", "active").where("workspace.status", "=", "active")
      .where("project.updated_at", "=", row.updated_at).where("workspace.updated_at", "=", row.workspace_updated_at).compile() };
  }
}
