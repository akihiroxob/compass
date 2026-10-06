import type { Intent } from "../domain/Intent.ts";
import type { Workspace } from "@compass/organization";
import type {
  EvidenceReference,
  ResearchFinding,
  ResearchRequest,
  ResearchResult,
  ResearchSynthesis,
} from "../domain/Research.ts";
import type { IntentRepository } from "../domain/IntentRepository.ts";
import type { DirectionWorkspaceReader } from "./port/DirectionWorkspaceReader.ts";
import type { ResearchRepository } from "../domain/ResearchRepository.ts";
import { NotFoundError } from "@compass/shared";
import { DirectionAgentRole } from "./port/DirectionAuthorizationPort.ts";

/** 未実装で、Researcherが存在を仮定・捏造してはならない入力。 */
export const unavailableResearcherInputs = ["evaluation"] as const;

/** 関連Findingとして返す最大件数。全Researchを無制限に返さず、詳細はRequest単位の取得で辿る。 */
export const relatedFindingLimit = 50;
export const researcherHistoryLimit = 10;

export type ResearcherContext = {
  principalId: string;
  role: DirectionAgentRole;
  /** Mission / Vision / Principles / Constraints を含むWorkspaceの現在の姿。Researcherは変更できない。 */
  workspace: Workspace;
  request: ResearchRequest;
  /** 発端のIntent。project_watchはnull。 */
  originIntent: Intent | null;
  /** 予算の単位はRuntimeが定める。`remaining`が0でも新しいResult（予算0）とinsufficientでの確定はできる。 */
  budget: { total: number; used: number; remaining: number };
  /** このRequestに既に登録された最新10件のResult（Finding・Evidence参照を含む）。再開時に重複調査を避ける根拠。 */
  results: readonly ResearchResult[];
  syntheses: readonly ResearchSynthesis[];
  /** 同じ発端の他Requestが残したFindingと、その引用Evidence参照。新しい順で最大`relatedFindingLimit`件。 */
  relatedFindings: readonly ResearchFinding[];
  relatedEvidenceRefs: readonly EvidenceReference[];
  history: { resultCount: number; synthesisCount: number; truncated: boolean };
  unavailable: readonly string[];
};

/** Researcherが調査を始めるために必要な入力を、Humanの承認や画面操作なしで1回で返す。 */
export class GetResearcherContextUseCase {
  constructor(
    private readonly workspaceReader: DirectionWorkspaceReader,
    private readonly intentRepository: IntentRepository,
    private readonly researchRepository: Pick<ResearchRepository, "findRequests" | "findRequestDetail" | "findIntentResearchSummary" | "findRelatedFindings">,
  ) {}

  async execute(principalId: string, workspaceId: string, requestId: string): Promise<ResearcherContext> {
    const workspace = await this.workspaceReader.findById(workspaceId);
    if (!workspace) throw new NotFoundError(`Workspace ${workspaceId} was not found`);
    const detail = await this.researchRepository.findRequestDetail(workspaceId, requestId);
    if (!detail) throw new NotFoundError(`Research Request ${requestId} was not found in Workspace ${workspaceId}`);
    const { request } = detail;
    const originIntent = request.originIntentId
      ? await this.intentRepository.findById(workspaceId, request.originIntentId)
      : null;
    const related = await this.researchRepository.findRelatedFindings(workspaceId, requestId, relatedFindingLimit);
    return {
      principalId,
      role: DirectionAgentRole.RESEARCHER,
      workspace,
      request,
      originIntent,
      budget: {
        total: request.budgetTotal,
        used: request.budgetUsed,
        remaining: Math.max(0, request.budgetTotal - request.budgetUsed),
      },
      results: detail.results.slice(-researcherHistoryLimit),
      syntheses: detail.syntheses.slice(-researcherHistoryLimit),
      history: { resultCount: detail.results.length, synthesisCount: detail.syntheses.length,
        truncated: detail.results.length > researcherHistoryLimit || detail.syntheses.length > researcherHistoryLimit },
      relatedFindings: related.findings,
      relatedEvidenceRefs: related.evidenceRefs,
      unavailable: unavailableResearcherInputs,
    };
  }
}
