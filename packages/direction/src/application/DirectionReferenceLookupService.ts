import type { OutcomeRepository } from "../domain/OutcomeRepository.ts";
import type { OutcomeTargetProjectRepository } from "../domain/OutcomeTargetProject.ts";
import type { DirectionProjectReader } from "./port/DirectionProjectReader.ts";

/**
 * Directionの既存Repository（Outcome・Target・Project）を読むだけの薄いadapter。書き込まない。
 * Workが要求する`DirectionReferenceLookupPort`を構造的に満たし、serverが配線する（DirectionはWorkをimportしない）。
 * OutcomeはWorkspace所有、Repository・ConstraintsはProjectとその所属Workspaceから読む。
 */
export class DirectionReferenceLookupService {
  constructor(
    private readonly projectReader: DirectionProjectReader,
    private readonly outcomeRepository: Pick<OutcomeRepository, "findByIdInWorkspace">,
    private readonly targetRepository: Pick<OutcomeTargetProjectRepository, "listByOutcome">,
  ) {}

  async getProjectExecutionContext(projectId: string) {
    const project = await this.projectReader.findDetailById(projectId);
    if (!project) return null;
    return {
      projectId: project.id,
      workspaceId: project.workspaceId,
      constraints: [...project.constraints],
      repositories: project.repositories.map((repository) => ({ id: repository.id, name: repository.name, url: repository.url })),
    };
  }

  async getOutcomeSnapshot(workspaceId: string, outcomeId: string) {
    const outcome = await this.outcomeRepository.findByIdInWorkspace(workspaceId, outcomeId);
    if (!outcome) return null;
    const targets = (await this.targetRepository.listByOutcome(workspaceId, outcomeId)) ?? [];
    return {
      outcomeId: outcome.id,
      intentId: outcome.intentId,
      title: outcome.title,
      description: outcome.description,
      hypothesis: outcome.hypothesis,
      originDecisionId: outcome.originDecisionId,
      status: outcome.status,
      successCriteria: outcome.successCriteria.map((criterion) => ({
        id: criterion.id,
        position: criterion.position,
        description: criterion.description,
        measurement: criterion.measurement,
        target: criterion.target,
      })),
      targetProjectIds: targets.map((target) => target.projectId),
    };
  }
}
