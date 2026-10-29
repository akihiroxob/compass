import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/bootstrap/app.ts";
import { createApplicationServices } from "../src/bootstrap/createApplicationServices.ts";
import { createDatabase } from "../src/bootstrap/database/createDatabase.ts";
import { toolCallerMetaKey, toolContextMetaKey } from "../src/mcp/toolContext.ts";
// @ts-expect-error The preparation scripts are plain ESM without declarations.
import { createPreviewMcpClient, PreviewOperationError, toolCallerMetaKey as policyCallerKey, toolContextMetaKey as policyContextKey } from "../../scripts/preview-operation-policy.mjs";

type Preparation = { scope: string; endpointPath: string; actors: Record<string, string>; projectIds: string[]; workspaceIds: string[];
  operationPolicy: { contexts: string[]; caller: string }; observedTools: { name: string; context: string | null; caller: string | null }[];
  consultationResumptionEnabled: boolean };
type Reflection = { status: string; repository: { id: string; bareRepositoryPath: string };
  consultations: { scope: "project" | "workspace"; consultationId: string; followupId: string; taskId: string; path: string;
    artifact: { repositoryId: string; path: string; commitSha: string } }[] };
type PolicyClient = {
  listTools(role: string): Promise<{ name: string; _meta?: Record<string, unknown> }[]>;
  permittedTools(role: string): Promise<string[]>;
  call(role: string, name: string, args?: object): Promise<any>;
  observe(scope: { projectId?: string; workspaceId?: string }, value: unknown): void;
};
const clientOf = (preparation: Preparation, send: (url: string, init: RequestInit) => Response | Promise<Response>): PolicyClient =>
  createPreviewMcpClient({ origin: "http://localhost", preparation, fetch: send });
const rejectsWith = (operation: Promise<unknown>, kind: string) =>
  assert.rejects(operation, (error: unknown) => error instanceof PreviewOperationError && (error as { kind: string }).kind === kind);

const root = fileURLToPath(new URL("../../", import.meta.url));
const ownerEmail = "preview-owner@example.test";
const prepare = (data: string, extraEnv: Record<string, string> = {}) => spawnSync(process.execPath,
  ["--import", "tsx", "scripts/prepare-browser-verification.mjs", "--data-dir", data], {
    cwd: root, encoding: "utf8", env: { ...process.env, COMPASS_DB_PATH: join(data, "preview.db"),
      COMPASS_AUTH_MODE: "trusted-local", COMPASS_INITIAL_OWNER_EMAIL: ownerEmail, ...extraEnv },
  });

