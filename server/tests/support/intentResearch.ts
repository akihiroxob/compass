import type { ApplicationServices } from "../../src/bootstrap/createApplicationServices.ts";

/**
 * Intent作成はResearch Requestを作らない（要否はStrategistが判断する）。Research Requestが既にある状態から始めるテスト用に、
 * Intentを発端とするdecision Request（とresearch_requestedイベント）を1件作る。
 */
export const requestIntentResearch = (
  services: Pick<ApplicationServices, "createResearchRequestUseCase">,
  projectId: string,
  intentId: string,
  requestKey = "intent-research",
) =>
  services.createResearchRequestUseCase.execute(projectId, {
    requestKey,
    kind: "decision",
    originIntentId: intentId,
    question: "What do we need to know to decide the first Outcome?",
    scope: "The Intent and the Project's Mission, Principles and Constraints.",
    completionCondition: "The Strategist can decide the first Outcome or additional Research.",
    budgetTotal: 100,
  });
