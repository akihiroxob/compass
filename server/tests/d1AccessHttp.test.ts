import { D1IntentRepository } from "../src/infrastructure/repository/d1/D1IntentRepository.ts";
import { D1RuntimeEventRepository } from "../src/infrastructure/repository/d1/D1RuntimeEventRepository.ts";
import { D1OutcomeTargetProjectRepository } from "../src/infrastructure/repository/d1/D1OutcomeTargetProjectRepository.ts";
import { D1OutcomeRepository } from "../src/infrastructure/repository/d1/D1OutcomeRepository.ts";
import { D1IntentMetricRepository } from "../src/infrastructure/repository/d1/D1IntentMetricRepository.ts";
import { D1ResearchRepository } from "../src/infrastructure/repository/d1/D1ResearchRepository.ts";
import { D1DirectionDecisionRepository } from "../src/infrastructure/repository/d1/D1DirectionDecisionRepository.ts";
import { D1AdrHandoffRepository } from "../src/infrastructure/repository/d1/D1AdrHandoffRepository.ts";
import { planD1DirectionActivity } from "../src/infrastructure/repository/d1/planD1DirectionActivity.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { createD1TestRuntime, initializeD1TestSchema } from "./support/d1Runtime.ts";
import { createApplicationServices } from "../src/bootstrap/createApplicationServices.ts";
import { createD1AccessInfrastructure } from "../src/bootstrap/d1AccessInfrastructure.ts";
import { createD1OrganizationInfrastructure } from "../src/bootstrap/d1OrganizationInfrastructure.ts";
import { activityActorContext } from "../src/infrastructure/activity/NodeActivityActorContext.ts";
import { asAccessDatabase, asDirectionDatabase, asActivityDatabase } from "../src/infrastructure/database/contextDatabase.ts";
import { createApp } from "../src/presentation/http/createApp.ts";

