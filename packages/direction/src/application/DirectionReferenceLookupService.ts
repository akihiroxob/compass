import type { OutcomeRepository } from "../domain/OutcomeRepository.ts";
import type { DirectionProjectReader } from "./port/DirectionProjectReader.ts";

/**
 * Directionの既存Repository（Outcome・Project）を読むだけの薄いadapter。書き込まない。
 * Workが要求する`DirectionReferenceLookupPort`を構造的に満たし、serverが配線する（DirectionはWorkをimportしない）。
 */
export class DirectionReferenceLookupService {
  constructor(
    private readonly projectReader: DirectionProjectReader,
    private readonly outcomeRepository: OutcomeRepository,
  ) {}

  async getOutcomeSnapshot(projectId: string, outcomeId: string) {
    const outcome = await this.outcomeRepository.findByIdInProject(projectId, outcomeId);
    if (!outcome) return null;
    const project = await this.projectReader.findDetailById(projectId);
    if (!project) return null;
    return {
      outcomeId: outcome.id,
      originDecisionId: outcome.originDecisionId,
      status: outcome.status,
      successCriteria: outcome.successCriteria.map((criterion) => ({
        id: criterion.id,
        position: criterion.position,
        description: criterion.description,
        measurement: criterion.measurement,
        target: criterion.target,
      })),
      constraints: [...project.constraints],
    };
  }

  async getRepositoryReference(projectId: string, repositoryId: string) {
    const project = await this.projectReader.findDetailById(projectId);
    const repository = project?.repositories.find((item) => item.id === repositoryId);
    return repository ? { id: repository.id, name: repository.name, url: repository.url } : null;
  }
}
