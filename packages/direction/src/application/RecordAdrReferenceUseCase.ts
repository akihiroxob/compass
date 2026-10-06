import type { AdrReference } from "../domain/AdrHandoff.ts";
import type { AdrHandoffRepository } from "../domain/AdrHandoffRepository.ts";
import type { DirectionWorkspaceReader } from "./port/DirectionWorkspaceReader.ts";
import { parseRecordAdrReferenceInput } from "./adrHandoffSchema.ts";
import { NotFoundError } from "@compass/shared";
import { throwAdrHandoffRejection } from "./adrHandoffRejection.ts";

/**
 * Wachaが完了させたADR作成結果（相対path・完全なcommit SHA・任意のPR URL）を取り込み、Workspace scopeの参照として
 * 保存する（artifactのProject/Repositoryを明示する）。対応する`AdrHandoffRequest`が同じDecision・Repository・correlationIdで存在しない参照は受け付けない
 * （依頼を経ていない参照や、無関係なcorrelationIdの取り違えを拒否する）。
 */
export class RecordAdrReferenceUseCase {
  constructor(
    private readonly workspaceReader: DirectionWorkspaceReader,
    private readonly adrHandoffRepository: AdrHandoffRepository,
  ) {}

  async execute(workspaceId: string, principalId: string, input: unknown): Promise<AdrReference> {
    const parsed = parseRecordAdrReferenceInput(input);
    if (!(await this.workspaceReader.findById(workspaceId))) {
      throw new NotFoundError(`Workspace ${workspaceId} was not found`);
    }
    const result = await this.adrHandoffRepository.recordReference(workspaceId, { ...parsed, principalId });
    if (result.kind === "created" || result.kind === "replayed") return result.reference;
    throwAdrHandoffRejection(result, workspaceId, parsed.projectId);
    throw new Error(`Unexpected result: ${result.kind}`);
  }
}
