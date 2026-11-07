/**
 * Intent（ビジネス目標）の観測について、Agentが記録する説明。確認できた事実・原因の仮説・次の提案を区別し、
 * 既存の記録（観測値・Research Finding / Synthesis・Outcome Evaluation・Direction Decision）をIDで参照する。
 * 参照先の本文・値は複製せず、読み取り時に原記録から解決する。説明は追記だけで、訂正は同じ観測対象の次の版にする。
 *
 * 説明の記録は、Agentの実稼働・施策の効果・目標の達成を示す証拠ではない。仮説は因果の断定ではなく、確認方法を必ず持つ。
 */

export const intentExplanationItemKinds = ["fact", "hypothesis", "proposal"] as const;

/** `fact`: 根拠の記録から確認できる事実。`hypothesis`: 事実に対する解釈・原因の仮説。`proposal`: 次の打ち手の提案。 */
export type IntentExplanationItemKind = (typeof intentExplanationItemKinds)[number];

/** 根拠として参照できる既存の記録。 */
export const intentExplanationBasisTypes = ["metric_observation", "finding", "synthesis", "evaluation", "decision"] as const;

export type IntentExplanationBasisType = (typeof intentExplanationBasisTypes)[number];

/** 項目の種別ごとに根拠にできる記録。事実は観測・Finding・Evaluation、仮説は調査（Finding・Synthesis）・Evaluation、提案は調査・判断。 */
export const allowedBasisTypes: Record<IntentExplanationItemKind, readonly IntentExplanationBasisType[]> = {
  fact: ["metric_observation", "finding", "evaluation"],
  hypothesis: ["finding", "synthesis", "evaluation"],
  proposal: ["synthesis", "decision"],
};

export type IntentExplanationBasisReference = { type: IntentExplanationBasisType; id: string };

export type IntentExplanationItem = {
  /** 説明内の並び（0始まり）。`basedOn`はこの位置で先行する項目を指す。 */
  position: number;
  kind: IntentExplanationItemKind;
  statement: string;
  /** 仮説の確からしさ。仮説以外はnull。 */
  confidence: "low" | "medium" | "high" | null;
  /** 仮説を確かめる方法（何を観測すれば裏付け・否定できるか）。仮説以外はnull。 */
  verification: string | null;
  /** 仮説は事実、提案は事実・仮説の位置。事実は空。 */
  basedOn: number[];
  basis: IntentExplanationBasisReference[];
};

/** 保存する説明。解釈の対象（観測項目・分析期間）、前回の版、関連Outcomeを持つ。 */
export type IntentExplanation = {
  id: string;
  workspaceId: string;
  intentId: string;
  /** 観測対象。同じIntentの観測項目のkey。 */
  metricKey: string;
  /** 分析期間（`YYYY-MM-DD`の暦日、両端を含む）。 */
  periodStart: string;
  periodEnd: string;
  /** 同じIntent・観測項目の版（1始まり）。 */
  version: number;
  /** 直前の版。初回はnull。 */
  previousId: string | null;
  /** 前回の説明から変わった点（Agentの記述）。初回はnull。 */
  changeFromPrevious: string | null;
  relatedOutcomeIds: string[];
  items: IntentExplanationItem[];
  principalId: string;
  runRef: string;
  requestKey: string;
  createdAt: number;
};

/**
 * 根拠の現在の状態。`current`は原記録が参照時点の最新、`revised`は観測が後から訂正された、`superseded`はSynthesisが新しい版に置き換えられた、
 * `expired`はFindingの有効期限が切れた。原記録が読めない場合は`missing`。
 */
export type IntentExplanationBasisState = "current" | "revised" | "superseded" | "expired" | "missing";

type ResolvedBasisBase = { id: string; state: IntentExplanationBasisState };

/** 根拠を読み取り時に原記録から解決した結果。原記録の値は保存しない。 */
export type ResolvedIntentExplanationBasis =
  | (ResolvedBasisBase & {
      type: "metric_observation";
      detail: { periodStart: string; periodEnd: string; revision: number; status: "observed" | "failed"; value: number | null; failureReason: string | null; sourceName: string; observedAt: number } | null;
    })
  | (ResolvedBasisBase & {
      type: "finding";
      detail: { requestId: string; statement: string; confidence: "low" | "medium" | "high"; observedAt: number; expiresAt: number | null } | null;
    })
  | (ResolvedBasisBase & {
      type: "synthesis";
      detail: { requestId: string; version: number; conclusion: string; validAsOf: number } | null;
    })
  | (ResolvedBasisBase & {
      type: "evaluation";
      detail: { outcomeId: string; result: "achieved" | "failed" | "insufficient_evidence"; method: string; createdAt: number } | null;
    })
  | (ResolvedBasisBase & {
      type: "decision";
      detail: { decisionType: string; judgment: string; outcomeId: string | null; createdAt: number } | null;
    });

export type ResolvedIntentExplanationItem = Omit<IntentExplanationItem, "basis"> & { basis: ResolvedIntentExplanationBasis[] };

export type IntentExplanationRelatedOutcome = { id: string; title: string; status: string };

export type IntentExplanationView = Omit<IntentExplanation, "items" | "relatedOutcomeIds"> & {
  items: ResolvedIntentExplanationItem[];
  relatedOutcomes: IntentExplanationRelatedOutcome[];
  /** 根拠のいずれかが`current`でない、または参照できない。説明が古い可能性を示すだけで、説明の内容の正否は判定しない。 */
  basisOutdated: boolean;
};
