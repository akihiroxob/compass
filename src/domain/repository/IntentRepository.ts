import type { Intent, IntentStatus } from "../model/Intent.ts";
import type { CreateIntentInput, UpdateIntentInput } from "../../shared/intentSchema.ts";

export type CreateIntentResult =
  | { kind: "created"; intent: Intent }
  | { kind: "active_exists"; activeIntentId: string };

/** 更新・放棄の結果。対象がProject配下に無い場合と、Activeでない場合を区別する。 */
export type ChangeIntentResult =
  | { kind: "changed"; intent: Intent }
  | { kind: "not_found" }
  | { kind: "not_active"; status: IntentStatus };

/** `meaning_locked`は、Outcomeを持つIntentの意味（desiredState / completionDefinition）を変更しようとした場合。 */
export type MeaningLockedResult = { kind: "meaning_locked"; fields: string[] };

export type UpdateIntentResult = ChangeIntentResult | MeaningLockedResult;

export interface IntentRepository {
  /** Projectにつきactiveは最大1件。既にあれば作成せず、そのIDを返す。 */
  create(projectId: string, input: CreateIntentInput): Promise<CreateIntentResult>;
  /** 指定したProject配下のIntentを新しい順で返す。 */
  findByProject(projectId: string): Promise<Intent[]>;
  /** 他Projectのintent IDはnullとして扱う。 */
  findById(projectId: string, intentId: string): Promise<Intent | null>;
  /** Outcomeを持つIntentは、保存済みと異なるdesiredState / completionDefinitionを拒否する（titleは変更できる）。 */
  update(projectId: string, intentId: string, input: UpdateIntentInput): Promise<UpdateIntentResult>;
  /** 放棄と同一transactionで、そのIntentのactiveなOutcomeをcancelledにする。 */
  abandon(projectId: string, intentId: string, reason: string | null): Promise<ChangeIntentResult>;
}
