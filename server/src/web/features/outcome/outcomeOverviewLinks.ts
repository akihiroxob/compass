import { consultationPath, workspaceConsultationPath } from "../../paths.ts";
import type { OutcomeProblemFact } from "./outcomeOverview.ts";

/** 問題（相談）の詳細。Project scopeはその相談のProject、Workspace scopeはWorkspaceの対応待ちから開く。 */
export const consultationDestination = (workspaceId: string, problem: OutcomeProblemFact): string =>
  problem.scope === "project" && problem.projectIds[0]
    ? consultationPath(problem.projectIds[0], problem.consultationId)
    : workspaceConsultationPath(workspaceId, problem.consultationId);
