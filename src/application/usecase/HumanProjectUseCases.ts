import type { HumanActor, HumanProjectOperation, HumanRole } from "../../domain/model/HumanAuth.ts";
import type { Project, ProjectStatus } from "../../domain/model/Project.ts";
import type { ProjectMembershipRepository } from "../../domain/repository/ProjectMembershipRepository.ts";
import type { ProjectRepository } from "../../domain/repository/ProjectRepository.ts";
import type { HumanProjectAuthorizationService } from "../service/HumanProjectAuthorizationService.ts";
import type { GetProjectUseCase } from "./GetProjectUseCase.ts";

type ProjectScopedUseCase<Args extends unknown[], Result> = {
  execute(projectId: string, ...args: Args): Promise<Result>;
};

/**
 * Human向けの入口（Web API）から呼ぶProject単位のuse case。Membershipの認可（domainの権限表）を通してから、
 * MCPと共通の既存use caseへ委譲する。業務規則は委譲先に1つだけ置き、入口ごとに重複させない。
 * 認可の順序は、Membership（未所属・不在は404、Role不足は403）→ 既存use caseの検証（子ID・archived・入力）。
 */
export class HumanAuthorizedUseCase<Args extends unknown[], Result> {
  constructor(
    private readonly authorization: HumanProjectAuthorizationService,
    private readonly operation: HumanProjectOperation,
    private readonly useCase: ProjectScopedUseCase<Args, Result>,
  ) {}

  async execute(actor: HumanActor, projectId: string, ...args: Args): Promise<Result> {
    await this.authorization.authorize(actor, projectId, this.operation);
    return this.useCase.execute(projectId, ...args);
  }
}

/** 有効なMembershipを持つProjectだけを返す（active / archivedの絞り込みは既存どおり）。 */
export class ListHumanProjectsUseCase {
  constructor(
    private readonly projectRepository: ProjectRepository,
    private readonly membershipRepository: ProjectMembershipRepository,
  ) {}

  async execute(actor: HumanActor, status: ProjectStatus = "active"): Promise<Project[]> {
    const projectIds = new Set(await this.membershipRepository.listActiveProjectIds(actor.humanUserId));
    const projects = await this.projectRepository.findAll(status);
    return projects.filter((project) => projectIds.has(project.id)).sort((a, b) => b.updatedAt - a.updatedAt);
  }
}

/** Project詳細と、UIの導線切替に使う自分のRole（`myRole`）。拒否は常にserverの権限表で行う。 */
export class GetHumanProjectUseCase {
  constructor(
    private readonly authorization: HumanProjectAuthorizationService,
    private readonly getProjectUseCase: GetProjectUseCase,
  ) {}

  async execute(actor: HumanActor, projectId: string): Promise<{ project: Project; myRole: HumanRole }> {
    const membership = await this.authorization.authorize(actor, projectId, "project.read");
    return { project: await this.getProjectUseCase.execute(projectId), myRole: membership.role };
  }
}
