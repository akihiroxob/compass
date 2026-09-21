import type { ResearchResult } from "../../domain/model/Research.ts";
import type { ProjectRepository } from "../../domain/repository/ProjectRepository.ts";
import type { ResearchRepository } from "../../domain/repository/ResearchRepository.ts";
import { parseRegisterResearchResultInput } from "../../shared/researchSchema.ts";
import { ConflictError } from "../error/ConflictError.ts";
import { NotFoundError } from "../error/NotFoundError.ts";
import { ValidationError } from "../error/ValidationError.ts";
import { throwCommonResearchRejection } from "./researchRejection.ts";

/** 調査結果（Result・Finding・Evidence参照）を未終了のRequestへ追記する。Principalとrunの来歴は入力から保存する。 */
export class RegisterResearchResultUseCase {
  constructor(
    private readonly projectRepository: ProjectRepository,
    private readonly researchRepository: ResearchRepository,
  ) {}

  async execute(projectId: string, requestId: string, input: unknown): Promise<ResearchResult> {
    const parsed = parseRegisterResearchResultInput(input);
    if (!(await this.projectRepository.exists(projectId))) {
      throw new NotFoundError(`Project ${projectId} was not found`);
    }
    const result = await this.researchRepository.registerResult(projectId, requestId, parsed);
    throwCommonResearchRejection(result, projectId, requestId);
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
          { path: "findings.conflictsWithFindingIds", message: `unknown finding: ${result.ids.join(", ")}` },
        ]);
      default:
        throw new Error(`Unexpected result: ${result.kind}`);
    }
  }
}
