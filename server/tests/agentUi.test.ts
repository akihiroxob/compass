import assert from "node:assert/strict";
import test from "node:test";
import {
  agentScopeGroups,
  claimsWithoutGrant,
  credentialBinding,
  principalCredential,
  projectAgentRoles,
  registrationIssues,
  scopeSummary,
  summarizeWorkspaceAgents,
  workspaceAgentRoles,
} from "../src/web/features/agent/agents.ts";
import { parseShellLocation } from "../src/web/features/workspace/workspace.ts";
import { workspaceAgentPath } from "../src/web/paths.ts";
import type { Credential } from "../src/web/features/credential/credentials.ts";
import type { ExecutionTask } from "../src/web/features/execution/execution.ts";

/** WorkspaceのAgent管理（UI-E1）の判定。画面の描画・実ブラウザ確認はTaskの結果に記録する。 */

const now = 1_000_000;
const grant = (principalId: string, role: string) => ({ principalId, role, createdAt: 0 });
const credential = (principalId: string, overrides: Partial<Credential> = {}): Credential => ({
  id: `${principalId}-${overrides.expiresAt ?? "c"}`,
  scope: { kind: "project", id: "p1" },
  kind: "agent",
  principalId,
  scopes: [],
  prefix: "cmp_",
  expiresAt: now + 60_000,
  revokedAt: null,
  lastUsedAt: null,
  createdAt: 0,
  rotatedFromId: null,
  ...overrides,
});
const task = (id: string, overrides: Partial<ExecutionTask> = {}): ExecutionTask => ({
  id, projectId: "p1", storyId: "s1", title: id, description: null, status: "todo", rejectReason: null, createdAt: 0, updatedAt: 0, taskKey: null, activeClaim: null, reclaimable: false, ...overrides,
});
const held = (principalId: string, expiresAt = now + 60_000) => ({ claimId: `c-${principalId}`, principalId, expiresAt });

const workspace = { id: "w1", name: "Alpha" };
const project = (id: string, name: string, grants: ReturnType<typeof grant>[], tasks: ExecutionTask[] = [], credentials: Credential[] | null = []) =>
  ({ project: { id, name }, grants, credentials, tasks });

test("Workspace RoleとProject Roleの区別。ManagerはProjectのRoleで、Workspace Roleとして数えない", () => {
  assert.deepEqual([...workspaceAgentRoles], ["strategist", "researcher", "evaluator"]);
  assert.ok((projectAgentRoles as readonly string[]).includes("manager"));
  const agents = summarizeWorkspaceAgents({
    workspace,
    workspaceGrants: [grant("nagi", "researcher"), grant("atlas", "manager"), grant("rt", "runtime")],
    workspaceCredentials: null,
    projects: [],
    now,
  });
  // Workspace scopeのExecution Role・RuntimeのGrantは数えない。Credentialを参照できなければ判断しない（null）。
  assert.deepEqual(agents.principals.map((p) => [p.principalId, p.roles]), [["nagi", ["researcher"]]]);
  assert.equal(agents.principals[0].credential, null);
  assert.deepEqual(agents.principals[0].claims, []);
});

