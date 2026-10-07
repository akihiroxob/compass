import { ProjectRole } from "../domain/ProjectRole.ts";
import type { CredentialScope, RuntimeScope } from "../domain/AccessCredential.ts";
import { ForbiddenError, UnauthenticatedError } from "@compass/shared";
import type { Principal, ProjectAuthorizationService } from "./ProjectAuthorizationService.ts";

/** Agent Credentialで認証した呼出し。Role GrantはprincipalIdで検査する（Principalは`scope`に束縛される）。 */
export type AgentCredentialCaller = { kind: "agent"; credentialId: string; scope: CredentialScope; principalId: string };
/** Runtime Credentialで認証した呼出し。Role Grantを使わず、scopesだけで認可する。 */
export type RuntimeCredentialCaller = {
  kind: "runtime";
  credentialId: string;
  scope: CredentialScope;
  principalId: string;
  scopes: readonly RuntimeScope[];
};

/**
 * 呼出し主体。文字列はtrusted-localのBearer Agent名（自己申告。明示的なlocal開発modeだけ）、nullは認証なし。
 * Human SessionはここにはなくMCP・Runtime向けAPIでは読まない。
 */
export type Caller = Principal | AgentCredentialCaller | RuntimeCredentialCaller;

/** Role Grantで認可する経路（Agent向けtool）のPrincipal。Runtime Credentialは種別違いのためPrincipalなしになる。 */
export const agentPrincipalOf = (caller: Caller): Principal =>
  caller === null || typeof caller === "string" ? caller : caller.kind === "agent" ? caller.principalId : null;

const targetDetails = (target: CredentialScope, scope: RuntimeScope) =>
  target.kind === "workspace" ? { workspaceId: target.id, requiredScope: scope } : { projectId: target.id, requiredScope: scope };

/**
 * 外部Runtime向けの入口（Runtime event・Execution change / Evidence / Summary・Orchestration state）の認可。
 * 戻り値はconsumer（ack・Evidenceの来歴に使うprincipalId）。対象scopeの存在確認より先に呼ぶ。
 * Credentialのscopeと操作対象のscopeが一致する場合だけ許可し、WorkspaceとProjectの間で継承しない。
 */
export class RuntimeAuthorizationService {
  constructor(private readonly projectAuthorization: ProjectAuthorizationService) {}

  /** Project scopeの入口。 */
  async requireScope(caller: Caller, projectId: string, scope: RuntimeScope): Promise<string> {
    // trusted-localのAgent名は、開発用に暫定の`runtime` Role Grantで認可する（remote modeでは名前のBearerを受け付けない）。
    if (typeof caller === "string") return this.projectAuthorization.requireRole(caller, projectId, ProjectRole.RUNTIME);
    return this.requireCredential(caller, { kind: "project", id: projectId }, scope);
  }

  /** Workspace scopeの入口。trusted-localのAgent名にはWorkspaceのruntime Grantが無いため、Runtime Credentialだけを受け付ける。 */
  async requireWorkspaceScope(caller: Caller, workspaceId: string, scope: RuntimeScope): Promise<string> {
    if (typeof caller === "string") {
      throw new ForbiddenError("Workspace Runtime operations require a Workspace Runtime Credential", {
        requiredScope: scope,
        workspaceId,
      });
    }
    return this.requireCredential(caller, { kind: "workspace", id: workspaceId }, scope);
  }

  private requireCredential(caller: Exclude<Caller, string>, target: CredentialScope, scope: RuntimeScope): string {
    if (caller === null) throw new UnauthenticatedError("Authorization: Bearer <Runtime Credential> is required");
    const details = targetDetails(target, scope);
    if (caller.kind !== "runtime") {
      throw new ForbiddenError("An Agent Credential cannot be used for Runtime operations", details);
    }
    // 別scope（別Workspace・別Project、WorkspaceとProjectの違い）のIDは、存在の有無を区別せずFORBIDDEN。
    if (caller.scope.kind !== target.kind || caller.scope.id !== target.id) {
      throw new ForbiddenError(`This Runtime Credential is not valid for this ${target.kind === "workspace" ? "Workspace" : "Project"}`, details);
    }
    if (!caller.scopes.includes(scope)) {
      throw new ForbiddenError(`This Runtime Credential does not have the ${scope} scope`, details);
    }
    return caller.principalId;
  }
}
