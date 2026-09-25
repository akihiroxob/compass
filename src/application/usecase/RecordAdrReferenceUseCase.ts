import type { AdrReference } from "../../domain/model/AdrHandoff.ts";
import type { AdrHandoffRepository } from "../../domain/repository/AdrHandoffRepository.ts";
import type { ProjectRepository } from "../../domain/repository/ProjectRepository.ts";
import { parseRecordAdrReferenceInput } from "../../shared/adrHandoffSchema.ts";
import { NotFoundError } from "../error/NotFoundError.ts";
import { throwAdrHandoffRejection } from "./adrHandoffRejection.ts";

/**
 * Wachaが完了させたADR作成結果（相対path・完全なcommit SHA・任意のPR URL）を取り込み、Project scopeの参照として
 * 保存する。対応する`AdrHandoffRequest`が同じDecision・Repository・correlationIdで存在しない参照は受け付けない
 * （依頼を経ていない参照や、無関係なcorrelationIdの取り違えを拒否する）。
 */
export class RecordAdrReferenceUseCase {
  constructor(
    private readonly projectRepository: ProjectRepository,
    private readonly adrHandoffRepository: AdrHandoffRepository,
  ) {}

  async execute(projectId: string, principalId: string, input: unknown): Promise<AdrReference> {
    const parsed = parseRecordAdrReferenceInput(input);
    if (!(await this.projectRepository.exists(projectId))) {
      throw new NotFoundError(`Project ${projectId} was not found`);
    }
    const result = await this.adrHandoffRepository.recordReference(projectId, { ...parsed, principalId });
    if (result.kind === "created" || result.kind === "replayed") return result.reference;
    throwAdrHandoffRejection(result, projectId);
    throw new Error(`Unexpected result: ${result.kind}`);
  }
}