test("preview fixtures persist usable Direction scenarios and enforce Viewer scope through HTTP", async () => {
  const data = await mkdtemp(join(tmpdir(), "compass-browser-fixtures-"));
  try {
    const prepared = prepare(data);
    assert.equal(prepared.status, 0, prepared.stderr);
    const manifest = JSON.parse(await readFile(join(data, "browser-fixtures.json"), "utf8")) as {
      headSha: string; preparationScriptSha256: string;
      dataPreparation: Preparation;
      scenarios: { scenario: string; workspaceId: string; intentId: string; outcomeId: string;
        projects: { id: string }[]; evaluationId?: string; decisionId?: string; researchRequestId?: string; consultationReflection?: Reflection }[];
    };
    assert.match(manifest.headSha, /^[a-f0-9]{40}$/);
    assert.match(manifest.preparationScriptSha256, /^[a-f0-9]{64}$/);
    assert.equal(manifest.dataPreparation.scope, "isolated-preview-only");
    assert.equal("allowedTools" in manifest.dataPreparation, false, "Permission must not be a hand-written tool name list");
    assert.deepEqual(manifest.dataPreparation.operationPolicy.contexts, ["work", "collaboration"]);
    // observedTools records the inspected contract and its classification; it is an observation, not the permission.
    const observed = new Map(manifest.dataPreparation.observedTools.map((tool) => [tool.name, tool]));
    assert.equal(observed.get("claim_task")?.context, "work");
    assert.equal(observed.get("record_consultation_artifact")?.context, "collaboration");
    assert.equal(observed.get("create_project")?.context, null);
    assert.equal(manifest.dataPreparation.consultationResumptionEnabled, true);
    assert.deepEqual(manifest.dataPreparation.workspaceIds, manifest.scenarios.map(({ workspaceId }) => workspaceId));
    const database = createDatabase(join(data, "preview.db"));
    try {
      let now = Date.now();
      const services = createApplicationServices(database, undefined, () => now, { initialOwnerEmail: ownerEmail });
      const app = createApp(services, { humanAuth: { mode: "trusted-local", publicOrigin: "http://localhost" } });
      const login = async (email: string) => {
        const response = await app.request("/auth/local/login", { method: "POST", headers: { Origin: "http://localhost" }, body: new URLSearchParams({ email }) });
        assert.equal(response.status, 302);
        const cookie = response.headers.get("set-cookie")?.match(/compass_session=([^;]+)/)?.[0];
        assert.ok(cookie);
        return cookie;
      };
      const owner = await login(ownerEmail);
      const viewer = await login("preview-viewer@example.test");
      for (const scenario of manifest.scenarios) {
        const base = `/api/workspaces/${scenario.workspaceId}`;
        const targets = await app.request(`${base}/outcomes/${scenario.outcomeId}/target-projects`, { headers: { Cookie: owner } });
        assert.equal(targets.status, 200);
        assert.equal((await targets.json()).targets.length, scenario.scenario === "no-target" ? 0 : 2);
        const work = await app.request(`${base}/intents/${scenario.intentId}/outcome-target-work`, { headers: { Cookie: owner } });
        assert.equal(work.status, 200);
        const targetWork = (await work.json()).outcomes[0].targets as { work: { storyCount: number; state: string } | null }[];
        assert.equal(targetWork.filter(({ work }) => work !== null).length,
          scenario.scenario === "no-target" ? 0 : scenario.scenario === "partial-work" ? 1 : 2);
        assert.ok(targetWork.every(({ work }) => work === null || (work.storyCount === 1 && work.state === "accepted")));
        const executions = await app.request(`${base}/outcomes/${scenario.outcomeId}/target-executions`, { headers: { Cookie: owner } });
        assert.equal(executions.status, 200);
        const executionData = await executions.json();
        if (scenario.scenario === "partial-work") {
          assert.equal(executionData.evaluability.status, "awaiting_execution");
          assert.equal(executionData.targets.filter((target: { execution: unknown }) => target.execution !== null).length, 1);
        }
        if (scenario.scenario === "evaluated") {
          assert.equal(executionData.evaluability.status, "evaluable");
          const evaluations = await app.request(`${base}/outcomes/${scenario.outcomeId}/evaluations`, { headers: { Cookie: viewer } });
          assert.equal(evaluations.status, 200);
          const saved = (await evaluations.json()).evaluations;
          assert.equal(saved[0].id, scenario.evaluationId);
          assert.deepEqual(saved[0].criteria.map((item: { verdict: string }) => item.verdict), ["met", "not_met"]);
          assert.ok(saved[0].snapshot.targets.every((target: { evidence: { versionHash: string }[] }) =>
            target.evidence.length === 1 && target.evidence[0]!.versionHash === manifest.headSha));
          const decisions = await app.request(`${base}/intents/${scenario.intentId}/decisions`, { headers: { Cookie: viewer } });
          assert.equal(decisions.status, 200);
          const decision = (await decisions.json()).decisions[0];
          assert.equal(decision.id, scenario.decisionId);
          assert.equal(decision.evaluationId, scenario.evaluationId);
          const research = await app.request(`${base}/research-requests/${scenario.researchRequestId}`, { headers: { Cookie: viewer } });
          assert.equal(research.status, 200);
        }
        if (scenario.projects.length) {
          assert.equal((await app.request(`/api/projects/${scenario.projects[0]!.id}/execution`, { headers: { Cookie: viewer } })).status, 200);
          assert.equal((await app.request(`/api/projects/${scenario.projects[1]!.id}/execution`, { headers: { Cookie: viewer } })).status, 404);
          const session = await app.request("/api/auth/session", { headers: { Cookie: viewer } });
          const { csrfToken } = await session.json();
          assert.equal((await app.request(base, { method: "PATCH", headers: {
            Cookie: viewer, Origin: "http://localhost", "X-Compass-CSRF": csrfToken, "Content-Type": "application/json",
          }, body: JSON.stringify({ mission: "unauthorized" }) })).status, 403);
        }
      }
      // Reflected Consultations were prepared through public MCP: real commit, normal Review/Acceptance and artifact registration.
      const reflection = manifest.scenarios.find(({ scenario }) => scenario === "evaluated")!.consultationReflection!;
      assert.equal(reflection.status, "prepared");
      assert.deepEqual(reflection.consultations.map(({ scope }) => scope), ["project", "workspace"]);
      for (const item of reflection.consultations) {
        const exists = spawnSync("git", ["--git-dir", reflection.repository.bareRepositoryPath, "cat-file", "-e", `${item.artifact.commitSha}:${item.artifact.path}`]);
        assert.equal(exists.status, 0, "The artifact commit must exist in the dedicated verification Repository");
        const api = `/api${item.path}`;
        for (const cookie of [owner, viewer]) {
          const detail = await app.request(api, { headers: { Cookie: cookie } });
          assert.equal(detail.status, 200);
          const [followup] = (await detail.json()).followups;
          assert.equal(followup.id, item.followupId);
          assert.equal(followup.status, "reflected");
          assert.equal(followup.task.status, "accepted");
          assert.equal(followup.artifacts[0].commitSha, item.artifact.commitSha);
          assert.equal(followup.artifacts[0].path, item.artifact.path);
        }
      }
      // Manager can add missing preview data using the same public MCP entry as browser fetch, under the scope-based policy.
      const client = clientOf(manifest.dataPreparation, (url, init) => app.request(url, init));
      const call = (role: string, name: string, args: object) => client.call(role, name, args);
      const projectIds = manifest.scenarios.find(({ scenario }) => scenario === "evaluated")!.projects.map(({ id }) => id);
      const tasks: { id: string; claim: { claimId: string; expiresAt: number } }[] = [];
      for (const projectId of projectIds) {
        assert.ok(manifest.dataPreparation.projectIds.includes(projectId));
        const story = await call("manager", "issue_story", { projectId, title: "Claim表示用Story" });
        const task = await call("manager", "issue_task", { projectId, storyId: story.id, title: "Claim表示用Task" });
        const claim = await call("worker", "claim_task", { taskId: task.id });
        tasks.push({ id: task.id, claim });
      }
      const read = async (index: number) => {
        const response = await app.request(`/api/projects/${projectIds[index]}/execution`, { headers: { Cookie: owner } });
        assert.equal(response.status, 200);
        return response.json();
      };
      const own = await read(0);
      assert.ok(own.tasks.some((task: { id: string; activeClaim: { principalId: string } | null }) =>
        task.id === tasks[0]!.id && task.activeClaim?.principalId === manifest.dataPreparation.actors.worker));
      assert.ok(!own.tasks.some((task: { id: string }) => task.id === tasks[1]!.id));
      now += 1_000;
      const renewed = await call("worker", "renew_claim", { claimId: tasks[0]!.claim.claimId });
      assert.ok(renewed.expiresAt > tasks[0]!.claim.expiresAt);
      now = renewed.expiresAt + 1;
      const expired = (await read(0)).tasks.find((task: { id: string }) => task.id === tasks[0]!.id);
      assert.equal(expired.activeClaim, null);
      assert.equal(expired.reclaimable, true);
      // A Manager must be able to construct the consultation-wait UI Given through permitted public tools.
      const waitingTask = await call("manager", "issue_task", { projectId: projectIds[0], title: "相談待機表示用Task" });
      const claim = await call("worker", "claim_task", { taskId: waitingTask.id });
      const consultation = await call("worker", "create_consultation", { projectId: projectIds[0],
        title: "検証用選択", question: "blueとredのどちらですか", blockingReason: "Humanの選択が必要", recommendation: "blue",
        impact: "検証Taskのみ", refs: [{ kind: "task", id: waitingTask.id }] });
      const artifacts = join(data, "artifacts");
      const cloned = spawnSync("git", ["clone", "--shared", root, artifacts], { encoding: "utf8" });
      assert.equal(cloned.status, 0, cloned.stderr);
      await mkdir(join(artifacts, ".compass-ralph"));
      const contextPath = join(artifacts, ".compass-ralph/context.json");
      await writeFile(contextPath, "{}");
      await writeFile(join(artifacts, "pending.txt"), "preserved artifact");
      const metadata = join(data, "runtime.json");
      await writeFile(metadata, JSON.stringify({ worktreePath: artifacts, contextPath }));
      const inspected = spawnSync(process.execPath, [join(root, "ralph/runtime/consultation-context.mjs"), metadata], { encoding: "utf8" });
      assert.equal(inspected.status, 0, inspected.stderr);
      const waited = await call("worker", "wait_for_consultation", { taskId: waitingTask.id, claimId: claim.claimId,
        consultationIds: [consultation.consultation.id], reason: "Humanの選択待ち", runtime: JSON.parse(inspected.stdout) });
      assert.equal(waited.state, "waiting");
      const resumptions = await call("worker", "list_consultation_resumptions", { projectId: projectIds[0] });
      assert.equal(resumptions.resumptions.find((item: { taskId: string }) => item.taskId === waitingTask.id)?.state, "waiting");
      assert.equal(await readFile(join(artifacts, "pending.txt"), "utf8"), "preserved artifact");

      await assertScopedPolicy(manifest.dataPreparation, app, services, ownerEmail);
    } finally { await database.destroy(); }
    const before = await readFile(join(data, "preview.db"));
    assert.notEqual(prepare(data).status, 0);
    assert.deepEqual(await readFile(join(data, "preview.db")), before);
  } finally { await rm(data, { recursive: true, force: true }); }
});

