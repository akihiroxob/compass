import assert from "node:assert/strict";
import test from "node:test";
import type { ConsultationActor, ConsultationScope } from "@compass/collaboration";
import { createD1TestRuntime, initializeD1TestSchema } from "./support/d1Runtime.ts";
import { createD1OrganizationInfrastructure } from "../src/bootstrap/d1OrganizationInfrastructure.ts";
import { createD1ConsultationInfrastructure } from "../src/bootstrap/d1ConsultationInfrastructure.ts";
import { createConsultationServices } from "../src/bootstrap/consultationServices.ts";
import { activityActorContext } from "../src/infrastructure/activity/NodeActivityActorContext.ts";
import { DirectionReferenceLookupService } from "@compass/direction";
import { createD1DirectionInfrastructure } from "../src/bootstrap/d1DirectionInfrastructure.ts";

const manager: ConsultationActor = { kind: "agent", principalId: "manager", role: "manager" };
const human: ConsultationActor = { kind: "human", principalId: "human:owner", role: "operator" };
const input = { title: "設計方針", question: "Which approach?", blockingReason: "Tradeoff", recommendation: "D1", impact: "All persistence", requestId: "create" };
const setup = async () => {
  const context = await createD1TestRuntime();
  await initializeD1TestSchema(context.binding);
  const organization = createD1OrganizationInfrastructure(context.database, context.binding, activityActorContext);
  const project = await organization.projectRepository.create({ name: "Product", mission: "Goal", description: null, vision: null,
    principles: [], constraints: [], repositories: [{ name: "source", url: "https://github.com/example/product", requiredChecks: [] }], resources: [] });
  const direction = createD1DirectionInfrastructure(context.database, context.binding, activityActorContext);
  const references = new DirectionReferenceLookupService(organization.projectRepository, direction.outcomeRepository, direction.outcomeTargetProjectRepository);
  let now = 1000;
  const uow = createD1ConsultationInfrastructure(context.binding, references, () => now);
  const { consultations } = createConsultationServices(context.database, references, () => now, uow);
  await context.database.insertInto("project_grant").values({ project_id: project.id, principal_id: manager.principalId, role: "manager", created_at: now }).execute();
  const scope: ConsultationScope = { kind: "project", projectId: project.id };
  return { ...context, project, scope, uow, consultations, setNow: (value: number) => { now = value; } };
};

test("D1 Consultation preserves concurrent replies, exclusive lease, revisions and replayed resolution", async () => {
  const { runtime, database, consultations: c, scope, project } = await setup();
  try {
    const created = await Promise.all([c.create.execute(scope, manager, input), c.create.execute(scope, manager, input)]);
    assert.equal(created[0]!.consultation.id, created[1]!.consultation.id);
    const id = created[0]!.consultation.id;
    const replies = await Promise.all(["first", "second"].map((requestId) => c.addMessage.execute(scope, id, human, { body: requestId, requestId })));
    const detail = await c.get.execute(scope, id, [project.id]);
    assert.equal(detail.consultation.revision, 3);
    assert.deepEqual(detail.messages.map(({ sequence }) => sequence), [1, 2]);
    const leases = await Promise.allSettled([manager, { ...manager, principalId: "other" }].map((actor) => c.acquireLease.execute(scope, id, actor, { inputRevision: 3, requestId: `lease-${actor.principalId}` })));
    assert.equal(leases.filter(({ status }) => status === "fulfilled").length, 1);
    const winner = leases[0]!.status === "fulfilled" ? manager : { ...manager, principalId: "other" };
    const leaseResult = leases.find((result) => result.status === "fulfilled")!;
    assert.equal(leaseResult.status, "fulfilled");
    const lease = leaseResult.value.lease;
    const resolve = { conclusion: "Use D1", rationale: "Fits deployment", expectedRevision: 3, basisMessageIds: replies.map(({ message }) => message.id), leaseId: lease.id, requestId: "resolve" };
    const result = await c.resolve.execute(scope, id, winner, resolve);
    assert.equal(result.consultation.status, "resolved");
    assert.equal((await c.resolve.execute(scope, id, winner, resolve)).resolution.id, result.resolution.id);
    assert.equal((await database.selectFrom("consultation_lease").selectAll().where("id", "=", lease.id).executeTakeFirstOrThrow()).released_at, 1000);
    const list = await c.listAccessible.execute({ projectIds: [project.id, ...Array.from({ length: 110 }, (_, i) => `missing-${i}`)], workspaceIds: [] }, { status: "all" });
    assert.equal(list.consultations.length, 1);
  } finally { await database.destroy(); await runtime.dispose(); }
});