test("同一Principalの複数Project・複数RoleのGrantを全件保持し、一覧は先頭のscopeと「ほかN件」にまとめる", () => {
  const agents = summarizeWorkspaceAgents({
    workspace,
    workspaceGrants: [grant("strategist-01", "strategist")],
    workspaceCredentials: [],
    projects: [
      project("p1", "学習アプリ", [grant("worker-01", "worker"), grant("worker-01", "reviewer"), grant("legacy", "strategist")]),
      project("p2", "運営管理", [grant("worker-01", "worker")]),
      project("p3", "とても長い名前のProject", [grant("worker-01", "worker")]),
    ],
    now,
  });
  const byId = new Map(agents.principals.map((p) => [p.principalId, p]));
  const worker = byId.get("worker-01")!;
  assert.deepEqual(worker.grants.map((g) => [g.scope.id, g.role]), [["p1", "worker"], ["p1", "reviewer"], ["p2", "worker"], ["p3", "worker"]]);
  assert.deepEqual(worker.roles, ["worker", "reviewer"]);
  assert.deepEqual(worker.scopes.map((scope) => scope.name), ["学習アプリ", "運営管理", "とても長い名前のProject"]);
  assert.deepEqual(scopeSummary(worker.scopes), { label: "学習アプリ", others: 2 });
  assert.deepEqual(scopeSummary(byId.get("strategist-01")!.scopes), { label: "Workspace", others: 0 });
  assert.equal(scopeSummary([]), null);
  // Projectに残る旧Direction Grantも黙って隠さない。
  assert.deepEqual(byId.get("legacy")!.grants.map((g) => [g.scope.kind, g.role]), [["project", "strategist"]]);
  // 詳細はscopeごとにGrantをまとめる。
  assert.deepEqual(agentScopeGroups(worker).map((group) => [group.scope.id, group.grants.map((g) => g.role)]), [["p1", ["worker", "reviewer"]], ["p2", ["worker"]], ["p3", ["worker"]]]);
});

test("Credential・Claimを別の状態として集約し、Projectをまたいで現在の作業を出す", () => {
  const agents = summarizeWorkspaceAgents({
    workspace,
    workspaceGrants: [],
    workspaceCredentials: [credential("idle-agent", { scope: { kind: "workspace", id: "w1" } })],
    projects: [
      project(
        "p1",
        "App",
        [grant("atlas", "worker"), grant("mori", "reviewer")],
        [
          task("t1", { status: "doing", activeClaim: held("atlas", now + 120_000) }),
          task("t2", { status: "in_review", activeClaim: held("atlas", now + 30_000) }),
          task("t3", { status: "wait_accept", activeClaim: held("boss") }),
          task("t4", { status: "doing", activeClaim: null, reclaimable: true }),
          task("t5", { status: "doing", activeClaim: held("ghost", now - 1) }),
          task("t6", { status: "todo" }),
        ],
        [credential("atlas"), credential("mori", { revokedAt: 1 }), credential("old", { revokedAt: 1 }), { ...credential("rt"), kind: "runtime" }],
      ),
    ],
    now,
  });
  // Grant保持者・Claim保持者・有効なAgent Credentialだけの保持者を出す。取消済みCredentialだけ・Runtime・期限切れClaimは出さない。
  assert.deepEqual(agents.principals.map((p) => p.principalId), ["atlas", "boss", "idle-agent", "mori"]);
  const [atlas, boss, idle, mori] = agents.principals;
  assert.deepEqual(atlas.credential, { status: "active", expiresAt: now + 60_000 });
  assert.deepEqual(atlas.claims.map((c) => [c.taskId, c.status, c.projectName]), [["t2", "in_review", "App"], ["t1", "doing", "App"]]);
  // atlasはreviewerのGrantが無いため、レビュー待ちのClaimはGrantなしとして注記する。
  assert.deepEqual(claimsWithoutGrant(atlas).map((c) => c.taskId), ["t2"]);
  assert.deepEqual(boss.roles, []);
  assert.deepEqual(boss.credential, { status: "none", expiresAt: null });
  assert.deepEqual(claimsWithoutGrant(boss).map((c) => c.taskId), ["t3"]);
  assert.deepEqual(idle.roles, []);
  assert.deepEqual(idle.credentials?.map((c) => c.scopeName), ["Alpha"]);
  assert.equal(mori.credential?.status, "revoked");
  // 期限切れClaimの作業中は担当中ではなく、再取得待ちとして数える。
  assert.equal(agents.reclaimableCount, 2);
});

