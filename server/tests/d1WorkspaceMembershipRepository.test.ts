import assert from "node:assert/strict";
import test from "node:test";
import { asAccessDatabase, asOrganizationDatabase } from "../src/infrastructure/database/contextDatabase.ts";
import { D1WorkspaceMembershipRepository } from "../src/infrastructure/repository/d1/D1WorkspaceMembershipRepository.ts";
import { D1WorkspaceRepository } from "../src/infrastructure/repository/d1/D1WorkspaceRepository.ts";
import { planD1WorkspaceOwnerMembership } from "../src/infrastructure/repository/d1/planD1WorkspaceOwnerMembership.ts";
import { createD1TestRuntime, initializeD1TestSchema } from "./support/d1Runtime.ts";

test("D1 prevents concurrent membership changes from removing both owners", async () => {
  const { runtime, binding, database } = await createD1TestRuntime();
  try {
    await initializeD1TestSchema(binding);
    await database.insertInto("human_user").values(["a", "b"].map((id) => ({
      id, display_name: id, email: id + "@example.test", platform_role: "member" as const,
      status: "active" as const, created_at: 1, updated_at: 1,
    }))).execute();
    const access = asAccessDatabase(database);
    const planOwner = planD1WorkspaceOwnerMembership(access);
    const workspaces = new D1WorkspaceRepository(asOrganizationDatabase(database), binding, planOwner);
    const workspace = await workspaces.create({ name: "Workspace", mission: "Mission", vision: null, principles: [], constraints: [] }, "a");
    await binding.batch(planOwner({ workspaceId: workspace.id, ownerHumanUserId: "b", createdAt: 1 })
      .map(({ sql, parameters }) => binding.prepare(sql).bind(...parameters)));
    const members = new D1WorkspaceMembershipRepository(access, binding);
    const a = await members.findActiveMembership(workspace.id, "a");
    const b = await members.findActiveMembership(workspace.id, "b");
    assert.ok(a && b);
    const results = await Promise.all([
      members.changeRole(workspace.id, a.id, "editor"),
      members.revoke(workspace.id, b.id, "a"),
    ]);
    assert.equal(results.filter(({ kind }) => kind === "last_owner").length, 1);
    const owners = (await members.listActiveMembers(workspace.id)).filter(({ membership }) => membership.role === "owner");
    assert.equal(owners.length, 1);
    await workspaces.archive(workspace.id, "done");
    assert.deepEqual(await members.revoke(workspace.id, owners[0]!.membership.id, "a"), { kind: "workspace_archived" });
  } finally {
    await database.destroy();
    await runtime.dispose();
  }
});