test("D1 Consultation document followup, Work receipt and both Activity records commit or roll back together", async () => {
  const { runtime, database, binding, consultations: c, scope, project, uow } = await setup();
  try {
    const { consultation } = await c.create.execute(scope, manager, input);
    await c.resolve.execute(scope, consultation.id, human, { conclusion: "Use D1", rationale: "Selected", expectedRevision: 1, requestId: "decide" });
    const followup = { kind: "adr", repositoryId: project.repositories[0]!.id, title: "Record decision", purpose: "Persist tradeoff", decision: "D1", rationale: "Cloudflare", verification: "Review ADR", requestId: "followup" };
    await binding.exec("CREATE TRIGGER fail_followup_receipt BEFORE INSERT ON consultation_command_receipt WHEN NEW.operation = 'request_consultation_followup' BEGIN SELECT RAISE(ABORT, 'forced followup failure'); END");
    await assert.rejects(c.requestFollowup.execute(project.id, scope, consultation.id, manager, followup), /forced followup failure/);
    for (const table of ["task", "command_receipt", "change_log", "consultation_followup"] as const) {
      assert.equal((await database.selectFrom(table).selectAll().execute()).length, 0, table);
    }
    assert.equal((await database.selectFrom("activity").selectAll().where("type", "=", "consultation.followup_requested").execute()).length, 0);
    await binding.exec("DROP TRIGGER fail_followup_receipt");
    const result = await c.requestFollowup.execute(project.id, scope, consultation.id, manager, followup);
    assert.equal(result.followup.task?.id, result.followup.taskId);
    assert.equal((await c.requestFollowup.execute(project.id, scope, consultation.id, manager, followup)).followup.id, result.followup.id);
    const activities = await database.selectFrom("activity").select(["cursor", "type"]).where("type", "in", ["consultation.followup_requested", "task.created"]).execute();
    assert.equal(activities.length, 2);
    assert.equal(new Set(activities.map(({ cursor }) => cursor)).size, 2);
    await assert.rejects(uow.execute(async (store) => {
      await store.extendLease("absent", 3000);
      throw new Error("abort plan");
    }), /abort plan/);
  } finally { await database.destroy(); await runtime.dispose(); }
});

test("D1 Consultation rejects stale responses and expired leases, extends ownership and releases on cancel", async () => {
  const { runtime, database, consultations: c, scope, project, setNow } = await setup();
  try {
    const { consultation } = await c.create.execute(scope, manager, input);
    const reply = await c.addMessage.execute(scope, consultation.id, human, { body: "First answer", requestId: "reply" });
    const { lease } = await c.acquireLease.execute(scope, consultation.id, manager, { inputRevision: 2, requestId: "lease" });
    setNow(2000);
    const extended = await c.acquireLease.execute(scope, consultation.id, manager, { inputRevision: 2, requestId: "extend" });
    assert.equal(extended.lease.id, lease.id);
    assert.ok(extended.lease.expiresAt > lease.expiresAt);
    await c.addMessage.execute(scope, consultation.id, human, { body: "Correction", correctsMessageId: reply.message.id, requestId: "new-input" });
    await assert.rejects(c.addMessage.execute(scope, consultation.id, manager, { body: "Old response", expectedRevision: 2, leaseId: lease.id, requestId: "stale" }));
    assert.equal((await c.get.execute(scope, consultation.id, [project.id])).messages.length, 2);
    const current = await c.acquireLease.execute(scope, consultation.id, manager, { inputRevision: 3, requestId: "current" });
    setNow(current.lease.expiresAt + 1);
    await assert.rejects(c.addMessage.execute(scope, consultation.id, manager, { body: "Expired response", expectedRevision: 3, leaseId: current.lease.id, requestId: "expired" }));
    const replacement = await c.acquireLease.execute(scope, consultation.id, manager, { inputRevision: 3, requestId: "replacement" });
    assert.notEqual(replacement.lease.id, current.lease.id);
    await c.cancel.execute(scope, consultation.id, human, { expectedRevision: 3, reason: "No longer needed", requestId: "cancel" });
    const leases = await database.selectFrom("consultation_lease").select("released_at").where("consultation_id", "=", consultation.id).execute();
    assert.ok(leases.every(({ released_at }) => released_at !== null));
    assert.equal((await c.get.execute(scope, consultation.id, [project.id])).consultation.status, "canceled");
  } finally { await database.destroy(); await runtime.dispose(); }
});

