import type { ResearchRequestDetail } from "../research";
import type { EvidenceFormValue } from "./outcome";

/** 課題へ関連付けられる根拠の候補。Researchの依頼（質問）ごとにまとめる。 */
export type EvidenceOptionGroup = { requestId: string; question: string; options: EvidenceFormValue[] };

/**
 * 同じWorkspaceのResearchから根拠の候補を作る。Findingは全件、Synthesisは後の版に置き換えられていない最新版だけを候補にする
 * （古い版の関連付けはserverも拒否する）。候補が無い依頼は除く。
 */
export const evidenceOptionGroups = (details: readonly ResearchRequestDetail[]): EvidenceOptionGroup[] =>
  details.flatMap(({ request, results, syntheses }) => {
    const superseded = new Set(syntheses.flatMap(({ supersedesId }) => (supersedesId ? [supersedesId] : [])));
    const options: EvidenceFormValue[] = [
      ...syntheses
        .filter(({ id }) => !superseded.has(id))
        .map((synthesis) => ({ kind: "research_synthesis" as const, id: synthesis.id, requestId: request.id, summary: synthesis.conclusion })),
      ...results.flatMap(({ findings }) => findings.map((finding) => ({ kind: "research_finding" as const, id: finding.id, requestId: request.id, summary: finding.statement }))),
    ];
    return options.length === 0 ? [] : [{ requestId: request.id, question: request.question, options }];
  });

/** Selectのvalue。kindとidの組で一意にする。 */
export const evidenceKey = (evidence: Pick<EvidenceFormValue, "kind" | "id">) => `${evidence.kind}:${evidence.id}`;
