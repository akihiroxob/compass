import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { register } from "tsx/esm/api";
import type { ResearchRequest, ResearchRequestDetail } from "../src/web/researchForm.ts";
import { sql } from "kysely";
import { CreateWorkspaceProjectUseCase, CreateWorkspaceUseCase, SQLiteProjectRepository, SQLiteWorkspaceRepository } from "@compass/organization";
import { createDatabase } from "../src/bootstrap/database/createDatabase.ts";
import { initializeSchema } from "../src/bootstrap/database/initializeSchema.ts";
import { createApplicationServices } from "../src/bootstrap/createApplicationServices.ts";
import { asOrganizationDatabase } from "../src/bootstrap/database/contextDatabase.ts";
import { projectRepositoryReferenceFinder } from "../src/infrastructure/repository/contextAdapters.ts";
import { createSignedInApp } from "./support/humanSession.ts";

const requestInput = (intentId: string) => ({ requestKey: "research", kind: "decision", originIntentId: intentId, question: "Question", scope: "Scope", completionCondition: "Evidence", budgetTotal: 10 });

test("Workspace Research stores and queries without a Project and rejects cross-Workspace origins", async () => {
  const database = createDatabase(":memory:");
  try {
    await initializeSchema(database);
    const services = createApplicationServices(database);
    const create = new CreateWorkspaceUseCase(new SQLiteWorkspaceRepository(asOrganizationDatabase(database)));
    const a = await create.execute({ name: "A", mission: "A" });
    const b = await create.execute({ name: "B", mission: "B" });
    const direction = services.workspaceDirection;
    const intent = await direction.createIntentUseCase.execute(a.id, { title: "Intent", desiredState: "State" });
    // These use cases are internal until Workspace Grant/Credential and public entry points are connected.
    const research = await direction.createResearchRequestUseCase.execute(a.id, requestInput(intent.id));
    assert.equal(research.workspaceId, a.id);
    assert.equal("projectId" in research, false);
    assert.deepEqual(await direction.createResearchRequestUseCase.execute(a.id, requestInput(intent.id)), research);
    await assert.rejects(direction.createResearchRequestUseCase.execute(b.id, requestInput(intent.id)), { code: "NOT_FOUND" });
    await assert.rejects(direction.getResearchRequestUseCase.execute(b.id, research.id), { code: "NOT_FOUND" });
    const events = await database.selectFrom("runtime_event").selectAll().execute();
    assert.equal(events.length, 1);
    assert.ok(events.every(event => event.workspace_id === a.id && !("project_id" in event)));
    for (const table of ["research_request", "research_result", "research_finding", "research_evidence_ref", "research_synthesis", "direction_decision"]) {
      const columns = (await sql<{ name: string }>`select name from pragma_table_info(${table})`.execute(database)).rows;
      assert.ok(columns.some(row => row.name === "workspace_id"), table);
      assert.ok(!columns.some(row => row.name === "project_id"), table);
    }
  } finally { await database.destroy(); }
});

const setup = async (path = ":memory:") => {
  const database = createDatabase(path);
  await initializeSchema(database);
  const services = createApplicationServices(database);
  const workspace = await new CreateWorkspaceUseCase(new SQLiteWorkspaceRepository(asOrganizationDatabase(database))).execute({ name: "Workspace", mission: "Mission" });
  const intent = await services.workspaceDirection.createIntentUseCase.execute(workspace.id, { title: "Intent", desiredState: "State" });
  const createProject = new CreateWorkspaceProjectUseCase(new SQLiteProjectRepository(asOrganizationDatabase(database), projectRepositoryReferenceFinder));
  return { database, services, workspace, intent, direction: services.workspaceDirection, createProject };
};
const resultInput = (requestKey = "result", resourceId?: string) => ({ requestKey, principalId: "researcher", runRef: "run", summary: "Summary", budgetUsed: 0,
  evidenceRefs: [{ kind: "repository_file", uri: "docs/evidence.md", retrievedAt: 1, versionHash: "revision", resourceId }],
  findings: [{ statement: "Finding", confidence: "high", observedAt: 1, evidenceIndexes: [0] }] });
