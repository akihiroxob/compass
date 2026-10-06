import type { Kysely, Selectable, Transaction } from "kysely";
import { sql } from "kysely";
import {
  isClosedResearchStatus,
  type EvidenceReference,
  type IntentResearchSummary,
  type ResearchFinding,
  type ResearchRequest,
  type ResearchRequestDetail,
  type ResearchResult,
  type ResearchSynthesis,
} from "../domain/Research.ts";
import type {
  CloseResearchRequestResult,
  CreateResearchRequestResult,
  RegisterResearchResultResult,
  RelatedResearchFindings,
  RegisterResearchSynthesisResult,
  ResearchRepository,
  ResearchRequestQuery,
} from "../domain/ResearchRepository.ts";
import type {
  CompleteResearchRequestInput,
  CreateResearchRequestInput,
  RegisterResearchResultInput,
  RegisterResearchSynthesisInput,
} from "../domain/ResearchRepository.ts";
import type {
  DirectionDatabase,
  ResearchEvidenceRefTable,
  ResearchFindingTable,
  ResearchRequestTable,
  ResearchResultTable,
  ResearchSynthesisTable,
} from "./schema.ts";
import { inputHash } from "@compass/shared";
import type { DirectionWorkspaceReaders } from "./directionWorkspaceReaders.ts";
import { insertResearchRequest, toRequest } from "./researchRequestRecord.ts";
import { notifyDirectionChange, type DirectionChangeObserver } from "./directionChange.ts";

type Executor = Kysely<DirectionDatabase> | Transaction<DirectionDatabase>;

const parseList = (value: string): string[] => JSON.parse(value) as string[];

const byRowid = sql`rowid`;

const toEvidence = (row: Selectable<ResearchEvidenceRefTable>): EvidenceReference => ({
  id: row.id,
  workspaceId: row.workspace_id,
  resultId: row.result_id,
  position: row.position,
  kind: row.kind,
  uri: row.uri,
  retrievedAt: row.retrieved_at,
  versionHash: row.version_hash,
  resourceId: row.resource_id,
});

/** ResultのrowにEvidence参照とFindingを位置順で結び付ける。 */
const loadResults = async (
  database: Executor,
  rows: Selectable<ResearchResultTable>[],
): Promise<ResearchResult[]> => {
  if (rows.length === 0) return [];
  const resultIds = rows.map((row) => row.id);
  const evidenceRows = await database
    .selectFrom("research_evidence_ref")
    .selectAll()
    .where("result_id", "in", resultIds)
    .orderBy("position", "asc")
    .execute();
  const findingRows: Selectable<ResearchFindingTable>[] = await database
    .selectFrom("research_finding")
    .selectAll()
    .where("result_id", "in", resultIds)
    .orderBy("position", "asc")
    .execute();
  const findingIds = findingRows.map((row) => row.id);
  const evidenceLinks =
    findingIds.length === 0
      ? []
      : await database
          .selectFrom("research_finding_evidence")
          .selectAll()
          .where("finding_id", "in", findingIds)
          .orderBy("position", "asc")
          .execute();
  const conflictLinks =
    findingIds.length === 0
      ? []
      : await database
          .selectFrom("research_finding_conflict")
          .selectAll()
          .where("finding_id", "in", findingIds)
          .orderBy(byRowid, "asc")
          .execute();

  const findings = findingRows.map(
    (row): ResearchFinding => ({
      id: row.id,
      workspaceId: row.workspace_id,
      requestId: row.request_id,
      resultId: row.result_id,
      position: row.position,
      statement: row.statement,
      confidence: row.confidence,
      observedAt: row.observed_at,
      expiresAt: row.expires_at,
      evidenceRefIds: evidenceLinks.filter((link) => link.finding_id === row.id).map((link) => link.evidence_ref_id),
      conflictsWithFindingIds: conflictLinks
        .filter((link) => link.finding_id === row.id)
        .map((link) => link.conflicting_finding_id),
      principalId: row.principal_id,
      runRef: row.run_ref,
      createdAt: row.created_at,
    }),
  );
  return rows.map((row) => ({
    id: row.id,
    workspaceId: row.workspace_id,
    requestId: row.request_id,
    sequence: row.sequence,
    summary: row.summary,
    unknowns: parseList(row.unknowns),
    options: parseList(row.options),
    risks: parseList(row.risks),
    budgetUsed: row.budget_used,
    evidenceRefs: evidenceRows.filter((item) => item.result_id === row.id).map(toEvidence),
    findings: findings.filter((item) => item.resultId === row.id),
    principalId: row.principal_id,
    runRef: row.run_ref,
    createdAt: row.created_at,
  }));
};

