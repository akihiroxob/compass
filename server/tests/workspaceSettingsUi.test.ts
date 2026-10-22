import assert from "node:assert/strict";
import test from "node:test";
import { hasMinimumRole, humanProjectPermissions, humanWorkspacePermissions, type HumanRole } from "@compass/access";
import { ApiError, classifyError } from "../src/web/api.ts";
import { runtimeScopeOptionsFor, rotateCredentialPath, scopeCredentialsPath } from "../src/web/features/credential/credentials.ts";
import { canGrantInScope, revokeRecoveryNote, scopeGrantRoles, scopeGrantsPath, scopeRevokeGrantPath } from "../src/web/features/grant/grants.ts";
import {
  addWorkspaceMemberInit,
  scopeMembersPath,
  scopeRoleDescriptions,
  workspaceMemberCandidatesPath,
} from "../src/web/features/member/members.ts";
import { parseShellLocation, workspaceSectionLabels } from "../src/web/features/workspace/workspace.ts";
import { workspacePath } from "../src/web/paths.ts";

/** Workspace設定（S11-03）の画面の判定とrequest。画面の描画・実ブラウザ確認はTaskの結果に記録する。 */

const workspace = { kind: "workspace", id: "ws-1" } as const;
const project = { kind: "project", id: "p-1" } as const;
// `server/src/web/features/access/permissions.ts`の`canOperateWorkspace`と同じ判定（frontendのmoduleはserverのtsconfigで読めないためdomainの権限表を直接使う）。
const canOperateWorkspace = (role: HumanRole, operation: keyof typeof humanWorkspacePermissions) => hasMinimumRole(role, humanWorkspacePermissions[operation]);

test("Workspaceの「設定」はURLで表し、Shellのナビゲーション項目になる", () => {
  assert.equal(workspacePath("ws-1", "settings"), "/workspaces/ws-1/settings");
  assert.deepEqual(parseShellLocation("/workspaces/ws-1/settings"), { kind: "workspace", workspaceId: "ws-1", section: "settings" });
  assert.equal(workspaceSectionLabels.settings, "設定");
});

test("設定の導線はWorkspace Membershipの権限表で決め、Project Roleの権限表とは別に引く", () => {
  const roles: HumanRole[] = ["owner", "administrator", "editor", "viewer"];
  assert.deepEqual(roles.filter((role) => canOperateWorkspace(role, "member.manage")), ["owner"]);
  assert.deepEqual(roles.filter((role) => canOperateWorkspace(role, "grant.manage")), ["owner", "administrator"]);
  assert.deepEqual(roles.filter((role) => canOperateWorkspace(role, "credential.manage")), ["owner", "administrator"]);
  assert.deepEqual(roles.filter((role) => canOperateWorkspace(role, "grant.read")), roles);
  // 同名の操作もProjectの表とは別に定める（ProjectのGrant管理権限からWorkspaceのGrant管理を導かない）。
  assert.equal(humanProjectPermissions["grant.manage"], "administrator");
  assert.equal("grant.manage" in humanWorkspacePermissions, true);
});

test("Workspace Grantの一覧・付与・取消のpathとRoleはDirection Roleだけで、ProjectのRoleと分かれる", () => {
  assert.equal(scopeGrantsPath(workspace), "/api/workspaces/ws-1/grants");
  assert.equal(scopeRevokeGrantPath(workspace, { role: "strategist", principalId: "team/agent 1" }), "/api/workspaces/ws-1/grants/strategist/team%2Fagent%201");
  assert.deepEqual(scopeGrantRoles(workspace), ["strategist", "researcher", "evaluator"]);
  assert.deepEqual(scopeGrantRoles(project), ["strategist", "researcher", "manager", "worker", "reviewer", "evaluator"]);
  for (const role of ["strategist", "researcher", "evaluator"] as const) {
    assert.equal(canGrantInScope(workspace, role), true);
    assert.equal(canGrantInScope(project, role), false);
    assert.equal(revokeRecoveryNote(workspace, role), "再度割り当てて元に戻せます。");
  }
  for (const role of ["manager", "worker", "reviewer", "runtime"] as const) assert.equal(canGrantInScope(workspace, role), false);
});

test("Workspace Credentialのpathとscope選択肢はWorkspaceのRuntime入口に合わせる", () => {
  assert.equal(scopeCredentialsPath(workspace), "/api/workspaces/ws-1/credentials");
  assert.equal(scopeCredentialsPath(workspace, "c-1"), "/api/workspaces/ws-1/credentials/c-1");
  assert.equal(rotateCredentialPath(workspace, "c-1"), "/api/workspaces/ws-1/credentials/c-1/rotate");
  assert.deepEqual(runtimeScopeOptionsFor("workspace").map(({ scope }) => scope), ["runtime:event:read", "runtime:event:ack", "runtime:state:read"]);
  assert.equal(runtimeScopeOptionsFor("project").length, 6);
});

test("Workspace memberのpath・追加request・Role説明はWorkspaceのもの", () => {
  assert.equal(scopeMembersPath(workspace), "/api/workspaces/ws-1/members");
  assert.equal(scopeMembersPath(workspace, "m-1"), "/api/workspaces/ws-1/members/m-1");
  assert.equal(scopeMembersPath(project, "m-1"), "/api/projects/p-1/members/m-1");
  assert.equal(workspaceMemberCandidatesPath("ws-1"), "/api/workspaces/ws-1/member-candidates");
  const init = addWorkspaceMemberInit("h-1", "editor");
  assert.equal(init.method, "POST");
  assert.deepEqual(JSON.parse(String(init.body)), { humanUserId: "h-1", role: "editor" });
  assert.match(scopeRoleDescriptions(workspace).administrator, /Direction Agent・Credential/);
  assert.doesNotMatch(scopeRoleDescriptions(workspace).administrator, /Projectの編集/);
});

test("Workspaceの権限エラー・重複・Agent名の束縛はscopeを特定せず理由と次の行動を出す", () => {
  const forbidden = classifyError(new ApiError(403, "FORBIDDEN", "x"));
  assert.match(forbidden.kind === "other" ? forbidden.message : "", /権限がありません/);
  const duplicate = classifyError(new ApiError(409, "CONFLICT", "x", [], null, null, "ALREADY_MEMBER"));
  assert.match(duplicate.kind === "conflict" ? duplicate.message : "", /既にこのWorkspaceのMember/);
  const bound = classifyError(new ApiError(409, "CONFLICT", "x", [], null, null, "PRINCIPAL_BOUND_ELSEWHERE"));
  assert.match(bound.kind === "conflict" ? bound.message : "", /別のWorkspaceまたはProject/);
  const lastOwner = classifyError(new ApiError(409, "CONFLICT", "x", [], null, null, "LAST_OWNER"));
  assert.match(lastOwner.kind === "conflict" ? lastOwner.message : "", /Workspace/);
});