const synthesisInput = (findingId: string, overrides: object = {}) => ({ requestKey: "synthesis", principalId: "researcher", runRef: "run", conclusion: "Conclusion", findingIds: [findingId], validAsOf: 1, ...overrides });
const decisionInput = (intentId: string, overrides: object = {}) => ({ requestKey: "decision", runRef: "run", type: "adr_candidate", intentId,
  judgment: "Document the choice", reason: "Evidence supports the choice", ...overrides });

test("Research一覧のWorkspace応答から閲覧Projectの詳細リンクを辿れる", async () => {
  const { database, services, workspace, intent, direction, createProject } = await setup();
  const web = register({ namespace: "research-ui", tsconfig: fileURLToPath(new URL("../src/web/tsconfig.json", import.meta.url)) });
  try {
    const project = await createProject.execute(workspace.id, { name: "Project" });
    const research = await direction.createResearchRequestUseCase.execute(workspace.id, requestInput(intent.id));
    await direction.registerResearchResultUseCase.execute(workspace.id, research.id, resultInput());
    const app = await createSignedInApp(database, services);
    const response = await app.request(`/api/projects/${project.id}/research-requests`);
    assert.equal(response.status, 200);
    const { requests } = await response.json() as { requests: ResearchRequest[] };
    assert.equal(requests.length, 1);
    assert.equal("projectId" in requests[0]!, false);
    assert.equal(requests[0]!.workspaceId, workspace.id);

    // Web用tsconfigで実際のReact行を描画し、生成したhrefを詳細APIへ渡す。
    const { RequestRow } = await web.import("../src/web/features/research/ResearchSection.tsx", import.meta.url) as {
      RequestRow: ComponentType<{ projectId: string; request: ResearchRequest }>;
    };
    const { MemoryRouter } = await web.import("react-router-dom", import.meta.url);
    const markup = renderToStaticMarkup(createElement(MemoryRouter, null,
      createElement(RequestRow, { projectId: project.id, request: requests[0]! })));
    const href = /href="([^"]+)"/.exec(markup)?.[1];
    assert.equal(href, `/projects/${project.id}/research/${research.id}`);
    const match = /^\/projects\/([^/]+)\/research\/([^/]+)$/.exec(href!);
    assert.ok(match);
    const detailResponse = await app.request(`/api/projects/${match[1]}/research-requests/${match[2]}`);
    assert.equal(detailResponse.status, 200);
    const { detail } = await detailResponse.json() as { detail: ResearchRequestDetail };
    assert.equal(detail.request.id, research.id);
    assert.equal(detail.results[0]!.summary, "Summary");
  } finally { await web.unregister(); await database.destroy(); }
});

