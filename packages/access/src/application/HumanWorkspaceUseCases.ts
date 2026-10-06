import type { HumanActor, HumanRole, HumanWorkspaceOperation } from "../domain/HumanAuth.ts";
import type {
  CreateWorkspaceProjectUseCase,
  GetWorkspaceUseCase,
  ListWorkspacesUseCase,
  ProjectDetail,
  Workspace,
  WorkspaceStatus,
} from "@compass/organization";
import type { WorkspaceMembershipRepository } from "../domain/WorkspaceMembershipRepository.ts";
import type { HumanWorkspaceAuthorizationService } from "./HumanWorkspaceAuthorizationService.ts";

type WorkspaceScopedUseCase<Args extends unknown[], Result> = {
  execute(workspaceId: string, ...args: Args): Promise<Result>;
};

/**
 * Human向けの入口から呼ぶWorkspace単位のuse case。Workspace Membershipの認可（domainの権限表）を通してから、
 * Organization・Directionの既存use caseへ委譲する。認可の順序は、Membership（未所属・不在は404、Role不足は403）→
 * 委譲先の検証（archived・入力）。
 */
export class HumanWorkspaceAuthorizedUseCase<Args extends unknown[], Result> {
  constructor(
    private readonly authorization: HumanWorkspaceAuthorizationService,
    private readonly operation: HumanWorkspaceOperation,
    private readonly useCase: WorkspaceScopedUseCase<Args, Result>,
  ) {}

  async execute(actor: HumanActor, workspaceId: string, ...args: Args): Promise<Result> {
    await this.authorization.authorize(actor, workspaceId, this.operation);
    return this.useCase.execute(workspaceId, ...args);
  }
}

/** 有効なMembershipを持つWorkspaceだけを返す（絞り込み・更新日時の降順はOrganizationのuse caseに従う）。 */
export class ListHumanWorkspacesUseCase {
  constructor(
    private readonly listWorkspacesUseCase: ListWorkspacesUseCase,
    private readonly membershipRepository: WorkspaceMembershipRepository,
  ) {}

  async execute(actor: HumanActor, status: WorkspaceStatus = "active"): Promise<Workspace[]> {
    const workspaceIds = new Set(await this.membershipRepository.listActiveWorkspaceIds(actor.humanUserId));
    const workspaces = await this.listWorkspacesUseCase.execute(status);
    return workspaces.filter((workspace) => workspaceIds.has(workspace.id));
  }
}

/** Workspace詳細と、UIの導線切替に使う自分のRole（`myRole`）。拒否は常にserverの権限表で行う。 */
export class GetHumanWorkspaceUseCase {
  constructor(
    private readonly authorization: HumanWorkspaceAuthorizationService,
    private readonly getWorkspaceUseCase: GetWorkspaceUseCase,
  ) {}

  async execute(actor: HumanActor, workspaceId: string): Promise<{ workspace: Workspace; myRole: HumanRole }> {
    const membership = await this.authorization.authorize(actor, workspaceId, "workspace.read");
    return { workspace: await this.getWorkspaceUseCase.execute(workspaceId), myRole: membership.role };
  }
}

/** 既存のWorkspaceへのProject作成（administrator以上）。作成者はProjectのownerになり、WorkspaceのMembershipは変えない。 */
export class CreateHumanWorkspaceProjectUseCase {
  constructor(
    private readonly authorization: HumanWorkspaceAuthorizationService,
    private readonly createWorkspaceProjectUseCase: CreateWorkspaceProjectUseCase,
  ) {}

  async execute(actor: HumanActor, workspaceId: string, input: unknown): Promise<ProjectDetail> {
    await this.authorization.authorize(actor, workspaceId, "project.create");
    return this.createWorkspaceProjectUseCase.execute(workspaceId, input, actor);
  }
}
