import { z } from "zod";
import { ConflictError, parseWith } from "@compass/shared";
import { WorkspaceArchivedError, type GetWorkspaceUseCase } from "@compass/organization";
import { workspaceRoles } from "../domain/RoleScope.ts";
import type { WorkspaceGrantRepository, WorkspaceGrantResult, WorkspaceGrant } from "../domain/WorkspaceGrant.ts";
import { principalIdSchema } from "./projectGrantSchema.ts";

export const workspaceGrantSchema = z.object({ principalId: principalIdSchema, role: z.enum(workspaceRoles) }).strict();
const parseGrant = (input: unknown) => parseWith(workspaceGrantSchema, input, "Workspace Grant");

class WorkspaceGrantUseCase {
  constructor(
    protected readonly workspaces: Pick<GetWorkspaceUseCase, "execute">,
    protected readonly grants: WorkspaceGrantRepository,
  ) {}
  protected async requireWorkspace(workspaceId: string): Promise<void> {
    await this.workspaces.execute(workspaceId);
  }
}
export class GrantWorkspaceRoleUseCase extends WorkspaceGrantUseCase {
  async execute(workspaceId: string, input: unknown): Promise<WorkspaceGrantResult> {
    const { principalId, role } = parseGrant(input);
    await this.requireWorkspace(workspaceId);
    const result = await this.grants.grant(workspaceId, principalId, role);
    if (result.kind === "workspace_archived") throw new WorkspaceArchivedError(workspaceId);
    if (result.kind === "principal_bound_elsewhere") {
      throw new ConflictError(`Principal ${principalId} is bound to an Agent Credential of another Workspace or Project`, {
        conflict: "PRINCIPAL_BOUND_ELSEWHERE",
      });
    }
    return { grant: result.grant, created: result.created };
  }
}
export class RevokeWorkspaceRoleUseCase extends WorkspaceGrantUseCase {
  async execute(workspaceId: string, input: unknown): Promise<boolean> {
    const { principalId, role } = parseGrant(input);
    await this.requireWorkspace(workspaceId);
    const result = await this.grants.revoke(workspaceId, principalId, role);
    if (result.kind === "workspace_archived") throw new WorkspaceArchivedError(workspaceId);
    return result.revoked;
  }
}
export class ListWorkspaceGrantsUseCase extends WorkspaceGrantUseCase {
  async execute(workspaceId: string): Promise<WorkspaceGrant[]> {
    await this.requireWorkspace(workspaceId);
    return this.grants.listByWorkspace(workspaceId);
  }
}
