import type {
  DirectionReferenceLookupPort,
  OutcomeReferenceSnapshot,
  RepositoryReference,
} from "../port/DirectionReferenceLookupPort.ts";
import type { OutcomeRepository } from "../../domain/repository/OutcomeRepository.ts";
import type { ProjectRepository } from "../../domain/repository/ProjectRepository.ts";

/** Directionの既存Repository（Outcome・Project）を読むだけの薄いadapter。書き込まない。 */
export class DirectionReferenceLookupService implements DirectionReferenceLookupPort {
  constructor(
    private readonly projectRepository: ProjectRepository,
    private readonly outcomeRepository: OutcomeRepository,
  ) {}

  async getOutcomeSnapshot(projectId: string, outcomeId: string): Promise<OutcomeReferenceSnapshot | null> {
    const outcome = await this.outcomeRepository.findByIdInProject(projectId, outcomeId);
    if (!outcome) return null;
    const project = await this.projectRepository.findById(projectId);
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

  async getRepositoryReference(projectId: string, repositoryId: string): Promise<RepositoryReference | null> {
    const project = await this.projectRepository.findById(projectId);
    const repository = project?.repositories.find((item) => item.id === repositoryId);
    return repository ? { id: repository.id, name: repository.name, url: repository.url } : null;
  }
}
