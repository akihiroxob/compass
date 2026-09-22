import type { Kysely } from "kysely";
import { sql } from "kysely";
import type {
  CreateDirectionDecisionResult,
  DecideNextOutcomeResult,
  DirectionDecisionRepository,
} from "../../domain/repository/DirectionDecisionRepository.ts";
import type { IntentResearchSummary } from "../../domain/model/Research.ts";
import type { CreateDirectionDecisionInput, DecideNextOutcomeInput } from "../../shared/directionDecisionSchema.ts";
import type { Database } from "../database/schema.ts";
import {
  findDecisionByRequestKey,
  insertDirectionDecisionRow,
  loadDecisions,
  validateResearchReferences,
} from "./directionDecisionRecord.ts";
import { inputHash } from "./inputHash.ts";
import { isProjectArchived } from "./isProjectArchived.ts";
import { insertOutcomeRow, loadOutcomes } from "./outcomeRecord.ts";

export class SQLiteDirectionDecisionRepository implements DirectionDecisionRepository {
  constructor(private readonly database: Kysely<Database>) {}

  async create(
    projectId: string,
    intentBriefSnapshot: IntentResearchSummary,
    input: CreateDirectionDecisionInput & { principalId: string },
  ): Promise<CreateDirectionDecisionResult> {
    return this.database.transaction().execute(async (transaction): Promise<CreateDirectionDecisionResult> => {
      if (await isProjectArchived(transaction, projectId)) return { kind: "project_archived" };

      const hash = inputHash(input);
      const existing = await findDecisionByRequestKey(transaction, projectId, input.requestKey);
      if (existing) {
        if (existing.input_hash !== hash) return { kind: "key_conflict", requestKey: input.requestKey };
        const [decision] = await loadDecisions(transaction, [existing]);
        return { kind: "replayed", decision: decision! };
      }

      const intent = await transaction
        .selectFrom("intent")
        .select("status")
        .where("id", "=", input.intentId)
        .where("project_id", "=", projectId)
        .executeTakeFirst();
      if (!intent) return { kind: "intent_not_found" };
      if (intent.status !== "active") return { kind: "intent_not_active", status: intent.status };

      const referenceCheck = await validateResearchReferences(
        transaction,
        projectId,
        input.usedSyntheses,
        input.usedFindingIds,
      );
      if (referenceCheck.kind !== "ok") return referenceCheck;

      const decision = await insertDirectionDecisionRow(
        transaction,
        projectId,
        crypto.randomUUID(),
        input.type,
        null,
        intentBriefSnapshot,
        input,
        hash,
        Date.now(),
      );
      return { kind: "created", decision };
    });
  }

  async decideNextOutcome(
    projectId: string,
    intentBriefSnapshot: IntentResearchSummary,
    input: DecideNextOutcomeInput & { principalId: string },
  ): Promise<DecideNextOutcomeResult> {
    return this.database.transaction().execute(async (transaction): Promise<DecideNextOutcomeResult> => {
      if (await isProjectArchived(transaction, projectId)) return { kind: "project_archived" };

      const hash = inputHash(input);
      const existing = await findDecisionByRequestKey(transaction, projectId, input.requestKey);
      if (existing) {
        if (existing.input_hash !== hash) return { kind: "key_conflict", requestKey: input.requestKey };
        const [decision] = await loadDecisions(transaction, [existing]);
        const outcomeRow = await transaction
          .selectFrom("outcome")
          .selectAll()
          .where("id", "=", existing.outcome_id!)
          .executeTakeFirstOrThrow();
        const [outcome] = await loadOutcomes(transaction, [outcomeRow]);
        return { kind: "replayed", decision: decision!, outcome: outcome! };
      }

      const intent = await transaction
        .selectFrom("intent")
        .select("status")
        .where("id", "=", input.intentId)
        .where("project_id", "=", projectId)
        .executeTakeFirst();
      if (!intent) return { kind: "intent_not_found" };
      if (intent.status !== "active") return { kind: "intent_not_active", status: intent.status };

      const referenceCheck = await validateResearchReferences(
        transaction,
        projectId,
        input.usedSyntheses,
        input.usedFindingIds,
      );
      if (referenceCheck.kind !== "ok") return referenceCheck;

      const now = Date.now();
      const outcomeId = crypto.randomUUID();
      const decisionId = crypto.randomUUID();
      // Outcomeを先に作る（direction_decision.outcome_idがoutcome.idを参照するFKの前提）。
      const outcome = await insertOutcomeRow(transaction, projectId, input.intentId, outcomeId, decisionId, input.outcome, now);
      const decision = await insertDirectionDecisionRow(
        transaction,
        projectId,
        decisionId,
        "next_outcome",
        outcomeId,
        intentBriefSnapshot,
        input,
        hash,
        now,
      );
      return { kind: "created", decision, outcome };
    });
  }

  async findByIntent(projectId: string, intentId: string) {
    const rows = await this.database
      .selectFrom("direction_decision")
      .selectAll()
      .where("project_id", "=", projectId)
      .where("intent_id", "=", intentId)
      .orderBy("created_at", "desc")
      .orderBy(sql`rowid`, "desc")
      .execute();
    return loadDecisions(this.database, rows);
  }
}
