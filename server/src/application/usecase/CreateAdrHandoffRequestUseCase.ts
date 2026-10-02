import type { AdrHandoffRequest } from "../../domain/model/AdrHandoff.ts";
import type { AdrHandoffRepository } from "../../domain/repository/AdrHandoffRepository.ts";
import type { ProjectRepository } from "../../domain/repository/ProjectRepository.ts";
import { parseCreateAdrHandoffRequestInput } from "../../shared/adrHandoffSchema.ts";
import { NotFoundError } from "../error/NotFoundError.ts";
import { throwAdrHandoffRejection } from "./adrHandoffRejection.ts";

/**
 * `adr_candidate` Direction DecisionとProjectに登録済みのRepositoryから、Wachaへの依頼payloadをfixtureとして
 * 組み立てて保存する。Decision・Repositoryの存在・整合検証と、requestKeyの冪等性はrepositoryのtransactionが持つ。
 */
export class CreateAdrHandoffRequestUseCase {
  constructor(
    private readonly projectRepository: ProjectRepository,
    private readonly adrHandoffRepository: AdrHandoffRepository,
  ) {}

  async execute(projectId: string, principalId: string, input: unknown): Promise<AdrHandoffRequest> {
    const parsed = parseCreateAdrHandoffRequestInput(input);
    if (!(await this.projectRepository.exists(projectId))) {
      throw new NotFoundError(`Project ${projectId} was not found`);
    }
    const result = await this.adrHandoffRepository.createRequest(projectId, { ...parsed, principalId });
    if (result.kind === "created" || result.kind === "replayed") return result.request;
    throwAdrHandoffRejection(result, projectId);
    throw new Error(`Unexpected result: ${result.kind}`);
  }
}
