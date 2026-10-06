import type { Intent } from "../domain/Intent.ts";
import type { ProjectDetail } from "@compass/organization";
import type {
  EvidenceReference,
  ResearchFinding,
  ResearchRequest,
  ResearchResult,
  ResearchSynthesis,
} from "../domain/Research.ts";
import type { ProjectIntentReader } from "./port/ProjectDirectionReaders.ts";
import type { DirectionProjectReader } from "./port/DirectionProjectReader.ts";
import type { ResearchRepository } from "../domain/ResearchRepository.ts";
import { NotFoundError } from "@compass/shared";
import { DirectionAgentRole, type DirectionRoleAuthorizationPort, type Principal } from "./port/DirectionAuthorizationPort.ts";

/** 未実装で、Researcherが存在を仮定・捏造してはならない入力。 */
export const unavailableResearcherInputs = ["evaluation"] as const;

/** 関連Findingとして返す最大件数。全Researchを無制限に返さず、詳細はRequest単位の取得で辿る。 */
export const relatedFindingLimit = 50;

export type ResearcherContext = {
  principalId: string;
  role: DirectionAgentRole;
  /** Mission / Vision / Principles / Constraints / Repositories / Resources を含むProjectの現在の姿。Researcherは変更できない。 */
  project: ProjectDetail;
  request: ResearchRequest;
  /** 発端のIntent。project_watchはnull。 */
  originIntent: Intent | null;
  /** 予算の単位はRuntimeが定める。`remaining`が0でも新しいResult（予算0）とinsufficientでの確定はできる。 */
  budget: { total: number; used: number; remaining: number };
  /** このRequestに既に登録されたResult（Finding・Evidence参照を含む）。再開時に重複調査を避ける根拠。 */
  results: readonly ResearchResult[];
  syntheses: readonly ResearchSynthesis[];
  /** 同じ発端の他Requestが残したFindingと、その引用Evidence参照。新しい順で最大`relatedFindingLimit`件。 */
  relatedFindings: readonly ResearchFinding[];
  relatedEvidenceRefs: readonly EvidenceReference[];
  unavailable: readonly string[];
};

/** Researcherが調査を始めるために必要な入力を、Humanの承認や画面操作なしで1回で返す。 */
export class GetResearcherContextUseCase {
  constructor(
    private readonly authorization: DirectionRoleAuthorizationPort,
    private readonly projectReader: DirectionProjectReader,
    private readonly intentRepository: ProjectIntentReader,
    private readonly researchRepository: ResearchRepository,
  ) {}

  async execute(principal: Principal, projectId: string, requestId: string): Promise<ResearcherContext> {
    const principalId = await this.authorization.requireRole(principal, projectId, DirectionAgentRole.RESEARCHER);
    const project = await this.projectReader.findDetailById(projectId);
    if (!project) throw new NotFoundError(`Project ${projectId} was not found`);
    const detail = await this.researchRepository.findRequestDetail(projectId, requestId);
    if (!detail) throw new NotFoundError(`Research Request ${requestId} was not found in Project ${projectId}`);
    const { request } = detail;
    const originIntent = request.originIntentId
      ? await this.intentRepository.findById(projectId, request.originIntentId)
      : null;
    const related = await this.researchRepository.findRelatedFindings(projectId, requestId, relatedFindingLimit);
    return {
      principalId,
      role: DirectionAgentRole.RESEARCHER,
      project,
      request,
      originIntent,
      budget: {
        total: request.budgetTotal,
        used: request.budgetUsed,
        remaining: Math.max(0, request.budgetTotal - request.budgetUsed),
      },
      results: detail.results,
      syntheses: detail.syntheses,
      relatedFindings: related.findings,
      relatedEvidenceRefs: related.evidenceRefs,
      unavailable: unavailableResearcherInputs,
    };
  }
}
