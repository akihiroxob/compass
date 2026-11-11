import assert from "node:assert/strict";
import test from "node:test";
import { recordOutcomeConfirmedEvent } from "@compass/direction";
import { createD1TestRuntime, initializeD1TestSchema } from "./support/d1Runtime.ts";
import { createD1OrganizationInfrastructure } from "../src/bootstrap/d1OrganizationInfrastructure.ts";
import { activityActorContext } from "../src/infrastructure/activity/NodeActivityActorContext.ts";
import { asDirectionDatabase } from "../src/infrastructure/database/contextDatabase.ts";
import { D1RuntimeEventRepository } from "../src/infrastructure/repository/d1/D1RuntimeEventRepository.ts";

test("D1 Runtime Ack receipts are atomic and retries cannot double-count failures or skip pending events", async () => {
  const { runtime, binding, database } = await createD1TestRuntime();
  try {
    await initializeD1TestSchema(binding);
    const { workspaceRepository } = createD1OrganizationInfrastructure(database, binding, activityActorContext);
    const workspace = await workspaceRepository.create({ name: "Business", mission: "Goal", vision: null, principles: [], constraints: [] });
    await database.insertInto("intent").values({ id: "intent", workspace_id: workspace.id, title: "Intent", desired_state: "Goal",
      status: "active", version: 1, meaning_version: 1, created_at: 1, updated_at: 1 }).execute();
    const direction = asDirectionDatabase(database);
    for (const id of ["first", "second"]) {
      await database.insertInto("outcome").values({ id, workspace_id: workspace.id, intent_id: "intent", intent_version: 1,
        title: id, description: "Description", rationale: "Reason", status: "active", revision: 1, created_at: 1, updated_at: 1 }).execute();
      await recordOutcomeConfirmedEvent(direction, { workspaceId: workspace.id, intentId: "intent", outcomeId: id, occurredAt: 1 });
    }
    const repository = new D1RuntimeEventRepository(direction, binding);
    const events = await repository.findAfter(workspace.id, 0, 10);
    assert.equal(events.length, 2);
    assert.equal(await repository.findResumeCursor("empty", "consumer"), 0);
    assert.equal(await repository.findResumeCursor(workspace.id, "consumer"), events[0]!.cursor - 1);
    const input = { workspaceId: workspace.id, consumerId: "consumer", attemptId: "attempt", eventId: events[0]!.id,
      outcome: "retryable_failure" as const, reason: "failure", at: 100 };
    await binding.prepare("CREATE TRIGGER reject_ack BEFORE INSERT ON runtime_event_ack_attempt BEGIN SELECT RAISE(ABORT, 'receipt failure'); END;").run();
    await assert.rejects(repository.recordAck(input), /receipt failure/);
    assert.equal((await database.selectFrom("runtime_event_delivery").selectAll().execute()).length, 0);
    await binding.prepare("DROP TRIGGER reject_ack").run();
    const retries = await Promise.all([repository.recordAck(input), repository.recordAck(input)]);
    assert.equal(retries.filter((result) => result.kind === "recorded" && result.recorded).length, 1);
    assert.ok(retries.every((result) => result.kind === "recorded" && result.delivery.retryCount === 1));
    assert.equal((await repository.recordAck({ ...input, reason: "changed" })).kind, "idempotency_conflict");
    const secondFailure = await repository.recordAck({ ...input, attemptId: "attempt-2", reason: "second failure" });
    assert.ok(secondFailure.kind === "recorded");
    assert.equal(secondFailure.delivery.retryCount, 2);
    const processed = await repository.recordAck({ ...input, attemptId: "success", outcome: "processed", reason: null });
    assert.ok(processed.kind === "recorded");
    assert.equal(processed.delivery.retryCount, 2);
    assert.equal(processed.delivery.lastFailureReason, "second failure");
    const replay = await repository.recordAck(input);
    assert.ok(replay.kind === "recorded");
    assert.equal(replay.delivery.retryCount, 1);
    assert.equal((await repository.recordAck({ ...input, attemptId: "different-result", outcome: "terminal_failure" })).kind, "conflict");
    assert.deepEqual((await repository.findPending(workspace.id, "consumer", 0, 10)).map(({ id }) => id), [events[1]!.id]);
    assert.equal(await repository.findResumeCursor(workspace.id, "consumer"), events[1]!.cursor - 1);
    await repository.recordAck({ ...input, eventId: events[1]!.id, attemptId: "second-event", outcome: "terminal_failure" });
    assert.equal(await repository.findResumeCursor(workspace.id, "consumer"), events[1]!.cursor);
    assert.deepEqual(await repository.recordAck({ ...input, workspaceId: "another-workspace" }), { kind: "event_not_found" });
  } finally {
    await database.destroy();
    await runtime.dispose();
  }
});
