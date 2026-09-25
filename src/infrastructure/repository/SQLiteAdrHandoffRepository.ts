import type { Kysely } from "kysely";
import { sql } from "kysely";
import type {
  AdrHandoffRepository,
  CreateAdrHandoffRequestInput,
  CreateAdrHandoffRequestResult,
  RecordAdrReferenceInput,
  RecordAdrReferenceResult,
} from "../../domain/repository/AdrHandoffRepository.ts";
import type { Database } from "../database/schema.ts";
import {
  buildAdrHandoffPayload,
  findAdrHandoffRequestByKey,
  findAdrHandoffRequestForReference,
  findAdrReferenceByKey,
  findDecisionForHandoff,
  findProjectConstraints,
  findRepositoryForHandoff,
  toReference,
  toRequest,
} from "./adrHandoffRecord.ts";
import { inputHash } from "./inputHash.ts";
import { isProjectArchived } from "./isProjectArchived.ts";

export class SQLiteAdrHandoffRepository implements AdrHandoffRepository {
  constructor(private readonly database: Kysely<Database>) {}

  async createRequest(projectId: string, input: CreateAdrHandoffRequestInput): Promise<CreateAdrHandoffRequestResult> {
    return this.database.transaction().execute(async (transaction): Promise<CreateAdrHandoffRequestResult> => {
      if (await isProjectArchived(transaction, projectId)) return { kind: "project_archived" };

      const hash = inputHash(input);
      const existing = await findAdrHandoffRequestByKey(transaction, projectId, input.requestKey);
      if (existing) {
        if (existing.input_hash !== hash) return { kind: "key_conflict", requestKey: input.requestKey };
        return { kind: "replayed", request: toRequest(existing) };
      }

      const decision = await findDecisionForHandoff(transaction, projectId, input.decisionId);
      if (!decision) return { kind: "decision_not_found" };
      if (decision.type !== "adr_candidate") return { kind: "decision_not_adr_candidate", type: decision.type };

      const repository = await findRepositoryForHandoff(transaction, projectId, input.repositoryId);
      if (!repository) return { kind: "repository_not_found", repositoryId: input.repositoryId };

      const constraints = await findProjectConstraints(transaction, projectId);
      const payload = await buildAdrHandoffPayload(transaction, decision, repository, constraints);

      const row = await transaction
        .insertInto("adr_handoff_request")
        .values({
          id: crypto.randomUUID(),
          project_id: projectId,
          decision_id: input.decisionId,
          repository_id: input.repositoryId,
          correlation_id: input.correlationId,
          request_key: input.requestKey,
          input_hash: hash,
          payload: JSON.stringify(payload),
          principal_id: input.principalId,
          created_at: Date.now(),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return { kind: "created", request: toRequest(row) };
    });
  }

  async recordReference(projectId: string, input: RecordAdrReferenceInput): Promise<RecordAdrReferenceResult> {
    return this.database.transaction().execute(async (transaction): Promise<RecordAdrReferenceResult> => {
      if (await isProjectArchived(transaction, projectId)) return { kind: "project_archived" };

      const hash = inputHash(input);
      const existing = await findAdrReferenceByKey(transaction, projectId, input.requestKey);
      if (existing) {
        if (existing.input_hash !== hash) return { kind: "key_conflict", requestKey: input.requestKey };
        return { kind: "replayed", reference: toReference(existing) };
      }

      const decision = await findDecisionForHandoff(transaction, projectId, input.decisionId);
      if (!decision) return { kind: "decision_not_found" };
      if (decision.type !== "adr_candidate") return { kind: "decision_not_adr_candidate", type: decision.type };

      const repository = await findRepositoryForHandoff(transaction, projectId, input.repositoryId);
      if (!repository) return { kind: "repository_not_found", repositoryId: input.repositoryId };

      const handoffRequest = await findAdrHandoffRequestForReference(
        transaction,
        input.decisionId,
        input.repositoryId,
        input.correlationId,
      );
      if (!handoffRequest) return { kind: "handoff_request_not_found" };

      const row = await transaction
        .insertInto("adr_reference")
        .values({
          id: crypto.randomUUID(),
          project_id: projectId,
          decision_id: input.decisionId,
          repository_id: input.repositoryId,
          path: input.path,
          commit_sha: input.commitSha,
          pull_request_url: input.pullRequestUrl,
          correlation_id: input.correlationId,
          request_key: input.requestKey,
          input_hash: hash,
          principal_id: input.principalId,
          created_at: Date.now(),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return { kind: "created", reference: toReference(row) };
    });
  }

  async findReferencesByProject(projectId: string) {
    const rows = await this.database
      .selectFrom("adr_reference")
      .selectAll()
      .where("project_id", "=", projectId)
      .orderBy("created_at", "desc")
      .orderBy(sql`rowid`, "desc")
      .execute();
    return rows.map(toReference);
  }
}
