import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/bootstrap/app.ts";
import { createApplicationServices } from "../src/bootstrap/createApplicationServices.ts";
import { createDatabase } from "../src/bootstrap/database/createDatabase.ts";

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
      dataPreparation: { scope: string; actors: Record<string, string>; allowedTools: string[]; projectIds: string[] };
      scenarios: { scenario: string; workspaceId: string; intentId: string; outcomeId: string;
        projects: { id: string }[]; evaluationId?: string; decisionId?: string; researchRequestId?: string }[];
    };
    assert.match(manifest.headSha, /^[a-f0-9]{40}$/);
    assert.match(manifest.preparationScriptSha256, /^[a-f0-9]{64}$/);
    assert.equal(manifest.dataPreparation.scope, "isolated-preview-only");
    assert.ok(manifest.dataPreparation.allowedTools.includes("claim_task"));
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
      // Manager can add missing preview data using the same public MCP entry as browser fetch.
      const call = async (role: string, name: string, args: object) => {
        assert.ok(manifest.dataPreparation.allowedTools.includes(name));
        const response = await app.request("/mcp", { method: "POST", headers: {
          "Content-Type": "application/json", Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${manifest.dataPreparation.actors[role]}`,
          "X-Compass-Active-Role": role,
        }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
          name, arguments: { ...args, requestId: crypto.randomUUID() },
        } }) });
        assert.equal(response.status, 200);
        const line = (await response.text()).split("\n").find((line) => line.startsWith("data: "));
        assert.ok(line);
        const { result } = JSON.parse(line.slice(6));
        assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent));
        return result.structuredContent;
      };
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
