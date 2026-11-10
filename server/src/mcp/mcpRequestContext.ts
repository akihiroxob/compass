import { agentPrincipalOf, ProjectRole, type Caller } from "@compass/access";
import type { AuthMode } from "../auth/humanAuthConfig.ts";
import type { OperationServices } from "../application/ApplicationServices.ts";
import { execute } from "./toolExecution.ts";

export const createMcpRequestContext = (services: OperationServices, caller: Caller, options: { mode?: AuthMode }) => {
  const remote = options.mode === "remote";
  const principal = agentPrincipalOf(caller);
  const authorization = services.projectAuthorizationService;
  const runtimeAuthorization = services.runtimeAuthorizationService;
  const roleScope = services.roleScopeAuthorizationService;
  const workspaceScope = (workspaceId: string) => ({ kind: "workspace" as const, id: workspaceId });
  // Project参照・一覧はremote modeまたはactiveRole指定時にGrantを要求する（activeRole指定時はそのRoleのGrantだけ）。
  // trusted-localのheaderなしは互換のためGrantを問わない。
  const requiresGrant = remote || authorization.hasActiveRole;
  const asGrantedReader = async <T>(projectId: string, operation: () => Promise<T>) => {
    if (requiresGrant) await authorization.requireAnyRole(principal, projectId);
    return operation();
  };
  // Workspace Directionの参照。条件はProject参照と同じで、WorkspaceのRole Grantで検査する（Project Grantから継承しない）。
  const asWorkspaceReader = async <T>(workspaceId: string, operation: () => Promise<T>) => {
    if (requiresGrant) await roleScope.requireAnyRole(principal, workspaceScope(workspaceId));
    return operation();
  };
  // 検査の規則はapplication serviceが持つ。handlerはPrincipalとworkspaceIdを渡すだけ。
  // 認可したPrincipalとRoleを操作の間だけ固定し、Directionの状態変更から生成するcanonical Activityの操作者にする。
  const asWorkspaceRole = async <T>(workspaceId: string, role: ProjectRole, operation: (principalId: string) => Promise<T>) => {
    const principalId = await roleScope.requireRole(principal, workspaceScope(workspaceId), role);
    return services.activityActorContext.run({ principalId, role }, () => operation(principalId));
  };
  const asStrategist = <T>(workspaceId: string, operation: () => Promise<T>) =>
    asWorkspaceRole(workspaceId, ProjectRole.STRATEGIST, () => operation());
  // Direction Decisionは来歴にprincipalIdを保存するため、認可と同時にBearerから解決したprincipalIdを受け取る。
  const asStrategistWithPrincipal = <T>(workspaceId: string, operation: (principalId: string) => Promise<T>) =>
    asWorkspaceRole(workspaceId, ProjectRole.STRATEGIST, operation);
  // 来歴のPrincipalはBearerから解決した値だけ。tool入力のprincipalIdは受け付けない。
  const asResearcher = <T>(workspaceId: string, operation: (principalId: string) => Promise<T>) =>
    asWorkspaceRole(workspaceId, ProjectRole.RESEARCHER, operation);
  // 認可をuse caseが行う操作（Evaluation）。Principalがあれば、use caseが要求するRoleを操作者の立場にする。
  const asActorOf = <T>(role: ProjectRole, operation: () => Promise<T>) =>
    principal === null ? operation() : services.activityActorContext.run({ principalId: principal, role }, operation);
  // Projectの管理操作。Strategist・Researcher・EvaluatorのGrantを持つPrincipalには拒否する（職務分離）。
  // 操作者の立場はactiveRole（無ければ管理操作のoperator）。Principalなしのtrusted-local呼出しは`system`になる。
  // Direction RoleはWorkspace所有のため、所属WorkspaceのDirection Role Grantも同じく拒否する。
  const unlessDirectionRole = async <T>(projectId: string, operation: () => Promise<T>) => {
    await roleScope.requireNoWorkspaceGrant(principal, (await services.getProjectUseCase.execute(projectId)).workspaceId);
    return authorization.unlessRole(principal, projectId, ProjectRole.STRATEGIST, () =>
      authorization.unlessRole(principal, projectId, ProjectRole.RESEARCHER, () =>
        authorization.unlessRole(principal, projectId, ProjectRole.EVALUATOR, () =>
          principal === null
            ? operation()
            : services.activityActorContext.run({ principalId: principal, role: authorization.activeRole ?? "operator" }, operation),
        ),
      ),
    );
  };
  // Workspace DirectionのHuman管理操作（Intentの放棄）。WorkspaceのDirection Role Grantを持つPrincipalとactiveRole指定を拒否する。
  const asWorkspaceOperator = async <T>(workspaceId: string, operation: () => Promise<T>) => {
    await roleScope.requireNoWorkspaceRole(principal, workspaceId);
    return principal === null ? operation() : services.activityActorContext.run({ principalId: principal, role: "operator" }, operation);
  };
  // Intentの登録・更新。Agentは対象WorkspaceのStrategist Grantで認可し、操作者をそのStrategist（Agent）として記録する。
  // trusted-localのPrincipalなし・activeRoleなしの保守呼出しだけはGrantを問わず、操作者は`system`になる。
  const asIntentAuthor = async <T>(workspaceId: string, operation: () => Promise<T>) =>
    !remote && principal === null && roleScope.activeRole === null ? operation() : asStrategist(workspaceId, operation);
  return { services, caller, remote, principal, authorization, runtimeAuthorization, roleScope, workspaceScope, requiresGrant, asGrantedReader, asWorkspaceReader, asWorkspaceRole, asStrategist, asStrategistWithPrincipal, asResearcher, asActorOf, unlessDirectionRole, asWorkspaceOperator, asIntentAuthor };
};
export type McpRequestContext = ReturnType<typeof createMcpRequestContext>;