test("Agent Credentialは1つのscopeに束縛され、複数scopeのGrantがあれば発行先を決めない", () => {
  const agents = summarizeWorkspaceAgents({
    workspace,
    workspaceGrants: [grant("both", "researcher")],
    workspaceCredentials: [],
    projects: [
      project("p1", "App", [grant("single", "worker"), grant("single", "reviewer"), grant("multi", "worker"), grant("both", "worker")]),
      project("p2", "Ops", [grant("multi", "worker")], [], [credential("cred-only", { scope: { kind: "project", id: "p2" } })]),
    ],
    now,
  });
  const byId = new Map(agents.principals.map((p) => [p.principalId, p]));
  // 1つのscopeで複数Roleなら、そのscopeで発行できる。
  assert.deepEqual(credentialBinding(byId.get("single")!, now), { kind: "single", scope: { kind: "project", id: "p1", name: "App" } });
  assert.deepEqual((credentialBinding(byId.get("multi")!, now) as { scopes: { id: string }[] }).scopes.map((scope) => scope.id), ["p1", "p2"]);
  assert.equal(credentialBinding(byId.get("both")!, now).kind, "multiple");
  // Grantの無い有効なCredentialのscopeも束縛として扱う。
  assert.deepEqual(credentialBinding(byId.get("cred-only")!, now), { kind: "single", scope: { kind: "project", id: "p2", name: "Ops" } });
  assert.deepEqual(credentialBinding({ scopes: [], credentials: null }, now), { kind: "none" });
});

test("1つでもProjectのCredentialを参照できなければ、Credentialの状態を判断しない", () => {
  const agents = summarizeWorkspaceAgents({ workspace, workspaceGrants: [], workspaceCredentials: [], projects: [project("p1", "App", [grant("atlas", "worker")], [], null)], now });
  assert.deepEqual(agents.principals.map((p) => [p.principalId, p.credential, p.credentials]), [["atlas", null, null]]);
});

test("登録の入力検査: Agent名・Role、Project Roleは1つ以上のProject", () => {
  assert.deepEqual(registrationIssues({ principalId: " ", role: "", projectIds: [] }), ["Agent名を入力してください。", "Roleを選んでください。"]);
  assert.deepEqual(registrationIssues({ principalId: "w", role: "worker", projectIds: [] }), ["担当するProjectを1つ以上選んでください。"]);
  assert.deepEqual(registrationIssues({ principalId: "w", role: "worker", projectIds: ["p1", "p2"] }), []);
  assert.deepEqual(registrationIssues({ principalId: "s", role: "strategist", projectIds: [] }), []);
});

test("Agent詳細のURLはPrincipalをエンコードし、メニューのAgent管理を選択する", () => {
  assert.equal(workspaceAgentPath("w1", "team/worker 1"), "/workspaces/w1/agents/team%2Fworker%201");
  assert.deepEqual(parseShellLocation(workspaceAgentPath("w1", "team/worker 1")), { kind: "workspace", workspaceId: "w1", section: "agents" });
  assert.deepEqual(parseShellLocation("/workspaces/w1/agents/a/b"), { kind: "workspace", workspaceId: "w1", section: null });
});

test("PrincipalのCredentialは有効を優先し、無ければ期限切れ・取消済み・未発行の順で代表を選ぶ", () => {
  assert.deepEqual(principalCredential("a", [], now), { status: "none", expiresAt: null });
  assert.deepEqual(principalCredential("a", [credential("a", { revokedAt: 1 }), credential("a", { expiresAt: now })], now), { status: "expired", expiresAt: now });
  assert.deepEqual(
    principalCredential("a", [credential("a", { expiresAt: now + 10 }), credential("a", { expiresAt: now + 20 }), credential("a", { expiresAt: now - 5 })], now),
    { status: "active", expiresAt: now + 20 },
  );
  assert.deepEqual(principalCredential("a", [{ ...credential("a"), kind: "runtime" }, credential("b")], now), { status: "none", expiresAt: null });
});
