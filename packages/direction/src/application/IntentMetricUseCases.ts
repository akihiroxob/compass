import { deriveIntentMetricCurrent, type IntentMetric, type IntentMetricCurrent, type IntentMetricObservation } from "../domain/IntentMetric.ts";
import type {
  IntentMetricObservationRecord,
  IntentMetricRepository,
  IntentMetricSeriesRange,
} from "../domain/IntentMetricRepository.ts";
import type { IntentStatus } from "../domain/Intent.ts";
import type { DirectionWorkspaceReader } from "./port/DirectionWorkspaceReader.ts";
import {
  parseDefineIntentMetricInput,
  parseIntentMetricSeriesRange,
  parseRecordIntentMetricObservationsInput,
} from "./intentMetricSchema.ts";
import { ConflictError, NotFoundError } from "@compass/shared";
import { WorkspaceArchivedError } from "@compass/organization";

const requireWorkspace = async (workspaceReader: DirectionWorkspaceReader, workspaceId: string) => {
  if (!(await workspaceReader.findById(workspaceId))) {
    throw new NotFoundError(`Workspace ${workspaceId} was not found`);
  }
};

/** 書込で共通する拒否を、公開する業務エラーへ変換する。 */
const rejectWrite = (
  result: { kind: "intent_not_found" } | { kind: "intent_not_active"; status: IntentStatus } | { kind: "workspace_archived" },
  workspaceId: string,
  intentId: string,
): never => {
  switch (result.kind) {
    case "workspace_archived":
      throw new WorkspaceArchivedError(workspaceId);
    case "intent_not_found":
      throw new NotFoundError(`Intent ${intentId} was not found in Workspace ${workspaceId}`);
    case "intent_not_active":
      throw new ConflictError(`Intent ${intentId} is ${result.status}; only an active Intent's Metrics are defined and observed`, {
        reason: "intent_not_active",
        status: result.status,
      });
  }
};

export type DefineIntentMetricResponse = {
  metric: IntentMetric;
  /** `created`・`updated`・`unchanged`（同じ定義の再送）。 */
  result: "created" | "updated" | "unchanged";
};

/**
 * activeなIntentへ観測項目（単位・目標値・鮮度の期限）を定義する。同じkeyは同じ項目として更新し、同じ内容の再送は変更しない。
 * 観測値がある項目の単位は変更できない（過去の値の意味が変わるため）。目標値は明示した値だけを保存する。
 */
export class DefineIntentMetricUseCase {
  constructor(
    private readonly workspaceReader: DirectionWorkspaceReader,
    private readonly repository: IntentMetricRepository,
    private readonly clock: () => number,
  ) {}

  async execute(workspaceId: string, principalId: string, intentId: string, input: unknown): Promise<DefineIntentMetricResponse> {
    const parsed = parseDefineIntentMetricInput(input);
    await requireWorkspace(this.workspaceReader, workspaceId);
    const saved = await this.repository.define(workspaceId, intentId, principalId, parsed, this.clock());
    switch (saved.kind) {
      case "created":
      case "updated":
      case "unchanged":
        return { metric: saved.metric, result: saved.kind };
      case "unit_locked":
        throw new ConflictError(`Metric ${parsed.key} already has observations in ${saved.unit}; its unit cannot be changed`, {
          reason: "unit_locked",
          unit: saved.unit,
        });
      default:
        return rejectWrite(saved, workspaceId, intentId);
    }
  }
}

export type RecordIntentMetricObservationsResponse = {
  metric: IntentMetric;
  /** 入力順。`created`は新しい対象期間、`revised`は既存の対象期間の新しい版、`unchanged`は最新版と同じ内容の再送。 */
  observations: IntentMetricObservationRecord[];
};

/**
 * 定義済みの観測項目へ、対象期間ごとの観測値（取得失敗を含む）を記録する。同じ対象期間の最新版と同じ内容は新しい版を作らず、
 * 内容が違えば次の版として追記する。過去の版は書き換えない。
 */
export class RecordIntentMetricObservationsUseCase {
  constructor(
    private readonly workspaceReader: DirectionWorkspaceReader,
    private readonly repository: IntentMetricRepository,
    private readonly clock: () => number,
  ) {}

  async execute(workspaceId: string, principalId: string, intentId: string, input: unknown): Promise<RecordIntentMetricObservationsResponse> {
    const now = this.clock();
    const parsed = parseRecordIntentMetricObservationsInput(input, now);
    await requireWorkspace(this.workspaceReader, workspaceId);
    const saved = await this.repository.recordObservations(workspaceId, intentId, parsed.metricKey, principalId, parsed.observations, now);
    switch (saved.kind) {
      case "recorded":
        return { metric: saved.metric, observations: saved.observations };
      case "metric_not_found":
        throw new NotFoundError(`Metric ${parsed.metricKey} was not found in Intent ${intentId}; define it first`);
      default:
        return rejectWrite(saved, workspaceId, intentId);
    }
  }
}

export type IntentMetricView = IntentMetric & {
  current: IntentMetricCurrent;
  series: { from: string; to: string; points: IntentMetricObservation[] };
};

export type ListIntentMetricsResult = {
  intentId: string;
  /** 鮮度の判定に使った時刻。 */
  observedAt: number;
  /** 観測項目が未定義なら空。観測項目ごとの`current.state`で未計測・取得失敗・古い観測を区別する。 */
  metrics: IntentMetricView[];
};

/**
 * Intentの観測項目と、現在の観測状態・範囲内の時系列を返す。時系列は観測のある対象期間の最新版だけで、
 * 観測の無い期間をゼロや補間値で埋めない。比率・達成度は計算しない。
 */
export class ListIntentMetricsUseCase {
  constructor(
    private readonly workspaceReader: DirectionWorkspaceReader,
    private readonly repository: IntentMetricRepository,
    private readonly clock: () => number,
  ) {}

  async execute(workspaceId: string, intentId: string, query: unknown = {}): Promise<ListIntentMetricsResult> {
    const now = this.clock();
    const range: IntentMetricSeriesRange = parseIntentMetricSeriesRange(query, now);
    await requireWorkspace(this.workspaceReader, workspaceId);
    const listed = await this.repository.listByIntent(workspaceId, intentId, range);
    if (listed === null) throw new NotFoundError(`Intent ${intentId} was not found in Workspace ${workspaceId}`);
    return {
      intentId,
      observedAt: now,
      metrics: listed.map(({ metric, latest, lastObserved, series }) => ({
        ...metric,
        current: deriveIntentMetricCurrent(metric, latest, lastObserved, now),
        series: { ...range, points: series },
      })),
    };
  }
}