test("Research version, Decision evidence and ADR artifact references persist through file DB reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "compass-workspace-research-"));
  const path = join(directory, "test.db");
  let database: ReturnType<typeof createDatabase> | undefined;
  try {
    const fixture = await setup(path);
    database = fixture.database;
    const { direction, workspace, intent, createProject } = fixture;
    const project = await createProject.execute(workspace.id, { name: "A", repositories: [{ name: "Repo", url: "https://example.com/repo" }], resources: [{ name: "Docs", url: "https://example.com/docs" }] });
    await createProject.execute(workspace.id, { name: "B" });
    const request = await direction.createResearchRequestUseCase.execute(workspace.id, requestInput(intent.id));
    const result = await direction.registerResearchResultUseCase.execute(workspace.id, request.id, resultInput("result", project.resources[0]!.id));
    const findingId = result.findings[0]!.id;
    const v1 = await direction.registerResearchSynthesisUseCase.execute(workspace.id, request.id, synthesisInput(findingId));
    const v2 = await direction.registerResearchSynthesisUseCase.execute(workspace.id, request.id, synthesisInput(findingId, { requestKey: "v2", supersedesId: v1.id, conclusion: "Updated" }));
    assert.equal(v2.version, 2);
    await direction.completeResearchRequestUseCase.execute(workspace.id, request.id, { conclusion: "completed" });
    const { decision } = await direction.createDirectionDecisionUseCase.execute(workspace.id, "strategist", decisionInput(intent.id, { usedSyntheses: [{ synthesisId: v2.id, version: 2 }], usedFindingIds: [findingId] }));
    const adrInput = { projectId: project.id, decisionId: decision.id, repositoryId: project.repositories[0]!.id, correlationId: "adr", requestKey: "adr" };
    const handoff = await direction.createAdrHandoffRequestUseCase.execute(workspace.id, "strategist", adrInput);
    const reference = await direction.recordAdrReferenceUseCase.execute(workspace.id, "strategist", { ...adrInput, requestKey: "reference", path: "docs/adr/0001.md", commitSha: "a".repeat(40) });
    assert.equal(handoff.workspaceId, workspace.id);
    assert.equal(handoff.payload.projectId, project.id);
    assert.equal(reference.projectId, project.id);
    assert.equal("body" in reference, false);
    const events = await database.selectFrom("runtime_event").selectAll().execute();
    assert.equal(events.length, 2);
    assert.ok(events.every(event => event.workspace_id === workspace.id && !("project_id" in event)));
    const researcher = await direction.getResearcherContextUseCase.execute("researcher", workspace.id, request.id);
    assert.equal(researcher.workspace.id, workspace.id);
    assert.equal(researcher.results[0]!.evidenceRefs[0]!.resourceId, project.resources[0]!.id);
    const strategist = await direction.getStrategistContextUseCase.execute("strategist", workspace.id);
    assert.equal(strategist.research!.syntheses[0]!.version, 2);
    assert.equal("results" in strategist.research!, false);
    assert.equal("evidenceRefs" in strategist.research!, false);
    const detail = await direction.getResearchRequestUseCase.execute(workspace.id, request.id);
    await database.destroy();
    database = createDatabase(path);
    await initializeSchema(database);
    await initializeSchema(database);
    const reopened = createApplicationServices(database).workspaceDirection;
    assert.deepEqual(await reopened.getResearchRequestUseCase.execute(workspace.id, request.id), detail);
    assert.deepEqual(await reopened.listDirectionDecisionsUseCase.execute(workspace.id, intent.id), [decision]);
    assert.deepEqual(await reopened.listAdrReferencesUseCase.execute(workspace.id), [reference]);
    assert.deepEqual((await sql`pragma foreign_key_check`.execute(database)).rows, []);
  } finally { await database?.destroy(); await rm(directory, { recursive: true, force: true }); }
});

test("Workspace checks reject foreign Findings, Syntheses, Resources and ADR target Projects", async () => {
  const { database, workspace, intent, direction, createProject } = await setup();
  try {
    const other = await new CreateWorkspaceUseCase(new SQLiteWorkspaceRepository(asOrganizationDatabase(database))).execute({ name: "Other", mission: "Other" });
    const otherIntent = await direction.createIntentUseCase.execute(other.id, { title: "Other", desiredState: "Other" });
    const foreignProject = await createProject.execute(other.id, { name: "Foreign", resources: [{ name: "Docs", url: "https://example.com/docs" }], repositories: [{ name: "Repo", url: "https://example.com/repo" }] });
    const foreignRequest = await direction.createResearchRequestUseCase.execute(other.id, requestInput(otherIntent.id));
    const foreignResult = await direction.registerResearchResultUseCase.execute(other.id, foreignRequest.id, resultInput());
    const foreignFinding = foreignResult.findings[0]!.id;
    const foreignSynthesis = await direction.registerResearchSynthesisUseCase.execute(other.id, foreignRequest.id, synthesisInput(foreignFinding));
    const request = await direction.createResearchRequestUseCase.execute(workspace.id, requestInput(intent.id));
    await assert.rejects(direction.registerResearchResultUseCase.execute(workspace.id, request.id, resultInput("resource", foreignProject.resources[0]!.id)), { code: "VALIDATION_ERROR" });
    await assert.rejects(direction.registerResearchSynthesisUseCase.execute(workspace.id, request.id, synthesisInput(foreignFinding)), { code: "VALIDATION_ERROR" });
    await assert.rejects(direction.createDirectionDecisionUseCase.execute(workspace.id, "strategist", decisionInput(intent.id, { usedSyntheses: [{ synthesisId: foreignSynthesis.id, version: 1 }] })), { code: "VALIDATION_ERROR" });
    const { decision } = await direction.createDirectionDecisionUseCase.execute(workspace.id, "strategist", decisionInput(intent.id));
    await assert.rejects(direction.createAdrHandoffRequestUseCase.execute(workspace.id, "strategist", { projectId: foreignProject.id, repositoryId: foreignProject.repositories[0]!.id, decisionId: decision.id, correlationId: "adr", requestKey: "adr" }), { code: "NOT_FOUND" });
    assert.equal((await direction.getResearchRequestUseCase.execute(workspace.id, request.id)).results.length, 0);
    // DB also enforces Workspace ownership of origins and parent-child records.
    await assert.rejects(database.updateTable("research_request").set({ origin_intent_id: otherIntent.id }).where("id", "=", request.id).execute(), /FOREIGN KEY/);
    await assert.rejects(database.updateTable("research_result").set({ workspace_id: workspace.id }).where("id", "=", foreignResult.id).execute(), /FOREIGN KEY/);
    await assert.rejects(database.updateTable("direction_decision").set({ intent_id: otherIntent.id }).where("id", "=", decision.id).execute(), /FOREIGN KEY/);
    assert.deepEqual((await sql`pragma foreign_key_check`.execute(database)).rows, []);
  } finally { await database.destroy(); }
});

