import { ProjectRole } from "../../constants/ProjectRole.ts";
import type { RuntimeScope } from "../../domain/model/AccessCredential.ts";
import { ForbiddenError } from "../error/ForbiddenError.ts";
import { UnauthenticatedError } from "../error/UnauthenticatedError.ts";
import type { Principal, ProjectAuthorizationService } from "./ProjectAuthorizationService.ts";

/** Agent Credentialで認証した呼出し。Role GrantはprincipalIdで検査する。 */
export type AgentCredentialCaller = { kind: "agent"; credentialId: string; projectId: string; principalId: string };
/** Runtime Credentialで認証した呼出し。Role Grantを使わず、scopesだけで認可する。 */
export type RuntimeCredentialCaller = {
  kind: "runtime";
  credentialId: string;
  projectId: string;
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

/**
 * 外部Runtime向けの入口（Runtime event・Execution change / Evidence / Summary）の認可。
 * 戻り値はconsumer（ack・Evidenceの来歴に使うprincipalId）。Projectの存在確認より先に呼ぶ。
 */
export class RuntimeAuthorizationService {
  constructor(private readonly projectAuthorization: ProjectAuthorizationService) {}

  async requireScope(caller: Caller, projectId: string, scope: RuntimeScope): Promise<string> {
    if (caller === null) throw new UnauthenticatedError("Authorization: Bearer <Runtime Credential> is required");
    // trusted-localのAgent名は、開発用に暫定の`runtime` Role Grantで認可する（remote modeでは名前のBearerを受け付けない）。
    if (typeof caller === "string") return this.projectAuthorization.requireRole(caller, projectId, ProjectRole.RUNTIME);
    if (caller.kind !== "runtime") {
      throw new ForbiddenError("An Agent Credential cannot be used for Runtime operations", { requiredScope: scope, projectId });
    }
    // 別ProjectのIDは、存在の有無を区別せずFORBIDDEN。
    if (caller.projectId !== projectId) {
      throw new ForbiddenError("This Runtime Credential is not valid for this Project", { requiredScope: scope, projectId });
    }
    if (!caller.scopes.includes(scope)) {
      throw new ForbiddenError(`This Runtime Credential does not have the ${scope} scope`, { requiredScope: scope, projectId });
    }
    return caller.principalId;
  }
}
