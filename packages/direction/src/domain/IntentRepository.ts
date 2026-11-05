import type { Intent, IntentRevision, IntentStatus } from "./Intent.ts";
import type { WorkspaceArchivedResult } from "./WorkspaceArchivedResult.ts";

/** 検証済みの入力。検証規則（zod schema）はapplication層が持ち、parseの戻り値がこの型を満たすことを型検査で保証する。 */
export type CreateIntentInput = {
  title: string;
  desiredState: string;
  background: string | null;
  audience: string | null;
  constraints: string | null;
  completionDefinition: string | null;
  targetDate: string | null;
};

/** 変更した主体。Human・Agentのどちらも、認可済みの入口が固定した主体をそのまま記録する。 */
export type IntentActor = { principalId: string; role: string };

export type UpdateIntentInput = {
  /** 編集の元にした版。保存済みの現在版と異なる場合は更新せず競合として返す。 */
  expectedVersion: number;
  /** 変更理由。Outcomeを持つIntentの意味（desiredState / completionDefinition）を変える場合は必須。 */
  reason?: string | null;
  title?: string;
  desiredState?: string;
  background?: string | null;
  audience?: string | null;
  constraints?: string | null;
  completionDefinition?: string | null;
  targetDate?: string | null;
};

export type CreateIntentResult =
  | { kind: "created"; intent: Intent }
  | WorkspaceArchivedResult;

/** 更新・放棄の結果。対象がWorkspace配下に無い場合と、Activeでない場合を区別する。 */
export type ChangeIntentResult =
  | { kind: "changed"; intent: Intent }
  | { kind: "not_found" }
  | { kind: "not_active"; status: IntentStatus }
  | VersionConflictResult
  | WorkspaceArchivedResult;

/** 呼び出し側が持つ版が現在版と異なる。保存済みの現在内容を根拠として扱ってはならない。 */
export type VersionConflictResult = { kind: "version_conflict"; currentVersion: number };

/** Outcomeを持つIntentの意味を理由なしに変えようとした場合。意味の変更は全面禁止ではなく、理由と新しい版で残す。 */
export type ReasonRequiredResult = { kind: "reason_required"; fields: string[] };

export type UpdateIntentResult = ChangeIntentResult | ReasonRequiredResult;

export interface IntentRepository {
  /** 既存のIntentを変更せず、新しいactive Intentを作成する。版1の履歴を同一transactionで残す。 */
  create(workspaceId: string, input: CreateIntentInput, actor: IntentActor): Promise<CreateIntentResult>;
  /** 指定したWorkspace配下のIntentを新しい順で返す。 */
  findByWorkspace(workspaceId: string): Promise<Intent[]>;
  /** 他Workspaceのintent IDはnullとして扱う。 */
  findById(workspaceId: string, intentId: string): Promise<Intent | null>;
  /** 版が一致するときだけ更新し、新しい版と変更主体・理由を履歴に残す。Outcome・判断・評価は元の版を参照したまま変えない。 */
  update(workspaceId: string, intentId: string, input: UpdateIntentInput, actor: IntentActor): Promise<UpdateIntentResult>;
  /** 版の履歴（新しい順）。他Workspaceのintent IDはnull。 */
  findRevisions(workspaceId: string, intentId: string): Promise<IntentRevision[] | null>;
  /** 放棄と同一transactionで、そのIntentのactiveなOutcomeをcancelledにする（achieved等へは変えない）。`expectedVersion`を指定した場合は一致を条件にする。 */
  abandon(workspaceId: string, intentId: string, reason: string | null, expectedVersion?: number): Promise<ChangeIntentResult>;
}