test("shared HTTP auth, Organization, Access and Direction routes use D1 repositories through DI", async () => {
  const { runtime, binding, database } = await createD1TestRuntime();
  try {
    await initializeD1TestSchema(binding);
    const services = createApplicationServices(database, undefined, Date.now, { initialOwnerEmail: "owner@example.test" }, {},
      createD1OrganizationInfrastructure(database, binding, activityActorContext), {
        access: createD1AccessInfrastructure(asAccessDatabase(database), binding, Date.now),
        direction: {
          intentRepository: new D1IntentRepository(asDirectionDatabase(database), binding,
            planD1DirectionActivity(asActivityDatabase(database), activityActorContext)),
          runtimeEventRepository: new D1RuntimeEventRepository(asDirectionDatabase(database), binding),
          outcomeTargetProjectRepository: new D1OutcomeTargetProjectRepository(asDirectionDatabase(database), binding),
          outcomeRepository: new D1OutcomeRepository(asDirectionDatabase(database), binding,
            planD1DirectionActivity(asActivityDatabase(database), activityActorContext)),
          intentMetricRepository: new D1IntentMetricRepository(asDirectionDatabase(database), binding),
          researchRepository: new D1ResearchRepository(asDirectionDatabase(database), binding,
            planD1DirectionActivity(asActivityDatabase(database), activityActorContext)),
          directionDecisionRepository: new D1DirectionDecisionRepository(asDirectionDatabase(database), binding,
            planD1DirectionActivity(asActivityDatabase(database), activityActorContext)),
          adrHandoffRepository: new D1AdrHandoffRepository(asDirectionDatabase(database), binding),
        },
      });
    const origin = "http://localhost";
    const app = createApp(services, { humanAuth: { mode: "trusted-local", publicOrigin: origin } });
    const login = await app.request("/auth/local/login", { method: "POST", headers: { Origin: origin }, body: new URLSearchParams({ email: "owner@example.test" }) });
    assert.equal(login.status, 302, await login.clone().text());
    const cookie = login.headers.get("set-cookie")?.match(/compass_session=([^;]+)/)?.[0];
    assert.ok(cookie);
    const session = await app.request("/api/auth/session", { headers: { Cookie: cookie } });
    assert.equal(session.status, 200);
    const { csrfToken } = await session.json() as { csrfToken: string };
    const request = (path: string, method = "GET", body?: object) => app.request(path, { method,
      headers: { Cookie: cookie, Origin: origin, "X-Compass-CSRF": csrfToken, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const created = await request("/api/workspaces", "POST", { name: "Business", mission: "Goal" });
    assert.equal(created.status, 201, await created.clone().text());
    const { workspace } = await created.json() as { workspace: { id: string } };
    const projectResponse = await request(`/api/workspaces/${workspace.id}/projects`, "POST", { name: "Product", repositories: [{ name: "Source", url: "https://github.com/example/source" }] });
    assert.equal(projectResponse.status, 201, await projectResponse.clone().text());
    const { project } = await projectResponse.json() as { project: { id: string; repositories: { id: string }[] } };
    const grant = await request(`/api/projects/${project.id}/grants`, "POST", { role: "worker", principalId: "worker" });
    assert.equal(grant.status, 201, await grant.clone().text());
    const issued = await request(`/api/projects/${project.id}/credentials`, "POST", { kind: "agent", principalId: "worker" });
    assert.equal(issued.status, 201, await issued.clone().text());
    const { token, credential } = await issued.json() as { token: string; credential: { id: string } };
    const caller = await services.authenticateAccessCredentialUseCase.execute(token);
    assert.ok(caller);
    const rotated = await request(`/api/projects/${project.id}/credentials/${credential.id}/rotate`, "POST", {});
    assert.equal(rotated.status, 201, await rotated.clone().text());
    const intentResponse = await request(`/api/workspaces/${workspace.id}/intents`, "POST", { title: "Intent", desiredState: "Business goal" });
    assert.equal(intentResponse.status, 201, await intentResponse.clone().text());
    const { intent } = await intentResponse.json() as { intent: { id: string } };
    const edited = await request(`/api/workspaces/${workspace.id}/intents/${intent.id}`, "PATCH", { expectedVersion: 1, title: "Updated intent" });
    assert.equal(edited.status, 200, await edited.clone().text());
    const outcomeResponse = await request(`/api/workspaces/${workspace.id}/intents/${intent.id}/outcomes`, "POST", {
      title: "Outcome", description: "Description", rationale: "Reason", intentVersion: 2,
      successCriteria: [{ description: "Criterion", measurement: "Measure" }],
    });
    assert.equal(outcomeResponse.status, 201, await outcomeResponse.clone().text());
    const { outcome } = await outcomeResponse.json() as { outcome: { id: string } };
    const outcomeEdit = await request(`/api/workspaces/${workspace.id}/intents/${intent.id}/outcomes/${outcome.id}`, "PATCH", { expectedRevision: 1, title: "Updated Outcome" });
    assert.equal(outcomeEdit.status, 200, await outcomeEdit.clone().text());
    await services.setOutcomeTargetProjectUseCase.execute(workspace.id, outcome.id, project.id);
    const targetsResponse = await request(`/api/workspaces/${workspace.id}/outcomes/${outcome.id}/target-projects`);
    assert.equal(targetsResponse.status, 200, await targetsResponse.clone().text());
    const { targets } = await targetsResponse.json() as { targets: { projectId: string }[] };
    assert.deepEqual(targets.map(({ projectId }) => projectId), [project.id]);
    for (const role of ["strategist", "evaluator"]) {
      const grantResponse = await request(`/api/workspaces/${workspace.id}/grants`, "POST", { principalId: role, role });
      assert.equal(grantResponse.status, 201, await grantResponse.clone().text());
    }
    await services.defineIntentMetricUseCase.execute("strategist", workspace.id, intent.id, { key: "revenue", name: "Revenue", unit: "JPY", staleAfterDays: 2 });
    await services.recordIntentMetricObservationsUseCase.execute("evaluator", workspace.id, intent.id, { metricKey: "revenue", observations: [{
      periodStart: "2026-01-01", periodEnd: "2026-01-01", status: "observed", value: 0, source: { name: "Report" }, observedAt: Date.parse("2026-01-02T00:00:00Z"),
    }] });
    const metricsResponse = await request(`/api/workspaces/${workspace.id}/intents/${intent.id}/metrics?from=2026-01-01&to=2026-01-02`);
    assert.equal(metricsResponse.status, 200, await metricsResponse.clone().text());
    const { metrics } = await metricsResponse.json() as { metrics: { series: { points: { value: number }[] } }[] };
    assert.equal(metrics[0]?.series.points[0]?.value, 0);
    const research = await services.createResearchRequestUseCase.execute(workspace.id, { requestKey: "http-research", kind: "decision",
      originIntentId: intent.id, question: "Which approach?", scope: "Scope", completionCondition: "Evidence exists", budgetTotal: 10 });
    const researchResult = await services.registerResearchResultUseCase.execute(workspace.id, research.id, { requestKey: "http-result", principalId: "researcher",
      runRef: "run", summary: "Result", budgetUsed: 1, evidenceRefs: [{ kind: "url", uri: "https://example.test", retrievedAt: 100 }],
      findings: [{ statement: "Finding", confidence: "high", observedAt: 100, evidenceIndexes: [0] }], unknowns: [], options: [], risks: [] });
    await services.registerResearchSynthesisUseCase.execute(workspace.id, research.id, { requestKey: "http-synthesis", principalId: "researcher", runRef: "run",
      conclusion: "Conclusion", findingIds: researchResult.findings.map(({ id }) => id), validAsOf: 100, risks: [], options: [], unknowns: [] });
    await services.completeResearchRequestUseCase.execute(workspace.id, research.id, { conclusion: "completed" });
    const researchResponse = await request(`/api/workspaces/${workspace.id}/research-requests/${research.id}`);
    assert.equal(researchResponse.status, 200, await researchResponse.clone().text());
    const { detail } = await researchResponse.json() as { detail: { request: { status: string }; results: unknown[] } };
    assert.equal(detail.request.status, "completed");
    assert.equal(detail.results.length, 1);
    await services.createDirectionDecisionUseCase.execute(workspace.id, "strategist", { type: "policy_proposal", intentId: intent.id,
      intentVersion: 2, judgment: "Keep the current scope", reason: "Evidence", requestKey: "http-decision", runRef: "run" });
    const next = await services.decideNextOutcomeUseCase.execute(workspace.id, "strategist", { intentId: intent.id, intentVersion: 2,
      judgment: "Next step", reason: "Evidence", requestKey: "http-next", runRef: "run", outcome: {
        title: "Next Outcome", description: "Next change", rationale: "Reason", successCriteria: [{ description: "Criterion", measurement: "Measure" }],
      } });
    assert.equal(next.decision.outcomeId, next.outcome.id);
    const decisionsResponse = await request(`/api/workspaces/${workspace.id}/intents/${intent.id}/decisions`);
    assert.equal(decisionsResponse.status, 200, await decisionsResponse.clone().text());
    const { decisions } = await decisionsResponse.json() as { decisions: unknown[] };
    assert.equal(decisions.length, 2);
    const candidate = await services.createDirectionDecisionUseCase.execute(workspace.id, "strategist", { type: "adr_candidate", intentId: intent.id,
      intentVersion: 2, judgment: "Record this architecture", reason: "Evidence", requestKey: "http-adr", runRef: "run" });
    const handoffInput = { projectId: project.id, repositoryId: project.repositories[0]!.id, decisionId: candidate.decision.id, correlationId: "http-adr" };
    await services.createAdrHandoffRequestUseCase.execute(workspace.id, "strategist", { ...handoffInput, requestKey: "http-handoff" });
    await services.recordAdrReferenceUseCase.execute(workspace.id, "strategist", { ...handoffInput, requestKey: "http-reference", path: "docs/adr/0001.md", commitSha: "a".repeat(40) });
    const referencesResponse = await request(`/api/workspaces/${workspace.id}/adr-references`);
    assert.equal(referencesResponse.status, 200, await referencesResponse.clone().text());
    const { references } = await referencesResponse.json() as { references: unknown[] };
    assert.equal(references.length, 1);
    assert.equal((await request(`/api/workspaces/${workspace.id}/intents/${intent.id}/abandon`, "POST", { expectedVersion: 2 })).status, 200);
    const runtimeResponse = await request(`/api/workspaces/${workspace.id}/credentials`, "POST", {
      kind: "runtime", principalId: "runtime", scopes: ["runtime:event:read", "runtime:event:ack"],
    });
    assert.equal(runtimeResponse.status, 201, await runtimeResponse.clone().text());
    const runtimeCredential = await runtimeResponse.json() as { token: string };
    const events = await app.request(`/api/workspaces/${workspace.id}/runtime-events`, { headers: { Authorization: `Bearer ${runtimeCredential.token}` } });
    assert.equal(events.status, 200, await events.clone().text());
    assert.equal((await events.json() as { events: unknown[] }).events.length, 4);
    assert.equal((await request("/api/auth/logout", "POST")).status, 204);
    assert.equal((await request(`/api/workspaces/${workspace.id}`)).status, 401);
  } finally {
    await database.destroy();
    await runtime.dispose();
  }
});
