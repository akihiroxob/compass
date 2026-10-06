import type { AdrHandoffRequest } from "../domain/AdrHandoff.ts";
import type { AdrHandoffRepository } from "../domain/AdrHandoffRepository.ts";
import type { DirectionWorkspaceReader } from "./port/DirectionWorkspaceReader.ts";
import { parseCreateAdrHandoffRequestInput } from "./adrHandoffSchema.ts";
import { NotFoundError } from "@compass/shared";
import { throwAdrHandoffRejection } from "./adrHandoffRejection.ts";

/**
 * `adr_candidate` Direction DecisionとProjectに登録済みのRepositoryから、Wachaへの依頼payloadをfixtureとして
 * 組み立てて保存する。Decision・Repositoryの存在・整合検証と、requestKeyの冪等性はrepositoryのtransactionが持つ。
 */
export class CreateAdrHandoffRequestUseCase {
  constructor(
    private readonly workspaceReader: DirectionWorkspaceReader,
    private readonly adrHandoffRepository: AdrHandoffRepository,
  ) {}

  async execute(workspaceId: string, principalId: string, input: unknown): Promise<AdrHandoffRequest> {
    const parsed = parseCreateAdrHandoffRequestInput(input);
    if (!(await this.workspaceReader.findById(workspaceId))) {
      throw new NotFoundError(`Workspace ${workspaceId} was not found`);
    }
    const result = await this.adrHandoffRepository.createRequest(workspaceId, { ...parsed, principalId });
    if (result.kind === "created" || result.kind === "replayed") return result.request;
    throwAdrHandoffRejection(result, workspaceId, parsed.projectId);
    throw new Error(`Unexpected result: ${result.kind}`);
  }
}