const loadSyntheses = async (
  database: Executor,
  rows: Selectable<ResearchSynthesisTable>[],
): Promise<ResearchSynthesis[]> => {
  if (rows.length === 0) return [];
  const links = await database
    .selectFrom("research_synthesis_finding")
    .selectAll()
    .where(
      "synthesis_id",
      "in",
      rows.map((row) => row.id),
    )
    .orderBy("position", "asc")
    .execute();
  return rows.map((row) => ({
    id: row.id,
    workspaceId: row.workspace_id,
    requestId: row.request_id,
    version: row.version,
    supersedesId: row.supersedes_id,
    conclusion: row.conclusion,
    findingIds: links.filter((link) => link.synthesis_id === row.id).map((link) => link.finding_id),
    risks: parseList(row.risks),
    options: parseList(row.options),
    unknowns: parseList(row.unknowns),
    validAsOf: row.valid_as_of,
    principalId: row.principal_id,
    runRef: row.run_ref,
    createdAt: row.created_at,
  }));
};

const loadDetail = async (
  database: Executor,
  requestRow: Selectable<ResearchRequestTable>,
): Promise<ResearchRequestDetail> => {
  const resultRows = await database
    .selectFrom("research_result")
    .selectAll()
    .where("request_id", "=", requestRow.id)
    .orderBy("sequence", "asc")
    .execute();
  const synthesisRows = await database
    .selectFrom("research_synthesis")
    .selectAll()
    .where("request_id", "=", requestRow.id)
    .orderBy(byRowid, "asc")
    .execute();
  return {
    request: toRequest(requestRow),
    results: await loadResults(database, resultRows),
    syntheses: await loadSyntheses(database, synthesisRows),
  };
};

/** 別WorkspaceのRequest IDは存在しないものとして扱う。 */
const findRequestRow = (database: Executor, workspaceId: string, requestId: string) =>
  database
    .selectFrom("research_request")
    .selectAll()
    .where("id", "=", requestId)
    .where("workspace_id", "=", workspaceId)
    .executeTakeFirst();

const findExistingIds = async (
  database: Executor,
  workspaceId: string,
  ids: readonly string[],
): Promise<Set<string>> => {
  if (ids.length === 0) return new Set();
  const rows = await database
    .selectFrom("research_finding")
    .select("id")
    .where("workspace_id", "=", workspaceId)
    .where("id", "in", [...ids])
    .execute();
  return new Set(rows.map((row) => row.id));
};

export class SQLiteResearchRepository implements ResearchRepository {
  /** `clock`は期限判定の時刻源。テストで固定できるよう注入する。 */
  constructor(
    private readonly database: Kysely<DirectionDatabase>,
    private readonly workspaces: DirectionWorkspaceReaders,
    private readonly clock: () => number = Date.now,
    private readonly changeObserver: DirectionChangeObserver | null = null,
  ) {}

  async createRequest(
    workspaceId: string,
    input: CreateResearchRequestInput,
  ): Promise<CreateResearchRequestResult> {
    return this.database
      .transaction()
      .execute(async (transaction): Promise<CreateResearchRequestResult> => {
        if (await this.workspaces(transaction).isArchived(workspaceId)) return { kind: "workspace_archived" };

        const hash = inputHash(input);
        const existing = await transaction
          .selectFrom("research_request")
          .selectAll()
          .where("workspace_id", "=", workspaceId)
          .where("request_key", "=", input.requestKey)
          .executeTakeFirst();
        if (existing) {
          return existing.input_hash === hash
            ? { kind: "replayed", request: toRequest(existing) }
            : { kind: "key_conflict", requestKey: input.requestKey };
        }

        // 再送の判定より後に置く。期限後に同じ入力を再送しても、作成済みのRequestを返せるようにする。
        const now = this.clock();
        if (input.deadlineAt !== null && input.deadlineAt <= now) {
          return { kind: "deadline_in_past", deadlineAt: input.deadlineAt };
        }

        if (input.originIntentId !== null) {
          const intent = await transaction
            .selectFrom("intent")
            .select("status")
            .where("id", "=", input.originIntentId)
            .where("workspace_id", "=", workspaceId)
            .executeTakeFirst();
          if (!intent) return { kind: "intent_not_found" };
          if (intent.status !== "active") return { kind: "intent_not_active", status: intent.status };
          if (input.originOutcomeId !== null) {
            const outcome = await transaction
              .selectFrom("outcome")
              .select("id")
              .where("id", "=", input.originOutcomeId)
              .where("workspace_id", "=", workspaceId)
              .where("intent_id", "=", input.originIntentId)
              .executeTakeFirst();
            if (!outcome) return { kind: "outcome_not_found" };
          }
        }

        return {
          kind: "created",
          request: await insertResearchRequest(transaction, workspaceId, input, now, this.changeObserver),
        };
      });
  }

