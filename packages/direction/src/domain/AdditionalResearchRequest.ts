/** 同じDecisionからは常に同じkeyになる。DBのunique indexと合わさり、Decisionごとに追加Requestを1件に収束させる。 */
export const additionalResearchRequestKey = (decisionId: string): string => `additional-research:${decisionId}`;

/** Decision・追加Research Request・`research_requested` / `research_completed`イベントを結ぶ相関ID。 */
export const additionalResearchCorrelationId = (decisionId: string): string => `decision:${decisionId}`;