test("D1 Workspace consultation hands off to a Project and records only accepted document references", async () => {
  const { runtime, database, consultations: c, project, uow } = await setup();
  try {
    const scope: ConsultationScope = { kind: "workspace", workspaceId: project.workspaceId };
    const strategist: ConsultationActor = { ...manager, role: "strategist" };
    const { consultation } = await c.create.execute(scope, strategist, input);
    await c.resolve.execute(scope, consultation.id, human, { conclusion: "Use D1", rationale: "Selected", expectedRevision: 1, requestId: "decide" });
    const followupInput = { kind: "adr", repositoryId: project.repositories[0]!.id, title: "Record decision", purpose: "Persist", decision: "D1", rationale: "Cloudflare", verification: "Review", resumptionDependency: "ADR required", requestId: "followup" };
    await assert.rejects(c.requestFollowup.execute(project.id, scope, consultation.id, manager, followupInput));
    const handoff = await c.handOff.execute(project.workspaceId, consultation.id, strategist, { projectId: project.id, requestId: "handoff" });
    assert.equal(handoff.handoff.projectId, project.id);
    assert.deepEqual((await c.handOff.execute(project.workspaceId, consultation.id, strategist, { projectId: project.id, requestId: "handoff-again" })).handoff, handoff.handoff);
    const { followup } = await c.requestFollowup.execute(project.id, scope, consultation.id, manager, followupInput);
    const artifactInput = { followupId: followup.id, taskId: followup.taskId, repositoryId: followup.repositoryId, path: "docs/adr/d1.md", commitSha: "a".repeat(40), requestId: "artifact" };
    await assert.rejects(c.recordArtifact.execute(project.id, scope, consultation.id, manager, artifactInput), /accepted document Task/);
    // 受入済みWorkの証跡をfixtureとして準備し、Collaborationが正本を照合することを検証する。
    await database.updateTable("task").set({ status: "accepted" }).where("id", "=", followup.taskId).execute();
    await database.insertInto("change_log").values({ project_id: project.id, entity_id: followup.taskId, type: "TASK_ACCEPTED", principal_id: "accepting-manager", claim_id: null,
      payload: JSON.stringify({ deliverables: [{ repositoryId: followup.repositoryId, commitSha: artifactInput.commitSha, paths: [artifactInput.path], pullRequestUrl: null }] }), occurred_at: 2000 }).execute();
    await assert.rejects(c.recordArtifact.execute(project.id, scope, consultation.id, manager, { ...artifactInput, path: "other.md" }), /not among the deliverables/);
    const recorded = await c.recordArtifact.execute(project.id, scope, consultation.id, manager, artifactInput);
    assert.equal(recorded.followup.status, "reflected");
    assert.equal(recorded.followup.blocksResumption, false);
    assert.equal((await c.recordArtifact.execute(project.id, scope, consultation.id, manager, artifactInput)).artifact.id, recorded.artifact.id);
    const artifacts = await uow.execute((store) => store.listArtifacts(consultation.id));
    assert.equal(artifacts.length, 1);
    assert.equal((await database.selectFrom("activity").selectAll().where("type", "=", "consultation.followup_reflected").execute()).length, 1);
  } finally { await database.destroy(); await runtime.dispose(); }
});
