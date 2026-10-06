import type { Intent, IntentStatus } from "./Intent.ts";
import type { WorkspaceArchivedResult } from "./WorkspaceArchivedResult.ts";

/** 検証済みの入力。検証規則（zod schema）はapplication層が持ち、parseの戻り値がこの型を満たすことを型検査で保証する。 */
export type CreateIntentInput = {
  title: string;
  desiredState: string;
  completionDefinition: string | null;
};

export type UpdateIntentInput = {
  title?: string;
  desiredState?: string;
  completionDefinition?: string | null;
};

export type CreateIntentResult =
  | { kind: "created"; intent: Intent }
  | { kind: "active_exists"; activeIntentId: string }
  | WorkspaceArchivedResult;

/** 更新・放棄の結果。対象がWorkspace配下に無い場合と、Activeでない場合を区別する。 */
export type ChangeIntentResult =
  | { kind: "changed"; intent: Intent }
  | { kind: "not_found" }
  | { kind: "not_active"; status: IntentStatus }
  | WorkspaceArchivedResult;

/** 書込はWorkspaceがarchivedなら、Intentの検査より先に`workspace_archived`で拒否する（同一transaction）。 */
/** `meaning_locked`は、Outcomeを持つIntentの意味（desiredState / completionDefinition）を変更しようとした場合。 */
export type MeaningLockedResult = { kind: "meaning_locked"; fields: string[] };

export type UpdateIntentResult = ChangeIntentResult | MeaningLockedResult;

export interface IntentRepository {
  /** Workspaceにつきactiveは最大1件。既にあれば作成せず、そのIDを返す。 */
  create(workspaceId: string, input: CreateIntentInput): Promise<CreateIntentResult>;
  /** 指定したWorkspace配下のIntentを新しい順で返す。 */
  findByWorkspace(workspaceId: string): Promise<Intent[]>;
  /** 他Workspaceのintent IDはnullとして扱う。 */
  findById(workspaceId: string, intentId: string): Promise<Intent | null>;
  /** Outcomeを持つIntentは、保存済みと異なるdesiredState / completionDefinitionを拒否する（titleは変更できる）。 */
  update(workspaceId: string, intentId: string, input: UpdateIntentInput): Promise<UpdateIntentResult>;
  /** 放棄と同一transactionで、そのIntentのactiveなOutcomeをcancelledにする。 */
  abandon(workspaceId: string, intentId: string, reason: string | null): Promise<ChangeIntentResult>;
}
