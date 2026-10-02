import type { ResearchSynthesis } from "../../domain/model/Research.ts";
import type { ProjectRepository } from "../../domain/repository/ProjectRepository.ts";
import type { ResearchRepository } from "../../domain/repository/ResearchRepository.ts";
import { parseRegisterResearchSynthesisInput } from "../../shared/researchSchema.ts";
import { ConflictError } from "../error/ConflictError.ts";
import { NotFoundError } from "../error/NotFoundError.ts";
import { ValidationError } from "../error/ValidationError.ts";
import { throwCommonResearchRejection } from "./researchRejection.ts";

/** Findingを圧縮したSynthesisを追記する。`supersedesId`を指定すると上書きせず次のversionを作る。 */
export class RegisterResearchSynthesisUseCase {
  constructor(
    private readonly projectRepository: ProjectRepository,
    private readonly researchRepository: ResearchRepository,
  ) {}

  async execute(projectId: string, requestId: string, input: unknown): Promise<ResearchSynthesis> {
    const parsed = parseRegisterResearchSynthesisInput(input);
    if (!(await this.projectRepository.exists(projectId))) {
      throw new NotFoundError(`Project ${projectId} was not found`);
    }
    const result = await this.researchRepository.registerSynthesis(projectId, requestId, parsed);
    throwCommonResearchRejection(result, projectId, requestId);
    switch (result.kind) {
      case "registered":
        return result.synthesis;
      case "replayed":
        return result.synthesis;
      case "deadline_passed":
        throw new ConflictError(
          `Research Request ${requestId} passed its deadline; close it as insufficient instead of adding a synthesis`,
          { deadlineAt: String(result.deadlineAt) },
        );
      case "invalid_reference":
        throw new ValidationError("Research Synthesis input is invalid", [
          {
            path: result.reference === "finding" ? "findingIds" : "supersedesId",
            message: `unknown ${result.reference}: ${result.ids.join(", ")}`,
          },
        ]);
      case "already_superseded":
        throw new ConflictError(
          `Research Synthesis ${result.supersedesId} was already superseded by ${result.supersededById}`,
          { supersedesId: result.supersedesId, supersededById: result.supersededById },
        );
      default:
        throw new Error(`Unexpected result: ${result.kind}`);
    }
  }
}
