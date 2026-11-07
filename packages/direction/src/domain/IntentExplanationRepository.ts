import type { IntentStatus } from "./Intent.ts";
import type { IntentExplanation, IntentExplanationBasisReference, IntentExplanationItemKind, IntentExplanationView } from "./IntentExplanation.ts";
import type { WorkspaceArchivedResult } from "./WorkspaceArchivedResult.ts";

/** 検証済みの説明項目。種別ごとの必須・禁止項目と`basedOn`の整合はapplication層のschemaが保証する。 */
export type IntentExplanationItemInput = {
  kind: IntentExplanationItemKind;
  statement: string;
  confidence: "low" | "medium" | "high" | null;
  verification: string | null;
  basedOn: number[];
  basis: IntentExplanationBasisReference[];
};

export type RecordIntentExplanationInput = {
  requestKey: string;
  runRef: string;
  metricKey: string;
  periodStart: string;
  periodEnd: string;
  changeFromPrevious: string | null;
  relatedOutcomeIds: string[];
  items: IntentExplanationItemInput[];
};

export type RecordIntentExplanationResult =
  | { kind: "recorded" | "replayed"; explanation: IntentExplanation }
  /** 同じ`requestKey`で内容が異なる。 */
  | { kind: "key_conflict"; requestKey: string }
  | { kind: "intent_not_found" }
  | { kind: "intent_not_active"; status: IntentStatus }
  | { kind: "metric_not_found" }
  /** 同じWorkspaceに無い、または観測対象・Intentに属さない参照。 */
  | { kind: "invalid_reference"; references: { path: string; id: string; message: string }[] }
  | WorkspaceArchivedResult;

export interface IntentExplanationRepository {
  record(workspaceId: string, intentId: string, principalId: string, input: RecordIntentExplanationInput, at: number): Promise<RecordIntentExplanationResult>;
  /** Intentの説明を新しい順に返す。根拠は原記録から解決する。IntentがWorkspaceに無ければnull。 */
  listByIntent(workspaceId: string, intentId: string, at: number): Promise<IntentExplanationView[] | null>;
}