  async findRequests(workspaceId: string, query: ResearchRequestQuery = {}): Promise<ResearchRequest[]> {
    let statement = this.database.selectFrom("research_request").selectAll().where("workspace_id", "=", workspaceId);
    if (query.originIntentId !== undefined) statement = statement.where("origin_intent_id", "=", query.originIntentId);
    if (query.status !== undefined) statement = statement.where("status", "=", query.status);
    const rows = await statement.orderBy("created_at", "desc").orderBy(byRowid, "desc").execute();
    return rows.map(toRequest);
  }

  async findRequestDetail(workspaceId: string, requestId: string): Promise<ResearchRequestDetail | null> {
    const row = await findRequestRow(this.database, workspaceId, requestId);
    return row ? loadDetail(this.database, row) : null;
  }

  async findIntentResearchSummary(workspaceId: string, intentId: string): Promise<IntentResearchSummary> {
    const requestRows = await this.database
      .selectFrom("research_request")
      .selectAll()
      .where("workspace_id", "=", workspaceId)
      .where("origin_intent_id", "=", intentId)
      .orderBy("created_at", "desc")
      .orderBy(byRowid, "desc")
      .execute();
    const requests = requestRows.map((row) => ({
      id: row.id,
      status: row.status,
      question: row.question,
      budgetTotal: row.budget_total,
      budgetUsed: row.budget_used,
      deadlineAt: row.deadline_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));

    // cancelledのRequestは来歴として`requests`に残すが、圧縮結果（syntheses）の根拠からは外す。
    const openRequestIds = requestRows.filter((row) => row.status !== "cancelled").map((row) => row.id);
    if (openRequestIds.length === 0) return { requests, syntheses: [], conflicts: [] };

    const synthesisRows = await this.database
      .selectFrom("research_synthesis")
      .selectAll()
      .where("request_id", "in", openRequestIds)
      .orderBy("valid_as_of", "desc")
      .orderBy(byRowid, "desc")
      .execute();
    if (synthesisRows.length === 0) return { requests, syntheses: [], conflicts: [] };

    // このIntent配下のRequestに限定した系列内で、supersedesIdに指されていない行だけを最新versionとみなす。
    const supersededIds = new Set(
      synthesisRows.map((row) => row.supersedes_id).filter((id): id is string => id !== null),
    );
    const latestRows = synthesisRows.filter((row) => !supersededIds.has(row.id));

    const links = await this.database
      .selectFrom("research_synthesis_finding")
      .selectAll()
      .where(
        "synthesis_id",
        "in",
        latestRows.map((row) => row.id),
      )
      .orderBy("position", "asc")
      .execute();
    const findingIds = [...new Set(links.map((link) => link.finding_id))];
    const findingRows =
      findingIds.length === 0
        ? []
        : await this.database
            .selectFrom("research_finding")
            .select(["id", "expires_at"])
            .where("id", "in", findingIds)
            .execute();
    const expiresById = new Map(findingRows.map((row) => [row.id, row.expires_at]));
    const now = this.clock();

    // research_finding_conflictは宣言方向が非対称（新Findingが既存Findingを指す）なので、
    // findingIdsが宣言元・宣言先いずれの当事者になっている行も両方拾う。
    const conflictRows =
      findingIds.length === 0
        ? []
        : await this.database
            .selectFrom("research_finding_conflict")
            .selectAll()
            .where((eb) =>
              eb.or([eb("finding_id", "in", findingIds), eb("conflicting_finding_id", "in", findingIds)]),
            )
            .execute();
    const conflicts = conflictRows
      .map((row) => ({ findingId: row.finding_id, conflictsWithFindingId: row.conflicting_finding_id }))
      .sort(
        (a, b) => a.findingId.localeCompare(b.findingId) || a.conflictsWithFindingId.localeCompare(b.conflictsWithFindingId),
      );

    const syntheses = latestRows.map((row) => {
      const ids = links.filter((link) => link.synthesis_id === row.id).map((link) => link.finding_id);
      const stale = ids.some((id) => {
        const expiresAt = expiresById.get(id);
        return expiresAt !== null && expiresAt !== undefined && expiresAt <= now;
      });
      return {
        requestId: row.request_id,
        synthesisId: row.id,
        version: row.version,
        conclusion: row.conclusion,
        risks: parseList(row.risks),
        options: parseList(row.options),
        unknowns: parseList(row.unknowns),
        findingIds: ids,
        validAsOf: row.valid_as_of,
        stale,
      };
    });

    return { requests, syntheses, conflicts };
  }

  async findRelatedFindings(workspaceId: string, requestId: string, limit: number): Promise<RelatedResearchFindings> {
    const request = await findRequestRow(this.database, workspaceId, requestId);
    if (!request) return { findings: [], evidenceRefs: [] };
    let statement = this.database
      .selectFrom("research_finding")
      .innerJoin("research_request", "research_request.id", "research_finding.request_id")
      .select(["research_finding.id as id", "research_finding.result_id as result_id"])
      .where("research_finding.workspace_id", "=", workspaceId)
      .where("research_finding.request_id", "!=", requestId)
      .where("research_request.kind", "=", request.kind);
    statement =
      request.origin_intent_id === null
        ? statement.where("research_request.origin_intent_id", "is", null)
        : statement.where("research_request.origin_intent_id", "=", request.origin_intent_id);
    const selected = await statement
      .orderBy("research_finding.created_at", "desc")
      .orderBy(sql`research_finding.rowid`, "desc")
      .limit(limit)
      .execute();
    if (selected.length === 0) return { findings: [], evidenceRefs: [] };

    const resultRows = await this.database
      .selectFrom("research_result")
      .selectAll()
      .where("id", "in", [...new Set(selected.map((row) => row.result_id))])
      .execute();
    const results = await loadResults(this.database, resultRows);
    const wanted = new Set(selected.map((row) => row.id));
    const findingsById = new Map(
      results.flatMap((result) => result.findings).filter((finding) => wanted.has(finding.id)).map((finding) => [finding.id, finding]),
    );
    const findings = selected.map((row) => findingsById.get(row.id)!);
    const cited = new Set(findings.flatMap((finding) => finding.evidenceRefIds));
    const evidenceRefs = results.flatMap((result) => result.evidenceRefs).filter((evidence) => cited.has(evidence.id));
    return { findings, evidenceRefs };
  }

  async registerResult(
    workspaceId: string,
    requestId: string,
    input: RegisterResearchResultInput,
  ): Promise<RegisterResearchResultResult> {
    return this.database
      .transaction()
      .execute(async (transaction): Promise<RegisterResearchResultResult> => {
        if (await this.workspaces(transaction).isArchived(workspaceId)) return { kind: "workspace_archived" };
        const request = await findRequestRow(transaction, workspaceId, requestId);
        if (!request) return { kind: "request_not_found" };

        const hash = inputHash(input);
        const existing = await transaction
          .selectFrom("research_result")
          .selectAll()
          .where("request_id", "=", requestId)
          .where("request_key", "=", input.requestKey)
          .executeTakeFirst();
        if (existing) {
          if (existing.input_hash !== hash) return { kind: "key_conflict", requestKey: input.requestKey };
          const [result] = await loadResults(transaction, [existing]);
          return { kind: "replayed", result: result! };
        }

        if (isClosedResearchStatus(request.status)) return { kind: "not_open", status: request.status };
        const now = this.clock();
        if (request.deadline_at !== null && now > request.deadline_at) {
          return { kind: "deadline_passed", deadlineAt: request.deadline_at };
        }
        const budgetUsed = request.budget_used + input.budgetUsed;
        if (budgetUsed > request.budget_total) {
          return { kind: "budget_exceeded", budgetTotal: request.budget_total, budgetUsed };
        }

        const resourceIds = [...new Set(input.evidenceRefs.flatMap(ref => ref.resourceId ? [ref.resourceId] : []))];
        const missingResources: string[] = [];
        for (const resourceId of resourceIds) {
          if (!await this.workspaces(transaction).resourceBelongsToWorkspace(workspaceId, resourceId)) missingResources.push(resourceId);
        }
        if (missingResources.length > 0) return { kind: "invalid_reference", reference: "resource", ids: missingResources };

        const conflictIds = [...new Set(input.findings.flatMap((finding) => finding.conflictsWithFindingIds))];
        const known = await findExistingIds(transaction, workspaceId, conflictIds);
        const missing = conflictIds.filter((id) => !known.has(id));
        if (missing.length > 0) return { kind: "invalid_reference", reference: "finding", ids: missing };

        const last = await transaction
          .selectFrom("research_result")
          .select((builder) => builder.fn.max<number>("sequence").as("sequence"))
          .where("request_id", "=", requestId)
          .executeTakeFirst();
        const resultRow = await transaction
          .insertInto("research_result")
          .values({
            id: crypto.randomUUID(),
            workspace_id: workspaceId,
            request_id: requestId,
            sequence: (last?.sequence ?? 0) + 1,
            request_key: input.requestKey,
            input_hash: hash,
            summary: input.summary,
            unknowns: JSON.stringify(input.unknowns),
            options: JSON.stringify(input.options),
            risks: JSON.stringify(input.risks),
            budget_used: input.budgetUsed,
            principal_id: input.principalId,
            run_ref: input.runRef,
            created_at: now,
          })
          .returningAll()
          .executeTakeFirstOrThrow();

        const evidenceIds = input.evidenceRefs.map(() => crypto.randomUUID());
        if (input.evidenceRefs.length > 0) {
          await transaction
            .insertInto("research_evidence_ref")
            .values(
              input.evidenceRefs.map((evidence, position) => ({
                id: evidenceIds[position]!,
                workspace_id: workspaceId,
                result_id: resultRow.id,
                position,
                kind: evidence.kind,
                uri: evidence.uri,
                retrieved_at: evidence.retrievedAt,
                version_hash: evidence.versionHash,
                resource_id: evidence.resourceId,
              })),
            )
            .execute();
        }
        for (const [position, finding] of input.findings.entries()) {
          const findingId = crypto.randomUUID();
          await transaction
            .insertInto("research_finding")
            .values({
              id: findingId,
              workspace_id: workspaceId,
              request_id: requestId,
              result_id: resultRow.id,
              position,
              statement: finding.statement,
              confidence: finding.confidence,
              observed_at: finding.observedAt,
              expires_at: finding.expiresAt,
              principal_id: input.principalId,
              run_ref: input.runRef,
              created_at: now,
            })
            .execute();
          await transaction
            .insertInto("research_finding_evidence")
            .values(
              finding.evidenceIndexes.map((evidenceIndex, evidencePosition) => ({
                finding_id: findingId,
                evidence_ref_id: evidenceIds[evidenceIndex]!,
                position: evidencePosition,
              })),
            )
            .execute();
          if (finding.conflictsWithFindingIds.length > 0) {
            await transaction
              .insertInto("research_finding_conflict")
              .values(
                finding.conflictsWithFindingIds.map((conflictingId) => ({
                  finding_id: findingId,
                  conflicting_finding_id: conflictingId,
                })),
              )
              .execute();
          }
        }

        await transaction
          .updateTable("research_request")
          .set({ status: "running", budget_used: budgetUsed, updated_at: now })
          .where("id", "=", requestId)
          .execute();
        const [result] = await loadResults(transaction, [resultRow]);
        return { kind: "registered", result: result! };
      });
  }

  async registerSynthesis(
    workspaceId: string,
    requestId: string,
    input: RegisterResearchSynthesisInput,
  ): Promise<RegisterResearchSynthesisResult> {
    return this.database
      .transaction()
      .execute(async (transaction): Promise<RegisterResearchSynthesisResult> => {
        if (await this.workspaces(transaction).isArchived(workspaceId)) return { kind: "workspace_archived" };
        const request = await findRequestRow(transaction, workspaceId, requestId);
        if (!request) return { kind: "request_not_found" };

        const hash = inputHash(input);
        const existing = await transaction
          .selectFrom("research_synthesis")
          .selectAll()
          .where("request_id", "=", requestId)
          .where("request_key", "=", input.requestKey)
          .executeTakeFirst();
        if (existing) {
          if (existing.input_hash !== hash) return { kind: "key_conflict", requestKey: input.requestKey };
          const [synthesis] = await loadSyntheses(transaction, [existing]);
          return { kind: "replayed", synthesis: synthesis! };
        }

        if (isClosedResearchStatus(request.status)) return { kind: "not_open", status: request.status };
        const now = this.clock();
        if (request.deadline_at !== null && now > request.deadline_at) {
          return { kind: "deadline_passed", deadlineAt: request.deadline_at };
        }

        const known = await findExistingIds(transaction, workspaceId, input.findingIds);
        const missing = input.findingIds.filter((id) => !known.has(id));
        if (missing.length > 0) return { kind: "invalid_reference", reference: "finding", ids: missing };

        let version = 1;
        if (input.supersedesId !== null) {
          const previous = await transaction
            .selectFrom("research_synthesis")
            .select("version")
            .where("id", "=", input.supersedesId)
            .where("workspace_id", "=", workspaceId)
            .executeTakeFirst();
          if (!previous) return { kind: "invalid_reference", reference: "supersedes", ids: [input.supersedesId] };
          const successor = await transaction
            .selectFrom("research_synthesis")
            .select("id")
            .where("supersedes_id", "=", input.supersedesId)
            .executeTakeFirst();
          if (successor) {
            return { kind: "already_superseded", supersedesId: input.supersedesId, supersededById: successor.id };
          }
          version = previous.version + 1;
        }

        const row = await transaction
          .insertInto("research_synthesis")
          .values({
            id: crypto.randomUUID(),
            workspace_id: workspaceId,
            request_id: requestId,
            request_key: input.requestKey,
            input_hash: hash,
            version,
            supersedes_id: input.supersedesId,
            conclusion: input.conclusion,
            risks: JSON.stringify(input.risks),
            options: JSON.stringify(input.options),
            unknowns: JSON.stringify(input.unknowns),
            valid_as_of: input.validAsOf,
            principal_id: input.principalId,
            run_ref: input.runRef,
            created_at: now,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto("research_synthesis_finding")
          .values(
            input.findingIds.map((findingId, position) => ({
              synthesis_id: row.id,
              finding_id: findingId,
              position,
            })),
          )
          .execute();
        if (request.status === "requested") {
          await transaction
            .updateTable("research_request")
            .set({ status: "running", updated_at: now })
            .where("id", "=", requestId)
            .execute();
        }
        const [synthesis] = await loadSyntheses(transaction, [row]);
        return { kind: "registered", synthesis: synthesis! };
      });
  }

  async complete(
    workspaceId: string,
    requestId: string,
    input: CompleteResearchRequestInput,
  ): Promise<CloseResearchRequestResult> {
    return this.close(workspaceId, requestId, input.conclusion, input.stopReason, async (transaction) => {
      if (input.conclusion !== "completed") return null;
      for (const [table, missing] of [
        ["research_result", "result"],
        ["research_synthesis", "synthesis"],
      ] as const) {
        const found = await transaction
          .selectFrom(table)
          .select("id")
          .where("request_id", "=", requestId)
          .executeTakeFirst();
        if (!found) return missing;
      }
      return null;
    });
  }

  async cancel(workspaceId: string, requestId: string, reason: string): Promise<CloseResearchRequestResult> {
    return this.close(workspaceId, requestId, "cancelled", reason, async () => null);
  }

  /** 未終了のRequestだけを、状態確認と同一transactionで終了状態へ進める。 */
  private async close(
    workspaceId: string,
    requestId: string,
    status: "completed" | "insufficient" | "not_needed" | "cancelled",
    stopReason: string | null,
    findMissing: (transaction: Transaction<DirectionDatabase>) => Promise<"result" | "synthesis" | null>,
  ): Promise<CloseResearchRequestResult> {
    return this.database.transaction().execute(async (transaction): Promise<CloseResearchRequestResult> => {
      if (await this.workspaces(transaction).isArchived(workspaceId)) return { kind: "workspace_archived" };
      const request = await findRequestRow(transaction, workspaceId, requestId);
      if (!request) return { kind: "request_not_found" };
      if (isClosedResearchStatus(request.status)) return { kind: "not_open", status: request.status };
      const missing = await findMissing(transaction);
      if (missing) return { kind: "incomplete", missing };

      const now = this.clock();
      const row = await transaction
        .updateTable("research_request")
        .set({ status, stop_reason: stopReason, updated_at: now })
        .where("id", "=", requestId)
        .returningAll()
        .executeTakeFirstOrThrow();
      await notifyDirectionChange(this.changeObserver, transaction, {
        type: "research_closed",
        workspaceId,
        recordId: row.id,
        title: row.question,
        refs: [
          { kind: "research_request", id: row.id },
          ...(row.origin_intent_id ? [{ kind: "intent" as const, id: row.origin_intent_id }] : []),
        ],
        result: status,
        reason: stopReason,
        principalId: null,
        occurredAt: now,
      });
      return { kind: "closed", request: toRequest(row) };
    });
  }
}
