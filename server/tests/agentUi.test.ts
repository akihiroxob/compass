import assert from "node:assert/strict";
import test from "node:test";
import {
  claimsWithoutGrant,
  principalCredential,
  projectAgentRoles,
  summarizeScopeAgents,
  workspaceAgentRoles,
} from "../src/web/features/agent/agents.ts";
import type { Credential } from "../src/web/features/credential/credentials.ts";
import type { ExecutionTask } from "../src/web/features/execution/execution.ts";

/** WorkspaceのAgent画面（S11-02）の判定。画面の描画・実ブラウザ確認はTaskの結果に記録する。 */

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

test("Workspace Direction RoleはClaimを持たず、ManagerをWorkspace Roleとして扱わない", () => {
  assert.deepEqual([...workspaceAgentRoles], ["strategist", "researcher", "evaluator"]);
  assert.ok(!(workspaceAgentRoles as readonly string[]).includes("manager"));
  assert.ok((projectAgentRoles as readonly string[]).includes("manager"));
  const agents = summarizeScopeAgents({
    roles: workspaceAgentRoles,
    grants: [grant("nagi", "researcher"), grant("s1", "strategist"), grant("atlas", "manager")],
    credentials: null,
    tasks: null,
    now,
  });
  assert.deepEqual(agents.roles, [
    { role: "strategist", principalIds: ["s1"] },
    { role: "researcher", principalIds: ["nagi"] },
    { role: "evaluator", principalIds: [] },
  ]);
  // scope外のRole（manager）のGrantは数えず、ResearcherにWork Claimを作らない（null = Claimを持たないscope）。
  assert.deepEqual(agents.principals.map((p) => p.principalId), ["nagi", "s1"]);
  assert.ok(agents.principals.every((p) => p.claims === null && p.credential === null));
  assert.equal(agents.reclaimableCount, null);
});

test("Project Execution Role: Grant・Credential・Claimを別の状態として集約し、旧Direction Grantを数えない", () => {
  const agents = summarizeScopeAgents({
    roles: projectAgentRoles,
    grants: [grant("atlas", "worker"), grant("atlas", "reviewer"), grant("mori", "reviewer"), grant("legacy", "strategist")],
    credentials: [credential("atlas"), credential("idle-agent"), credential("mori", { revokedAt: 1 }), credential("old", { revokedAt: 1 }), { ...credential("rt"), kind: "runtime" }],
    tasks: [
      task("t1", { status: "doing", activeClaim: held("atlas", now + 120_000) }),
      task("t2", { status: "in_review", activeClaim: held("atlas", now + 30_000) }),
      task("t3", { status: "wait_accept", activeClaim: held("boss") }),
      task("t4", { status: "doing", activeClaim: null, reclaimable: true }),
      task("t5", { status: "doing", activeClaim: held("ghost", now - 1) }),
      task("t6", { status: "todo" }),
    ],
    now,
  });
  assert.deepEqual(agents.roles, [
    { role: "manager", principalIds: [] },
    { role: "worker", principalIds: ["atlas"] },
    { role: "reviewer", principalIds: ["atlas", "mori"] },
  ]);
  // Grant保持者・Claim保持者・有効なAgent Credentialだけの保持者を出す。取消済みCredentialだけ・Runtime・旧Direction Grant・期限切れClaimは出さない。
  assert.deepEqual(agents.principals.map((p) => p.principalId), ["atlas", "boss", "idle-agent", "mori"]);
  const [atlas, boss, idle, mori] = agents.principals;
  assert.deepEqual(atlas.roles, ["worker", "reviewer"]);
  assert.deepEqual(atlas.credential, { status: "active", expiresAt: now + 60_000 });
  assert.deepEqual(atlas.claims?.map((c) => [c.taskId, c.status]), [["t2", "in_review"], ["t1", "doing"]]);
  assert.deepEqual(boss.roles, []);
  assert.deepEqual(boss.credential, { status: "none", expiresAt: null });
  assert.deepEqual(claimsWithoutGrant(boss).map((c) => c.taskId), ["t3"]);
  assert.deepEqual(claimsWithoutGrant(atlas), []);
  assert.deepEqual(idle.roles, []);
  assert.deepEqual(idle.claims, []);
  assert.equal(mori.credential?.status, "revoked");
  // 期限切れClaimの作業中は担当中ではなく、再取得待ちとして数える。
  assert.equal(agents.reclaimableCount, 2);
});

test("Credentialを参照できなければ状態を判断せず、Credentialだけの保持者も推測しない", () => {
  const agents = summarizeScopeAgents({ roles: projectAgentRoles, grants: [grant("atlas", "worker")], credentials: null, tasks: [], now });
  assert.deepEqual(agents.principals, [{ principalId: "atlas", roles: ["worker"], credential: null, claims: [] }]);
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
