import type { Kysely, Transaction } from "kysely";
import { sql } from "kysely";
import type {
  CreateDirectionDecisionResult,
  DecideNextOutcomeResult,
  DirectionDecisionRepository,
} from "../domain/DirectionDecisionRepository.ts";
import { additionalResearchCorrelationId, additionalResearchRequestKey } from "../domain/AdditionalResearchRequest.ts";
import type { DirectionDecision } from "../domain/DirectionDecision.ts";
import type { IntentResearchSummary } from "../domain/Research.ts";
import type { CreateDirectionDecisionInput, DecideNextOutcomeInput } from "../domain/DirectionDecisionRepository.ts";
import type { DirectionDatabase } from "./schema.ts";
import {
  findDecisionByRequestKey,
  insertDirectionDecisionRow,
  loadDecisions,
  validateEvaluationReference,
  validateResearchReferences,
} from "./directionDecisionRecord.ts";
import { inputHash } from "@compass/shared";
import type { DirectionProjectReaders } from "./directionProjectReaders.ts";
import type { DirectionWorkspaceReaders } from "./directionWorkspaceReaders.ts";
import { notifyDirectionChange, type DirectionChangeObserver } from "./directionChange.ts";
import { insertOutcomeRow, loadOutcomes } from "./outcomeRecord.ts";
import { findResearchRequestByKey, insertResearchRequest, toRequest } from "./researchRequestRecord.ts";

export class SQLiteDirectionDecisionRepository implements DirectionDecisionRepository {
  /** `clock`は追加Researchの期限判定の時刻源。テストで固定できるよう注入する。 */
  constructor(
    private readonly database: Kysely<DirectionDatabase>,
    private readonly projects: DirectionProjectReaders,
    private readonly workspaces: DirectionWorkspaceReaders,
    private readonly clock: () => number = Date.now,
    private readonly changeObserver: DirectionChangeObserver | null = null,
  ) {}

  async create(
    projectId: string,
    intentBriefSnapshot: IntentResearchSummary,
    input: CreateDirectionDecisionInput & { principalId: string },
  ): Promise<CreateDirectionDecisionResult> {
    return this.database.transaction().execute(async (transaction): Promise<CreateDirectionDecisionResult> => {
      if (await this.projects(transaction).isArchived(projectId)) return { kind: "project_archived" };
      const workspaceId = await this.projects(transaction).findDirectionWorkspaceId(projectId);
      // Intentを直接変更する経路も、canonical Intent Repositoryと同じWorkspace制約を守る。
      if (input.type === "intent_complete" && await this.workspaces(transaction).isArchived(workspaceId)) {
        return { kind: "workspace_archived", workspaceId };
      }

      const hash = inputHash(input);
      const existing = await findDecisionByRequestKey(transaction, projectId, input.requestKey);
      if (existing) {
        if (existing.input_hash !== hash) return { kind: "key_conflict", requestKey: input.requestKey };
        const [decision] = await loadDecisions(transaction, [existing]);
        const request = await findResearchRequestByKey(transaction, projectId, additionalResearchRequestKey(existing.id));
        return { kind: "replayed", decision: decision!, researchRequest: request ? toRequest(request) : null };
      }

      // 再送の判定より後に置く。期限後に同じ入力を再送しても、作成済みのDecisionとRequestを返せるようにする。
      const now = this.clock();
      if (input.research && input.research.deadlineAt !== null && input.research.deadlineAt <= now) {
        return { kind: "deadline_in_past", deadlineAt: input.research.deadlineAt };
      }

      const intent = await transaction
        .selectFrom("intent")
        .select(["status", "completion_definition"])
        .where("id", "=", input.intentId)
        .where("workspace_id", "=", workspaceId)
        .executeTakeFirst();
      if (!intent) return { kind: "intent_not_found" };
      if (intent.status !== "active") return { kind: "intent_not_active", status: intent.status };
      // 完了定義の無いIntentは、Outcomeの達成を完了と照合できない。完了定義はHumanがupdate_intent等で与える。
      if (input.type === "intent_complete" && intent.completion_definition === null) {
        return { kind: "no_completion_definition" };
      }

      const referenceCheck = await validateResearchReferences(
        transaction,
        projectId,
        input.usedSyntheses,
        input.usedFindingIds,
      );
      if (referenceCheck.kind !== "ok") return referenceCheck;
      if (input.evaluationId !== undefined) {
        const evaluationCheck = await validateEvaluationReference(
          transaction,
          projectId,
          input.intentId,
          input.evaluationId,
          input.type,
        );
        if (evaluationCheck.kind !== "ok") return evaluationCheck;
      }

      const decisionId = crypto.randomUUID();
      const decision = await insertDirectionDecisionRow(
        transaction,
        projectId,
        decisionId,
        input.type,
        null,
        intentBriefSnapshot,
        input,
        hash,
        now,
      );
      await this.notifyRecorded(transaction, decision);
      if (input.type === "intent_complete") {
        // Intentの達成はStrategistの根拠付き判断でだけ確定する。Outcomeの状態・Executionは変更しない。
        await transaction
          .updateTable("intent")
          .set({ status: "achieved", updated_at: now })
          .where("id", "=", input.intentId)
          .where("workspace_id", "=", workspaceId)
          .execute();
      }
      if (!input.research) return { kind: "created", decision, researchRequest: null };

      // 判断・Request・research_requestedイベントを同じtransactionで保存する。いずれかが失敗すれば全て残らない。
      // 相関IDとrequestKeyはDecisionから決定的に作る。requestKeyの既存unique indexがDecisionごとに1件へ収束させ、
      // 再送時の取得と、相関ID（イベントにも引き継がれる）によるDecisionへの遡りに使う。
      const researchRequest = await insertResearchRequest(
        transaction,
        projectId,
        {
          requestKey: additionalResearchRequestKey(decisionId),
          kind: "decision",
          originIntentId: input.intentId,
          originOutcomeId: null,
          ...input.research,
          correlationId: additionalResearchCorrelationId(decisionId),
        },
        now,
        this.changeObserver,
      );
      return { kind: "created", decision, researchRequest };
    });
  }

