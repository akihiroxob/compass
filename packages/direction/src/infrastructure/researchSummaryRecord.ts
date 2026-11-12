import type { IntentResearchSummary, ResearchRequest, ResearchSynthesis } from "../domain/Research.ts";

/** 取消済みRequestを除く最新系列と、根拠の期限・双方向の矛盾をBriefへまとめる。 */
export const intentResearchSummaryFromRecords = (requests: ResearchRequest[], syntheses: ResearchSynthesis[],
  findings: { id: string; expires_at: number | null }[], conflicts: { finding_id: string; conflicting_finding_id: string }[], now: number): IntentResearchSummary => {
  const open = new Set(requests.filter(({ status }) => status !== "cancelled").map(({ id }) => id));
  const candidates = syntheses.filter(({ requestId }) => open.has(requestId));
  const superseded = new Set(candidates.flatMap(({ supersedesId }) => supersedesId ? [supersedesId] : []));
  const latest = candidates.filter(({ id }) => !superseded.has(id));
  const cited = new Set(latest.flatMap(({ findingIds }) => findingIds));
  const expires = new Map(findings.map((row) => [row.id, row.expires_at]));
  return {
    requests: requests.map(({ id, status, question, budgetTotal, budgetUsed, deadlineAt, createdAt, updatedAt }) => ({ id, status, question, budgetTotal, budgetUsed, deadlineAt, createdAt, updatedAt })),
    syntheses: latest.map((row) => ({ requestId: row.requestId, synthesisId: row.id, version: row.version, conclusion: row.conclusion,
      risks: row.risks, options: row.options, unknowns: row.unknowns, findingIds: row.findingIds, validAsOf: row.validAsOf,
      stale: row.findingIds.some((id) => { const at = expires.get(id); return at !== null && at !== undefined && at <= now; }) })),
    conflicts: conflicts.filter((row) => cited.has(row.finding_id) || cited.has(row.conflicting_finding_id))
      .map((row) => ({ findingId: row.finding_id, conflictsWithFindingId: row.conflicting_finding_id }))
      .sort((a, b) => a.findingId.localeCompare(b.findingId) || a.conflictsWithFindingId.localeCompare(b.conflictsWithFindingId)),
  };
};
