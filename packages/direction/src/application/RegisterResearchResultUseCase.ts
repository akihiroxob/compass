import type { ResearchResult } from "../domain/Research.ts";
import type { DirectionWorkspaceReader } from "./port/DirectionWorkspaceReader.ts";
import type { ResearchRepository } from "../domain/ResearchRepository.ts";
import { parseRegisterResearchResultInput } from "./researchSchema.ts";
import { ConflictError, NotFoundError, ValidationError } from "@compass/shared";
import { throwCommonResearchRejection } from "./researchRejection.ts";

/** 調査結果（Result・Finding・Evidence参照）を未終了のRequestへ追記する。Principalとrunの来歴は入力から保存する。 */
export class RegisterResearchResultUseCase {
  constructor(
    private readonly workspaceReader: DirectionWorkspaceReader,
    private readonly researchRepository: ResearchRepository,
  ) {}

  async execute(workspaceId: string, requestId: string, input: unknown): Promise<ResearchResult> {
    const parsed = parseRegisterResearchResultInput(input);
    if (!(await this.workspaceReader.findById(workspaceId))) {
      throw new NotFoundError(`Workspace ${workspaceId} was not found`);
    }
    const result = await this.researchRepository.registerResult(workspaceId, requestId, parsed);
    throwCommonResearchRejection(result, workspaceId, requestId);
    switch (result.kind) {
      case "registered":
        return result.result;
      case "replayed":
        return result.result;
      case "deadline_passed":
        throw new ConflictError(
          `Research Request ${requestId} passed its deadline; close it as insufficient instead of adding results`,
          { deadlineAt: String(result.deadlineAt) },
        );
      case "budget_exceeded":
        throw new ConflictError(
          `Research Request ${requestId} would use ${result.budgetUsed} of a ${result.budgetTotal} budget; close it as insufficient instead`,
          { budgetTotal: String(result.budgetTotal), budgetUsed: String(result.budgetUsed) },
        );
      case "invalid_reference":
        throw new ValidationError("Research Result input is invalid", [
          { path: result.reference === "resource" ? "evidenceRefs.resourceId" : "findings.conflictsWithFindingIds", message: `unknown ${result.reference}: ${result.ids.join(", ")}` },
        ]);
      default:
        throw new Error(`Unexpected result: ${result.kind}`);
    }
  }
}