  async decideNextOutcome(
    projectId: string,
    intentBriefSnapshot: IntentResearchSummary,
    input: DecideNextOutcomeInput & { principalId: string },
  ): Promise<DecideNextOutcomeResult> {
    return this.database.transaction().execute(async (transaction): Promise<DecideNextOutcomeResult> => {
      if (await this.projects(transaction).isArchived(projectId)) return { kind: "project_archived" };
      const workspaceId = await this.projects(transaction).findDirectionWorkspaceId(projectId);
      // Outcome・成功条件・Decision・通知を保存するtransaction内で所有Workspaceの状態を検査する。
      if (await this.workspaces(transaction).isArchived(workspaceId)) return { kind: "workspace_archived", workspaceId };

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
        .where("workspace_id", "=", workspaceId)
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
      if (input.evaluationId !== undefined) {
        const evaluationCheck = await validateEvaluationReference(
          transaction,
          projectId,
          input.intentId,
          input.evaluationId,
          "next_outcome",
        );
        if (evaluationCheck.kind !== "ok") return evaluationCheck;
      }

      const now = this.clock();
      const outcomeId = crypto.randomUUID();
      const decisionId = crypto.randomUUID();
      // Outcomeを先に作る（direction_decision.outcome_idがoutcome.idを参照するFKの前提）。
      const outcome = await insertOutcomeRow(
        transaction,
        workspaceId,
        input.intentId,
        outcomeId,
        decisionId,
        input.outcome,
        now,
        this.changeObserver,
      );
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
      await this.notifyRecorded(transaction, decision);
      return { kind: "created", decision, outcome };
    });
  }

  /** Decisionの確定。判断の理由は経緯の中心なので通知に含める（根拠の参照はDecision本体を正とする）。 */
  private notifyRecorded(transaction: Transaction<DirectionDatabase>, decision: DirectionDecision) {
    return notifyDirectionChange(this.changeObserver, transaction, {
      type: "decision_recorded",
      projectId: decision.projectId,
      recordId: decision.id,
      title: decision.judgment,
      refs: [
        { kind: "decision", id: decision.id },
        { kind: "intent", id: decision.intentId },
        ...(decision.outcomeId ? [{ kind: "outcome" as const, id: decision.outcomeId }] : []),
      ],
      result: decision.type,
      reason: decision.reason,
      principalId: decision.principalId,
      occurredAt: decision.createdAt,
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
