// 目標（Intent）の観測についてのAgentの説明。API応答の型と、表示用の純関数（観測の状態・根拠の鮮度の文言、版の整理）。
import type { StatusTone } from "../../statusTone";

export type ExplanationItemKind = "fact" | "hypothesis" | "proposal";
export type MetricState = "unmeasured" | "failed" | "stale" | "observed";
export type BasisState = "current" | "revised" | "superseded" | "expired" | "missing";

export type ExplanationBasis =
  | { type: "metric_observation"; id: string; state: BasisState; detail: { periodStart: string; periodEnd: string; revision: number; status: "observed" | "failed"; value: number | null; failureReason: string | null; sourceName: string; observedAt: number } | null }
  | { type: "finding"; id: string; state: BasisState; detail: { requestId: string; statement: string; confidence: string; observedAt: number; expiresAt: number | null } | null }
  | { type: "synthesis"; id: string; state: BasisState; detail: { requestId: string; version: number; conclusion: string; validAsOf: number } | null }
  | { type: "evaluation"; id: string; state: BasisState; detail: { outcomeId: string; result: "achieved" | "failed" | "insufficient_evidence"; method: string; createdAt: number } | null }
  | { type: "decision"; id: string; state: BasisState; detail: { decisionType: string; judgment: string; outcomeId: string | null; createdAt: number } | null };

export type ExplanationItem = {
  position: number;
  kind: ExplanationItemKind;
  statement: string;
  confidence: "low" | "medium" | "high" | null;
  verification: string | null;
  basedOn: number[];
  basis: ExplanationBasis[];
};

export type IntentExplanation = {
  id: string;
  intentId: string;
  metricKey: string;
  periodStart: string;
  periodEnd: string;
  version: number;
  previousId: string | null;
  changeFromPrevious: string | null;
  items: ExplanationItem[];
  relatedOutcomes: { id: string; title: string; status: string }[];
  basisOutdated: boolean;
  principalId: string;
  createdAt: number;
};

export type ExplanationMetric = { key: string; name: string; unit: string; state: MetricState; lastObservedPeriodEnd: string | null };

export type IntentExplanations = { intentId: string; observedAt: number; metrics: ExplanationMetric[]; explanations: IntentExplanation[] };

export const metricStateLabels: Record<MetricState, { label: string; tone: StatusTone }> = {
  unmeasured: { label: "未計測", tone: "muted" },
  failed: { label: "取得失敗", tone: "warning" },
  stale: { label: "観測が古い", tone: "warning" },
  observed: { label: "観測あり", tone: "progress" },
};

export const itemKindLabels: Record<ExplanationItemKind, string> = { fact: "事実", hypothesis: "原因の仮説", proposal: "次の提案" };

export const confidenceLabels = { low: "確からしさ 低", medium: "確からしさ 中", high: "確からしさ 高" } as const;

/** 古くなった根拠の理由。`current`は表示しない。 */
export const basisStateLabels: Record<Exclude<BasisState, "current">, string> = {
  revised: "後から訂正された観測",
  superseded: "新しい版に置き換えられた調査",
  expired: "有効期限が切れた調査結果",
  missing: "原記録を読み込めません",
};

export const evaluationResultLabels = { achieved: "達成", failed: "未達", insufficient_evidence: "判断不能" } as const;

/** 位置から項目を指す表示名（例: 事実1）。同じ種別内の通し番号。 */
export const itemReferenceLabel = (items: ExplanationItem[], position: number): string => {
  const item = items[position];
  if (!item) return "不明な項目";
  const ordinal = items.slice(0, position + 1).filter((candidate) => candidate.kind === item.kind).length;
  return `${itemKindLabels[item.kind]}${ordinal}`;
};

/** 観測項目ごとの最新の版（新しい順の入力の先頭）と、それより前の版。 */
export const splitExplanationVersions = (explanations: IntentExplanation[]): { latest: IntentExplanation[]; earlier: IntentExplanation[] } => {
  const latestKeys = new Map<string, IntentExplanation>();
  for (const explanation of explanations) {
    const current = latestKeys.get(explanation.metricKey);
    if (!current || explanation.version > current.version) latestKeys.set(explanation.metricKey, explanation);
  }
  const latest = [...latestKeys.values()].sort((a, b) => b.createdAt - a.createdAt);
  return { latest, earlier: explanations.filter((explanation) => latestKeys.get(explanation.metricKey) !== explanation) };
};

const dateRange = (start: string, end: string) => (start === end ? start : `${start}〜${end}`);

export const explanationPeriod = (explanation: Pick<IntentExplanation, "periodStart" | "periodEnd">) => dateRange(explanation.periodStart, explanation.periodEnd);

export const observationSummary = (basis: Extract<ExplanationBasis, { type: "metric_observation" }>, unit: string | null): string => {
  if (!basis.detail) return "観測値";
  const { detail } = basis;
  const period = dateRange(detail.periodStart, detail.periodEnd);
  const value = detail.status === "failed" ? `取得失敗（${detail.failureReason ?? "理由不明"}）` : `${detail.value?.toLocaleString("ja-JP")}${unit ?? ""}`;
  return `観測 ${period} ${value}（${detail.sourceName}・版${detail.revision}）`;
};
