import { ConflictError, NotFoundError, ValidationError } from "@compass/shared";
import { WorkspaceArchivedError } from "@compass/organization";
import type { IntentExplanation, IntentExplanationView } from "../domain/IntentExplanation.ts";
import type { IntentExplanationRepository } from "../domain/IntentExplanationRepository.ts";
import { deriveIntentMetricCurrent, type IntentMetricCurrentState } from "../domain/IntentMetric.ts";
import type { IntentMetricRepository } from "../domain/IntentMetricRepository.ts";
import type { DirectionWorkspaceReader } from "./port/DirectionWorkspaceReader.ts";
import { parseRecordIntentExplanationInput } from "./intentExplanationSchema.ts";

const requireWorkspace = async (workspaceReader: DirectionWorkspaceReader, workspaceId: string) => {
  if (!(await workspaceReader.findById(workspaceId))) {
    throw new NotFoundError(`Workspace ${workspaceId} was not found`);
  }
};

export type RecordIntentExplanationResponse = {
  explanation: IntentExplanation;
  /** `recorded`は新しい版、`replayed`は同じ`requestKey`・同じ内容の再送（保存済みの説明を返す）。 */
  result: "recorded" | "replayed";
};

/**
 * 観測項目についてのAgentの説明（事実・原因の仮説・次の提案）を追記する。根拠は既存の記録のIDで参照し、本文・値を複製しない。
 * 記録はAgentの実稼働・施策の効果・目標の達成を示さず、Intent・Outcomeの状態を変えない。
 */
export class RecordIntentExplanationUseCase {
  constructor(
    private readonly workspaceReader: DirectionWorkspaceReader,
    private readonly repository: IntentExplanationRepository,
    private readonly clock: () => number,
  ) {}

  async execute(workspaceId: string, principalId: string, intentId: string, input: unknown): Promise<RecordIntentExplanationResponse> {
    const now = this.clock();
    const parsed = parseRecordIntentExplanationInput(input, now);
    await requireWorkspace(this.workspaceReader, workspaceId);
    const saved = await this.repository.record(workspaceId, intentId, principalId, parsed, now);
    switch (saved.kind) {
      case "recorded":
      case "replayed":
        return { explanation: saved.explanation, result: saved.kind };
      case "workspace_archived":
        throw new WorkspaceArchivedError(workspaceId);
      case "intent_not_found":
        throw new NotFoundError(`Intent ${intentId} was not found in Workspace ${workspaceId}`);
      case "intent_not_active":
        throw new ConflictError(`Intent ${intentId} is ${saved.status}; only an active Intent can get a new explanation`, {
          reason: "intent_not_active",
          status: saved.status,
        });
      case "metric_not_found":
        throw new NotFoundError(`Metric ${parsed.metricKey} was not found in Intent ${intentId}; define it first`);
      case "key_conflict":
        throw new ConflictError(`requestKey ${saved.requestKey} was already used with different content`, {
          reason: "request_key_conflict",
        });
      case "invalid_reference":
        throw new ValidationError(
          "Intent Explanation references are invalid",
          saved.references.map((reference) => ({ path: reference.path, message: reference.message })),
        );
    }
  }
}

export type IntentExplanationMetricSummary = {
  key: string;
  name: string;
  unit: string;
  /** 現在の観測状態。説明の有無とは独立で、未計測・取得失敗・古い観測を区別する。 */
  state: IntentMetricCurrentState;
  /** 値を取得できた最新の観測の対象期間の終了日。なければnull。 */
  lastObservedPeriodEnd: string | null;
};

export type ListIntentExplanationsResult = {
  intentId: string;
  /** 根拠の鮮度・観測状態の判定に使った時刻。 */
  observedAt: number;
  /** 観測項目が未定義なら空。説明が無くても観測項目ごとの状態を返し、説明の不在と未接続を区別できるようにする。 */
  metrics: IntentExplanationMetricSummary[];
  /** 新しい順。記録が無ければ空で、生成した説明では埋めない。 */
  explanations: IntentExplanationView[];
};

/** Intentの説明（新しい順）と、観測項目ごとの現在の観測状態を返す。 */
export class ListIntentExplanationsUseCase {
  constructor(
    private readonly workspaceReader: DirectionWorkspaceReader,
    private readonly repository: IntentExplanationRepository,
    private readonly metricRepository: IntentMetricRepository,
    private readonly clock: () => number,
  ) {}

  async execute(workspaceId: string, intentId: string): Promise<ListIntentExplanationsResult> {
    const now = this.clock();
    await requireWorkspace(this.workspaceReader, workspaceId);
    const explanations = await this.repository.listByIntent(workspaceId, intentId, now);
    if (explanations === null) throw new NotFoundError(`Intent ${intentId} was not found in Workspace ${workspaceId}`);
    const today = new Date(now).toISOString().slice(0, 10);
    const metrics = (await this.metricRepository.listByIntent(workspaceId, intentId, { from: today, to: today })) ?? [];
    return {
      intentId,
      observedAt: now,
      metrics: metrics.map(({ metric, latest, lastObserved }) => ({
        key: metric.key,
        name: metric.name,
        unit: metric.unit,
        state: deriveIntentMetricCurrent(metric, latest, lastObserved, now).state,
        lastObservedPeriodEnd: lastObserved?.periodEnd ?? null,
      })),
      explanations,
    };
  }
}