test("preview preparation rejects remote auth and paths outside its dedicated DB", async () => {
  const data = await mkdtemp(join(tmpdir(), "compass-browser-fixtures-guard-"));
  try {
    assert.notEqual(prepare(data, { COMPASS_AUTH_MODE: "remote" }).status, 0);
    assert.notEqual(prepare(data, { COMPASS_DB_PATH: join(data, "production.db") }).status, 0);
    await assert.rejects(readFile(join(data, "preview.db")), { code: "ENOENT" });
  } finally { await rm(data, { recursive: true, force: true }); }
});

type App = ReturnType<typeof createApp>;
type Services = ReturnType<typeof createApplicationServices>;

/** The policy permits current Work/Collaboration tools by classification and scope, and distinguishes each failure. */
const assertScopedPolicy = async (preparation: Preparation, app: App, services: Services, email: string) => {
  assert.equal(policyContextKey, toolContextMetaKey);
  assert.equal(policyCallerKey, toolCallerMetaKey);
  const client = clientOf(preparation, (url, init) => app.request(url, init));
  const permitted = await client.permittedTools("manager");
  for (const name of ["issue_task", "claim_acceptance", "request_consultation_followup", "record_consultation_artifact"]) assert.ok(permitted.includes(name), name);
  // Human management, Direction and Runtime Credential tools stay outside even though tools/list exposes them in trusted-local.
  for (const name of ["create_project", "update_project", "create_intent", "get_project_consultation_state"]) {
    assert.ok(!permitted.includes(name), name);
    await rejectsWith(client.call("manager", name, {}), "policy_denied");
  }
  await rejectsWith(client.call("manager", "no_such_tool", {}), "tool_unavailable");
  await rejectsWith(client.call("operator", "list_tasks", { projectId: preparation.projectIds[0] }), "policy_denied");
  // A Project outside the manifest is denied by the policy even when the actor holds a Grant there.
  const login = await services.localDevLoginUseCase.execute({ email, previousSessionToken: null });
  assert.equal(login.kind, "logged_in");
  const owner = { kind: "human" as const, humanUserId: login.kind === "logged_in" ? login.session.humanUserId : "" };
  const outside = await services.human.createWorkspace.execute({ name: "Policy外", mission: "scope外の確認" }, owner);
  const project = await services.human.createWorkspaceProject.execute(owner, outside.id, { name: "Policy外Project" });
  await services.grantProjectRoleUseCase.execute(project.id, { principalId: preparation.actors.manager!, role: "manager" });
  await rejectsWith(client.call("manager", "issue_task", { projectId: project.id, title: "scope外" }), "policy_denied");
  await rejectsWith(client.call("manager", "list_consultations", { workspaceId: outside.id }), "policy_denied");
  // Entity IDs alone do not place a call in scope: Task/Claim/Story/Consultation IDs outside the manifest are denied even with a Grant.
  const coordination = services.taskCoordinationService;
  await services.grantProjectRoleUseCase.execute(project.id, { principalId: preparation.actors.worker!, role: "worker" });
  const story = await coordination.issueStoryAsOperator(preparation.actors.manager!, project.id, { title: "scope外Story", description: null });
  const task = await coordination.issueTask(preparation.actors.manager!, { projectId: project.id, storyId: story.id, title: "scope外Task" }, crypto.randomUUID());
  const claim = await coordination.claimTask(preparation.actors.worker!, task.id, crypto.randomUUID());
  for (const [role, name, args] of [
    ["manager", "cancel_task", { taskId: task.id, reason: "scope外" }],
    ["worker", "claim_task", { taskId: task.id }],
    ["worker", "list_task_comments", { taskId: task.id }],
    ["worker", "renew_claim", { claimId: claim.claimId }],
    ["manager", "issue_task", { projectId: preparation.projectIds[0], storyId: story.id, title: "scope外Storyへの追加" }],
    ["manager", "list_tasks", {}],
  ] as const) await rejectsWith(client.call(role, name, args), "policy_denied");
  assert.equal((await coordination.getTaskDetailOfProject(project.id, task.id))?.task.status, "doing");
  assert.throws(() => client.observe({ projectId: project.id }, task), (error: unknown) => error instanceof PreviewOperationError);
  // Entities observed through in-scope calls can be targeted by ID.
  const inside = await client.call("manager", "issue_task", { projectId: preparation.projectIds[0], title: "scope内Task" });
  const insideClaim = await client.call("worker", "claim_task", { taskId: inside.id });
  assert.ok((await client.call("worker", "renew_claim", { claimId: insideClaim.claimId })).expiresAt);
  // Inside the policy the server still enforces Roles: a Worker cannot cancel a Task.
  await rejectsWith(client.call("worker", "cancel_task", { taskId: inside.id, reason: "Workerによる取消" }), "authorization_denied");
  await rejectsWith(clientOf(preparation, () => { throw new Error("connection refused"); }).call("manager", "list_tasks", {}), "transport_failure");
  await rejectsWith(clientOf(preparation, () => new Response("unavailable", { status: 502 })).listTools("manager"), "transport_failure");

  // A tool added later in the same context is discovered from tools/list and used without editing any name list.
  const future = { name: "preview_future_work_tool", inputSchema: { type: "object", properties: { projectId: { type: "string" }, requestId: { type: "string" } } },
    _meta: { [toolContextMetaKey]: "work", [toolCallerMetaKey]: "agent" } };
  const calls: Record<string, unknown>[] = [];
  const extended = clientOf(preparation, async (url, init) => {
    const body = JSON.parse(String(init.body));
    if (body.method === "tools/call" && body.params.name === future.name) {
      calls.push(body.params.arguments);
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [], structuredContent: { ok: true } } });
    }
    const response = await app.request(url, init);
    if (body.method !== "tools/list") return response;
    const line = (await response.text()).split("\n").find((item) => item.startsWith("data: "))!;
    const message = JSON.parse(line.slice(6));
    message.result.tools.push(future);
    return Response.json(message);
  });
  assert.deepEqual(await extended.call("manager", future.name, { projectId: preparation.projectIds[0] }), { ok: true });
  assert.equal(typeof calls[0]!.requestId, "string");
  await rejectsWith(extended.call("manager", future.name, { projectId: project.id }), "policy_denied");
};