test("Workspace archive rejects Research, Decision and ADR writes but retains history", async () => {
  const { database, workspace, intent, direction, createProject } = await setup();
  try {
    const project = await createProject.execute(workspace.id, { name: "Project", repositories: [{ name: "Repo", url: "https://example.com/repo" }] });
    const request = await direction.createResearchRequestUseCase.execute(workspace.id, requestInput(intent.id));
    const result = await direction.registerResearchResultUseCase.execute(workspace.id, request.id, resultInput());
    const { decision } = await direction.createDirectionDecisionUseCase.execute(workspace.id, "strategist", decisionInput(intent.id));
    await new SQLiteWorkspaceRepository(asOrganizationDatabase(database)).archive(workspace.id, "Done");
    for (const write of [
      () => direction.createResearchRequestUseCase.execute(workspace.id, { ...requestInput(intent.id), requestKey: "new" }),
      () => direction.registerResearchResultUseCase.execute(workspace.id, request.id, resultInput("new")),
      () => direction.registerResearchSynthesisUseCase.execute(workspace.id, request.id, synthesisInput(result.findings[0]!.id)),
      () => direction.completeResearchRequestUseCase.execute(workspace.id, request.id, { conclusion: "insufficient", stopReason: "No evidence" }),
      () => direction.createDirectionDecisionUseCase.execute(workspace.id, "strategist", decisionInput(intent.id, { requestKey: "new" })),
      () => direction.createAdrHandoffRequestUseCase.execute(workspace.id, "strategist", { projectId: project.id, repositoryId: project.repositories[0]!.id, decisionId: decision.id, correlationId: "adr", requestKey: "adr" }),
    ]) await assert.rejects(write(), { code: "CONFLICT", details: { workspaceStatus: "archived" } });
    assert.equal((await direction.getResearchRequestUseCase.execute(workspace.id, request.id)).results.length, 1);
  } finally { await database.destroy(); }
});

test("Research and Decision writes roll back with canonical Workspace Activity failure", async () => {
  const { database, workspace, intent, direction } = await setup();
  try {
    await sql`create trigger reject_activity before insert on activity begin select raise(abort, 'activity rejected'); end`.execute(database);
    await assert.rejects(direction.createResearchRequestUseCase.execute(workspace.id, requestInput(intent.id)), /activity rejected/);
    await assert.rejects(direction.createDirectionDecisionUseCase.execute(workspace.id, "strategist", decisionInput(intent.id)), /activity rejected/);
    assert.deepEqual(await database.selectFrom("research_request").selectAll().execute(), []);
    assert.deepEqual(await database.selectFrom("direction_decision").selectAll().execute(), []);
  } finally { await database.destroy(); }
});

