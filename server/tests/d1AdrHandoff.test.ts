import assert from "node:assert/strict";
import test from "node:test";
import { planDirectionDecisionRecord } from "@compass/direction";
import { inputHash } from "@compass/shared";
import { createD1TestRuntime, initializeD1TestSchema } from "./support/d1Runtime.ts";
import { createD1OrganizationInfrastructure } from "../src/bootstrap/d1OrganizationInfrastructure.ts";
import { activityActorContext } from "../src/infrastructure/activity/NodeActivityActorContext.ts";
import { asDirectionDatabase } from "../src/infrastructure/database/contextDatabase.ts";
import { D1AdrHandoffRepository } from "../src/infrastructure/repository/d1/D1AdrHandoffRepository.ts";

const projectInput = { name: "Product", description: null, mission: "Goal", vision: null, principles: [], constraints: ["Initial constraint"],
  repositories: [{ name: "Source", url: "https://github.com/example/source", requiredChecks: [] }], resources: [] };
const setup = async () => {
  const context = await createD1TestRuntime();
  try {
    await initializeD1TestSchema(context.binding);
    const organization = createD1OrganizationInfrastructure(context.database, context.binding, activityActorContext);
    const project = await organization.projectRepository.create(projectInput);
    await context.database.insertInto("intent").values({ id: "intent", workspace_id: project.workspaceId, title: "Intent", desired_state: "Goal",
      status: "active", version: 1, meaning_version: 1, created_at: 1, updated_at: 1 }).execute();
    const decision = { intentId: "intent", intentVersion: 1, judgment: "ADR title", reason: "Reason", options: ["One", "Two"],
      usedSyntheses: [], usedFindingIds: [], requestKey: "decision", runRef: "run", principalId: "strategist" };
    const plan = planDirectionDecisionRecord(asDirectionDatabase(context.database), project.workspaceId, "decision", "adr_candidate", null,
      { requests: [], syntheses: [], conflicts: [] }, decision, inputHash(decision), 100);
    await context.binding.batch(plan.mutations.map((query) => context.binding.prepare(query.sql).bind(...query.parameters)));
    const repository = new D1AdrHandoffRepository(asDirectionDatabase(context.database), context.binding, () => 100);
    const input = { projectId: project.id, decisionId: "decision", repositoryId: project.repositories[0]!.id,
      correlationId: "correlation", requestKey: "request", principalId: "strategist" };
    return { ...context, ...organization, project, repository, input };
  } catch (error) { await context.runtime.dispose(); throw error; }
};

test("D1 ADR handoffs and references converge on retries and protect scope and referenced Repositories", async () => {
  const { runtime, binding, database, project, repository, input, projectRepository, workspaceRepository } = await setup();
  try {
    const replies = await Promise.all([repository.createRequest(project.workspaceId, input), repository.createRequest(project.workspaceId, input)]);
    assert.deepEqual(replies.map(({ kind }) => kind).sort(), ["created", "replayed"]);
    const created = replies[0]!;
    assert.ok("request" in created);
    assert.deepEqual(created.request.payload.constraints, projectInput.constraints);
    assert.equal(created.request.payload.expectedAdrContent, "# ADR title\n\n## Reason\nReason\n\n## Options considered\n- One\n- Two");
    assert.deepEqual(await repository.createRequest("other", input), { kind: "project_not_in_workspace" });
    assert.deepEqual(await repository.createRequest(project.workspaceId, { ...input, correlationId: "changed" }), { kind: "key_conflict", requestKey: input.requestKey });
    assert.deepEqual(await repository.createRequest(project.workspaceId, { ...input, requestKey: "missing", repositoryId: "missing" }), { kind: "repository_not_found", repositoryId: "missing" });
    const reference = { ...input, requestKey: "reference", path: "docs/adr/0001.md", commitSha: "a".repeat(40), pullRequestUrl: null };
    assert.deepEqual(await repository.recordReference(project.workspaceId, { ...reference, correlationId: "missing" }), { kind: "handoff_request_not_found" });
    await binding.prepare("CREATE TRIGGER reject_reference BEFORE INSERT ON adr_reference BEGIN SELECT RAISE(ABORT, 'reference failure'); END;").run();
    await assert.rejects(repository.recordReference(project.workspaceId, reference), /reference failure/);
    assert.deepEqual(await repository.findReferencesByWorkspace(project.workspaceId), []);
    await binding.prepare("DROP TRIGGER reject_reference").run();
    const references = await Promise.all([repository.recordReference(project.workspaceId, reference), repository.recordReference(project.workspaceId, reference)]);
    assert.deepEqual(references.map(({ kind }) => kind).sort(), ["created", "replayed"]);
    assert.deepEqual((await repository.findReferencesByWorkspace(project.workspaceId)).map(({ path, commitSha }) => [path, commitSha]), [[reference.path, reference.commitSha]]);
    assert.deepEqual(await repository.findReferencesByWorkspace("other"), []);
    const removal = await projectRepository.update(project.id, { repositories: [] });
    assert.equal(removal.kind, "repository_referenced");
    await projectRepository.archive(project.id, "done");
    assert.deepEqual(await repository.recordReference(project.workspaceId, reference), { kind: "project_archived" });
    await workspaceRepository.archive(project.workspaceId, "done");
    assert.deepEqual(await repository.createRequest(project.workspaceId, input), { kind: "workspace_archived" });
  } finally { await database.destroy(); await runtime.dispose(); }
});

test("D1 ADR payload retries configuration changes and refuses a concurrently removed Repository", async () => {
  const { runtime, binding, database, project, input, projectRepository, workspaceRepository } = await setup();
  try {
    let inject = true;
    const racing = new Proxy(binding, { get(target, property) {
      if (property === "batch") return async (statements: Parameters<typeof binding.batch>[0]) => {
        if (inject) {
          inject = false;
          await workspaceRepository.update(project.workspaceId, { constraints: ["Updated constraint"] });
          await projectRepository.update(project.id, { repositories: [{ id: input.repositoryId, name: "New source", url: "https://github.com/example/new" }] });
        }
        return target.batch(statements);
      };
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    } });
    const repository = new D1AdrHandoffRepository(asDirectionDatabase(database), racing);
    const created = await repository.createRequest(project.workspaceId, input);
    assert.ok(created.kind === "created");
    assert.deepEqual(created.request.payload.constraints, ["Updated constraint"]);
    assert.equal(created.request.payload.repositoryName, "New source");
    assert.equal(created.request.payload.repositoryUrl, "https://github.com/example/new");
    const other = await projectRepository.createInWorkspace(project.workspaceId, projectInput);
    assert.ok(other.kind === "created");
    let remove = true;
    const removing = new Proxy(binding, { get(target, property) {
      if (property === "batch") return async (statements: Parameters<typeof binding.batch>[0]) => {
        if (remove) { remove = false; await projectRepository.update(other.project.id, { repositories: [] }); }
        return target.batch(statements);
      };
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    } });
    const removedId = other.project.repositories[0]!.id;
    const rejected = await new D1AdrHandoffRepository(asDirectionDatabase(database), removing).createRequest(project.workspaceId,
      { ...input, requestKey: "removed", projectId: other.project.id, repositoryId: removedId });
    assert.deepEqual(rejected, { kind: "repository_not_found", repositoryId: removedId });
    assert.equal((await database.selectFrom("adr_handoff_request").selectAll().where("request_key", "=", "removed").execute()).length, 0);
  } finally { await database.destroy(); await runtime.dispose(); }
});
