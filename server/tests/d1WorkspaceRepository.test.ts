import assert from "node:assert/strict";
import test from "node:test";
import { createD1TestRuntime, initializeD1TestSchema } from "./support/d1Runtime.ts";
import { D1WorkspaceRepository } from "../src/infrastructure/repository/d1/D1WorkspaceRepository.ts";
import { planD1WorkspaceOwnerMembership } from "../src/infrastructure/repository/d1/planD1WorkspaceOwnerMembership.ts";
import { asAccessDatabase, asOrganizationDatabase } from "../src/infrastructure/database/contextDatabase.ts";

const input = { name: "Business", mission: "A mission", vision: "A vision", principles: ["First", "Second"], constraints: ["Bounded"] };
const setup = async () => {
  const runtime = await createD1TestRuntime();
  try {
    await initializeD1TestSchema(runtime.binding);
    const repository = new D1WorkspaceRepository(asOrganizationDatabase(runtime.database), runtime.binding,
      planD1WorkspaceOwnerMembership(asAccessDatabase(runtime.database)), () => 100);
    return { ...runtime, repository };
  } catch (error) {
    await runtime.runtime.dispose();
    throw error;
  }
};

test("D1 Workspace creation writes children and owner Membership atomically and preserves ordered values", async () => {
  const { runtime, database, repository } = await setup();
  try {
    await database.insertInto("human_user").values({ id: "owner", display_name: "Owner", email: "owner@example.test",
      platform_role: "owner", status: "active", created_at: 1, updated_at: 1 }).execute();
    const created = await repository.create(input, "owner");
    assert.deepEqual(await repository.findById(created.id), created);
    const members = await database.selectFrom("workspace_membership").selectAll().execute();
    assert.equal(members.length, 1);
    assert.equal(members[0]?.workspace_id, created.id);
    assert.equal(members[0]?.role, "owner");
    await assert.rejects(repository.create({ ...input, name: "Must roll back" }, "missing-owner"));
    assert.equal((await database.selectFrom("workspace").selectAll().execute()).length, 1);
    assert.equal((await database.selectFrom("workspace_principle").selectAll().execute()).length, 2);
    assert.equal((await database.selectFrom("workspace_constraint").selectAll().execute()).length, 1);
  } finally {
    await database.destroy();
    await runtime.dispose();
  }
});

test("D1 Workspace concurrent edits from the same version cannot both succeed or mix child values", async () => {
  const { runtime, database, repository } = await setup();
  try {
    const created = await repository.create(input);
    const edits = await Promise.all([
      repository.update(created.id, { expectedUpdatedAt: created.updatedAt, name: "A", principles: ["A1", "A2"], constraints: [] }),
      repository.update(created.id, { expectedUpdatedAt: created.updatedAt, name: "B", principles: ["B1"], constraints: ["B"] }),
    ]);
    assert.deepEqual(edits.map(({ kind }) => kind).sort(), ["stale", "updated"]);
    const winner = edits.find((result) => result.kind === "updated");
    assert.ok(winner?.kind === "updated");
    const saved = await repository.findById(created.id);
    assert.deepEqual(saved, winner.workspace);
    assert.equal(saved?.updatedAt, 101);
    assert.equal(saved?.mission, input.mission);
    if (saved?.name === "A") {
      assert.deepEqual(saved.principles, ["A1", "A2"]);
      assert.deepEqual(saved.constraints, []);
    } else {
      assert.deepEqual(saved?.principles, ["B1"]);
      assert.deepEqual(saved?.constraints, ["B"]);
    }
    assert.deepEqual(await repository.update(created.id, { expectedUpdatedAt: 100, mission: "stale" }), { kind: "stale" });
    assert.deepEqual(await repository.findById(created.id), saved);
  } finally {
    await database.destroy();
    await runtime.dispose();
  }
});

test("D1 Workspace archive is idempotent under concurrency and forbids later edits", async () => {
  const { runtime, database, repository } = await setup();
  try {
    const created = await repository.create(input);
    const results = await Promise.all([repository.archive(created.id, "first"), repository.archive(created.id, "second")]);
    assert.deepEqual(results.map(({ kind }) => kind).sort(), ["already_archived", "archived"]);
    const saved = await repository.findById(created.id);
    assert.equal(saved?.status, "archived");
    assert.deepEqual(saved?.principles, input.principles);
    assert.deepEqual(await repository.update(created.id, { name: "forbidden" }), { kind: "workspace_archived" });
    assert.deepEqual(await repository.findById(created.id), saved);
    assert.equal((await repository.findAll()).length, 0);
    assert.equal((await repository.findAll("archived")).length, 1);
    assert.deepEqual(await repository.archive("missing", "reason"), { kind: "not_found" });
    assert.deepEqual(await repository.update("missing", { name: "x" }), { kind: "not_found" });
  } finally {
    await database.destroy();
    await runtime.dispose();
  }
});
