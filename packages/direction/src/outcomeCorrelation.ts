/**
 * DirectionがExecutionへ渡す（Outcome起点の）相関ID。`outcome_confirmed`イベントと`issue_story`の既定値で同じ規則を使う。
 * DirectionとExecutionの双方が依存する、境界上の取り決めだけを置く（どちらのEntityにも依存しない）。
 */
export const outcomeCorrelationId = (outcomeId: string): string => `outcome:${outcomeId}`;