test("Researcher and Strategist Context bound history and advertise omitted records", async () => {
  const { database, workspace, intent, direction } = await setup();
  try {
    const request = await direction.createResearchRequestUseCase.execute(workspace.id, requestInput(intent.id));
    for (let index = 0; index < 12; index++) await direction.registerResearchResultUseCase.execute(workspace.id, request.id, resultInput(`result-${index}`));
    const context = await direction.getResearcherContextUseCase.execute("researcher", workspace.id, request.id);
    assert.equal(context.results.length, 10);
    assert.equal(context.results[0]!.sequence, 3);
    assert.deepEqual(context.history, { resultCount: 12, synthesisCount: 0, truncated: true });
    assert.equal((await direction.getResearchRequestUseCase.execute(workspace.id, request.id)).results.length, 12);
    for (let index = 0; index < 52; index++) await direction.createResearchRequestUseCase.execute(workspace.id, { ...requestInput(intent.id), requestKey: `request-${index}` });
    const strategist = await direction.getStrategistContextUseCase.execute("strategist", workspace.id);
    assert.equal(strategist.research!.requests.length, 50);
    assert.equal(strategist.researchHistory!.requestCount, 53);
    assert.equal(strategist.researchHistory!.truncated, true);
  } finally { await database.destroy(); }
});

test("shared Workspace Research and Context remain unavailable from Project Web/API/MCP entry points", async () => {
  const { database, workspace, intent, direction, createProject, services } = await setup();
  try {
    const a = await createProject.execute(workspace.id, { name: "A" });
    await createProject.execute(workspace.id, { name: "B" });
    const request = await direction.createResearchRequestUseCase.execute(workspace.id, requestInput(intent.id));
    const app = await createSignedInApp(database, services);
    for (const path of [`/api/projects/${a.id}/research-requests`, `/api/projects/${a.id}/research-requests/${request.id}`, `/api/projects/${a.id}/intents/${intent.id}/decisions`, `/api/projects/${a.id}/adr-references`]) {
      const response = await app.request(path);
      assert.equal(response.status, 409, path);
      assert.equal(JSON.stringify(await response.json()).includes(request.question), false);
    }
    await services.grantProjectRoleUseCase.execute(a.id, { principalId: "researcher", role: "researcher" });
    await services.grantProjectRoleUseCase.execute(a.id, { principalId: "strategist", role: "strategist" });
    for (const [name, role, args] of [
      ["get_researcher_context", "researcher", { projectId: a.id, requestId: request.id }],
      ["get_strategist_context", "strategist", { projectId: a.id }],
    ] as const) {
      const response = await app.request("/mcp", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${role}`, "X-Compass-Active-Role": role },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
      const data = (await response.text()).split("\n").find(line => line.startsWith("data: "));
      assert.ok(data);
      const result = JSON.parse(data.slice(6)).result;
      assert.equal(result.structuredContent.error.reason, "workspace_direction_required");
      assert.equal(JSON.stringify(result).includes(request.id), false);
    }
    assert.equal((await app.request(`/api/workspaces/${workspace.id}/research-requests`)).status, 404);
  } finally { await database.destroy(); }
});

test("removing a Project Resource preserves Evidence URI and revision", async () => {
  const { database, workspace, intent, direction, createProject, services } = await setup();
  try {
    const project = await createProject.execute(workspace.id, { name: "Project", resources: [{ name: "Docs", url: "https://example.com/docs" }] });
    const request = await direction.createResearchRequestUseCase.execute(workspace.id, requestInput(intent.id));
    await direction.registerResearchResultUseCase.execute(workspace.id, request.id, resultInput("result", project.resources[0]!.id));
    await services.updateProjectUseCase.execute(project.id, { resources: [] });
    const evidence = (await direction.getResearchRequestUseCase.execute(workspace.id, request.id)).results[0]!.evidenceRefs[0]!;
    assert.equal(evidence.resourceId, null);
    assert.equal(evidence.uri, "docs/evidence.md");
    assert.equal(evidence.versionHash, "revision");
  } finally { await database.destroy(); }
});
