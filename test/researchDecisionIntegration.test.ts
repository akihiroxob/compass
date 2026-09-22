import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/app.ts";
import { createApplicationServices } from "../src/createApplicationServices.ts";
import { createDatabase } from "../src/infrastructure/database/createDatabase.ts";
import { initializeSchema } from "../src/infrastructure/database/initializeSchema.ts";

/**
 * 空DBから、Intent作成（Initial Research Request自動作成）→ Researcher（Result・Synthesis・確定）→
 * Strategist（Intent Brief・Direction Decision・Outcome・ADR handoff/参照）→ Human向けWeb API参照までを、
 * 実HTTPサーバーとMCP SDK clientで通す（docs/research-decision-adr-design.md 段階7）。
 *
 * 外部RuntimeとWachaは未接続で、Wachaが完了させたADR参照はfixtureとして`record_adr_reference`へ直接与える。
 * ここでの検証はfixture契約の確認であり、Lv6の自律運転実証ではない。
 */

type ToolResult = { isError?: boolean; structuredContent?: Record<string, any>; content?: { type: string; text: string }[] };
type Running = { baseUrl: string; port: number; close: () => Promise<void> };

const listen = (app: ReturnType<typeof createApp>, port = 0) =>
  new Promise<Running>((resolve, reject) => {
    const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, (info: AddressInfo) => {
      resolve({
        baseUrl: `http://127.0.0.1:${info.port}`,
        port: info.port,
        close: () =>
          new Promise<void>((done, fail) => {
            const http = server as Server;
            http.closeAllConnections();
            http.close((error) => (error ? fail(error) : done()));
          }),
      });
    });
    (server as Server).once("error", reject);
  });

// sandbox等でloopbackへのlistenが禁止された環境では、実HTTPサーバーを使う本ファイルは実行できない。
const loopbackDenial = await new Promise<string | undefined>((resolve) => {
  const probe = createServer();
  probe.once("error", (error: NodeJS.ErrnoException) => resolve(error.code === "EPERM" || error.code === "EACCES" ? error.code : undefined));
  probe.listen(0, "127.0.0.1", () => probe.close(() => resolve(undefined)));
});
const loopbackSkip = loopbackDenial ? `127.0.0.1へのlistenが拒否された（${loopbackDenial}）。sandbox外で実行すること` : false;

const withEnvironment = async (run: (start: () => Promise<Running & { stop: () => Promise<void> }>) => Promise<void>) => {
  const directory = await mkdtemp(join(tmpdir(), "compass-research-decision-"));
  const path = join(directory, "integration.db");
  const stops: (() => Promise<void>)[] = [];
  try {
    await run(async () => {
      const database = createDatabase(path);
      await initializeSchema(database);
      const running = await listen(createApp(createApplicationServices(database)));
      const stop = async () => {
        await running.close();
        await database.destroy();
      };
      stops.push(stop);
      return { ...running, stop };
    });
  } finally {
    for (const stop of stops) await stop().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
};

const closeConnection = { Connection: "close" };

const api = async (baseUrl: string, method: string, path: string, body?: unknown) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...closeConnection },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
};

const withAgent = async <T>(baseUrl: string, principal: string | undefined, run: (client: Client) => Promise<T>) => {
  const client = new Client({ name: "research-decision-integration-test", version: "0" });
  const requestInit = { headers: { ...closeConnection, ...(principal === undefined ? {} : { Authorization: `Bearer ${principal}` }) } };
  await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit }));
  try {
    return await run(client);
  } finally {
    await client.close();
  }
};

const call = async (client: Client, name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as ToolResult;

const errorCode = (result: ToolResult) => {
  assert.equal(result.isError, true, JSON.stringify(result));
  return result.structuredContent?.error.code as string;
};

const grant = (baseUrl: string, projectId: string, principalId: string, role: string) =>
  api(baseUrl, "POST", `/api/projects/${projectId}/grants`, { principalId, role });

const createProject = async (baseUrl: string, name: string) =>
  (
    await api(baseUrl, "POST", "/api/projects", {
      name,
      mission: "Keep direction explicit",
      constraints: ["No autonomous execution yet", "Human owns Mission changes"],
      repositories: [{ name: "compass", url: "https://example.invalid/compass" }],
    })
  ).body.project as { id: string; repositories: { id: string }[] };

const createIntent = async (baseUrl: string, projectId: string, title: string) =>
  (await api(baseUrl, "POST", `/api/projects/${projectId}/intents`, { title, desiredState: "S" })).body.intent as { id: string };

const initialRequestOf = async (baseUrl: string, projectId: string, intentId: string) => {
  const { body } = await api(baseUrl, "GET", `/api/projects/${projectId}/research-requests?originIntentId=${intentId}`);
  const requests = body.requests as { id: string; status: string }[];
  assert.equal(requests.length, 1, JSON.stringify(requests));
  return requests[0]!;
};

test(
  "空DBから、Intent作成（Initial Research Request）→ Researcher（Result・Synthesis・completed）→ " +
    "Strategist（Intent Brief・decide_next_outcome・ADR handoff/参照）→ Web APIの参照まで、Human操作なしで完了する",
  { skip: loopbackSkip },
  async () => {
    await withEnvironment(async (start) => {
      const server = await start();
      const project = await createProject(server.baseUrl, "Compass");
      const repositoryId = project.repositories[0]!.id;
      const intent = await createIntent(server.baseUrl, project.id, "Ship the claim strategy");

      // Initial Research RequestはIntent作成と同一transactionでCompass application層が自動作成する。
      const initial = await initialRequestOf(server.baseUrl, project.id, intent.id);
      assert.equal(initial.status, "requested");

      assert.equal((await grant(server.baseUrl, project.id, "researcher-1", "researcher")).status, 201);
      assert.equal((await grant(server.baseUrl, project.id, "strat-1", "strategist")).status, 201);

      const now = Date.now();
      const { findingId, synthesisId } = await withAgent(server.baseUrl, "researcher-1", async (client) => {
        const context = await call(client, "get_researcher_context", { projectId: project.id, requestId: initial.id });
        assert.equal(context.isError, undefined);
        assert.equal(context.structuredContent?.request.status, "requested");

        const result = await call(client, "register_research_result", {
          projectId: project.id,
          requestId: initial.id,
          requestKey: "result-1",
          runRef: "run-001",
          summary: "Leases avoid stuck claims.",
          budgetUsed: 30,
          evidenceRefs: [{ kind: "url", uri: "https://example.invalid/leases", retrievedAt: now }],
          findings: [{ statement: "Leases expire without heartbeats.", confidence: "high", observedAt: now, evidenceIndexes: [0] }],
          options: ["Lease with renew"],
        });
        assert.equal(result.isError, undefined, JSON.stringify(result));
        const registeredFindingId = result.structuredContent?.result.findings[0].id as string;

        const synthesis = await call(client, "register_research_synthesis", {
          projectId: project.id,
          requestId: initial.id,
          requestKey: "synthesis-1",
          runRef: "run-001",
          conclusion: "Use leases with explicit renew.",
          findingIds: [registeredFindingId],
          validAsOf: now,
        });
        assert.equal(synthesis.isError, undefined, JSON.stringify(synthesis));

        const completed = await call(client, "complete_research_request", { projectId: project.id, requestId: initial.id, conclusion: "completed" });
        assert.equal(completed.isError, undefined, JSON.stringify(completed));
        assert.equal(completed.structuredContent?.request.status, "completed");

        // Researcherは方針を決められない（職務分離）。
        assert.equal(errorCode(await call(client, "create_outcome", { projectId: project.id, intentId: intent.id, title: "x", description: "x", rationale: "x", successCriteria: [{ description: "x", measurement: "x" }] })), "FORBIDDEN");

        return { findingId: registeredFindingId, synthesisId: synthesis.structuredContent?.synthesis.id as string };
      });

      // completedはWeb APIから状態・Result・Synthesisの来歴として参照できる。
      const detail = (await api(server.baseUrl, "GET", `/api/projects/${project.id}/research-requests/${initial.id}`)).body.detail;
      assert.equal(detail.request.status, "completed");
      assert.equal(detail.results.length, 1);
      assert.equal(detail.syntheses.length, 1);

      const { outcomeId, decisionId } = await withAgent(server.baseUrl, "strat-1", async (client) => {
        // Strategistは登録できない（職務分離）。
        assert.equal(
          errorCode(await call(client, "register_research_result", { projectId: project.id, requestId: initial.id, requestKey: "x", runRef: "x", summary: "x" })),
          "FORBIDDEN",
        );

        const context = await call(client, "get_strategist_context", { projectId: project.id });
        assert.equal(context.isError, undefined);
        assert.equal(context.structuredContent?.research.syntheses.length, 1);
        const synthesis = context.structuredContent?.research.syntheses[0];
        assert.equal(synthesis.synthesisId, synthesisId);
        assert.equal(synthesis.version, 1);
        assert.deepEqual(synthesis.findingIds, [findingId]);

        const decided = await call(client, "decide_next_outcome", {
          projectId: project.id,
          intentId: intent.id,
          judgment: "Adopt lease-based claiming",
          reason: "Synthesis shows leases avoid stuck claims without a heartbeat service.",
          options: ["Do nothing", "Adopt lease-based claiming"],
          usedSyntheses: [{ synthesisId: synthesis.synthesisId, version: synthesis.version }],
          usedFindingIds: [findingId],
          requestKey: "decision-next-outcome-1",
          runRef: "strategist-run-1",
          outcome: {
            title: "No duplicate claims",
            description: "Claims are exclusive.",
            rationale: "Leases avoid stuck claims (Synthesis-backed).",
            successCriteria: [{ description: "duplicate_claim_count = 0", measurement: "Count duplicates" }],
          },
        });
        assert.equal(decided.isError, undefined, JSON.stringify(decided));
        assert.equal(decided.structuredContent?.outcome.status, "active");
        assert.equal(decided.structuredContent?.decision.type, "next_outcome");
        assert.equal(decided.structuredContent?.decision.outcomeId, decided.structuredContent?.outcome.id);

        // ADR Candidate → Wacha handoff fixture → 完了結果の参照、まで一続きで検証する。
        const adrDecision = await call(client, "create_direction_decision", {
          projectId: project.id,
          intentId: intent.id,
          type: "adr_candidate",
          judgment: "Adopt lease-based claiming",
          reason: "Requires a repository-level ADR to bind Workers to the new claim protocol.",
          options: ["Adopt lease-based claiming"],
          usedSyntheses: [{ synthesisId: synthesis.synthesisId, version: synthesis.version }],
          usedFindingIds: [findingId],
          requestKey: "decision-adr-1",
          runRef: "strategist-run-1",
        });
        assert.equal(adrDecision.isError, undefined, JSON.stringify(adrDecision));
        const adrDecisionId = adrDecision.structuredContent?.decision.id as string;

        const handoff = await call(client, "create_adr_handoff_request", {
          projectId: project.id,
          decisionId: adrDecisionId,
          repositoryId,
          correlationId: "adr-thread-1",
          requestKey: "handoff-1",
        });
        assert.equal(handoff.isError, undefined, JSON.stringify(handoff));
        assert.ok(handoff.structuredContent?.request.payload.expectedAdrContent.includes("Adopt lease-based claiming"));

        // Wachaが完了させた結果（fixture）をCompassへ記録する。実Wacha・GitHub APIは未接続。
        const reference = await call(client, "record_adr_reference", {
          projectId: project.id,
          decisionId: adrDecisionId,
          repositoryId,
          path: "docs/adr/0001-lease-based-claiming.md",
          commitSha: "a".repeat(40),
          pullRequestUrl: "https://example.invalid/pull/1",
          correlationId: "adr-thread-1",
          requestKey: "reference-1",
        });
        assert.equal(reference.isError, undefined, JSON.stringify(reference));

        return { outcomeId: decided.structuredContent?.outcome.id as string, decisionId: adrDecisionId };
      });

      // Human向けWeb APIから、Decision（next_outcome・adr_candidate）とADR参照を辿れる。
      const decisions = (await api(server.baseUrl, "GET", `/api/projects/${project.id}/intents/${intent.id}/decisions`)).body.decisions as { type: string; outcomeId: string | null }[];
      assert.deepEqual(decisions.map((decision) => decision.type).sort(), ["adr_candidate", "next_outcome"]);
      assert.equal(decisions.find((decision) => decision.type === "next_outcome")?.outcomeId, outcomeId);

      const references = (await api(server.baseUrl, "GET", `/api/projects/${project.id}/adr-references`)).body.references as { decisionId: string; path: string; commitSha: string }[];
      assert.equal(references.length, 1);
      assert.equal(references[0]!.decisionId, decisionId);
      assert.equal(references[0]!.path, "docs/adr/0001-lease-based-claiming.md");

      const outcomeViaWeb = (await api(server.baseUrl, "GET", `/api/projects/${project.id}/intents/${intent.id}/outcomes/${outcomeId}`)).body.outcome;
      assert.equal(outcomeViaWeb.status, "active");
      await server.stop();
    });
  },
);

test(
  "completed / insufficient / not_needed / 未確定（保留中）を区別し、別ProjectのGrantでは拒否される",
  { skip: loopbackSkip },
  async () => {
    await withEnvironment(async (start) => {
      const server = await start();
      const project = await createProject(server.baseUrl, "P");
      const other = await createProject(server.baseUrl, "Q");
      await grant(server.baseUrl, project.id, "researcher-1", "researcher");
      await grant(server.baseUrl, other.id, "researcher-q", "researcher");

      // 1件目: Result・Synthesisを伴うcompleted。
      const intentA = await createIntent(server.baseUrl, project.id, "A");
      const requestA = await initialRequestOf(server.baseUrl, project.id, intentA.id);
      await withAgent(server.baseUrl, "researcher-1", async (client) => {
        const now = Date.now();
        const result = await call(client, "register_research_result", {
          projectId: project.id,
          requestId: requestA.id,
          requestKey: "result-a",
          runRef: "run-a",
          summary: "s",
          evidenceRefs: [{ kind: "url", uri: "https://example.invalid/a", retrievedAt: now }],
          findings: [{ statement: "f", confidence: "high", observedAt: now, evidenceIndexes: [0] }],
        });
        const findingId = result.structuredContent?.result.findings[0].id as string;
        await call(client, "register_research_synthesis", { projectId: project.id, requestId: requestA.id, requestKey: "synthesis-a", runRef: "run-a", conclusion: "c", findingIds: [findingId], validAsOf: now });
        assert.equal((await call(client, "complete_research_request", { projectId: project.id, requestId: requestA.id, conclusion: "completed" })).structuredContent?.request.status, "completed");
      });

      // 2件目: 既存知識だけで判断でき、Resultなしでnot_needed。
      await api(server.baseUrl, "POST", `/api/projects/${project.id}/intents/${intentA.id}/abandon`, { reason: "done" });
      const intentB = await createIntent(server.baseUrl, project.id, "B");
      const requestB = await initialRequestOf(server.baseUrl, project.id, intentB.id);
      await withAgent(server.baseUrl, "researcher-1", async (client) => {
        const closed = await call(client, "complete_research_request", { projectId: project.id, requestId: requestB.id, conclusion: "not_needed", stopReason: "Existing knowledge is sufficient" });
        assert.equal(closed.structuredContent?.request.status, "not_needed");
      });

      // 3件目: 証拠を集め切れず、予算を使い切ったためinsufficient。
      await api(server.baseUrl, "POST", `/api/projects/${project.id}/intents/${intentB.id}/abandon`, { reason: "done" });
      const intentC = await createIntent(server.baseUrl, project.id, "C");
      const requestC = await initialRequestOf(server.baseUrl, project.id, intentC.id);
      await withAgent(server.baseUrl, "researcher-1", async (client) => {
        const closed = await call(client, "complete_research_request", { projectId: project.id, requestId: requestC.id, conclusion: "insufficient", stopReason: "Budget exhausted before conclusive evidence" });
        assert.equal(closed.structuredContent?.request.status, "insufficient");
      });

      // 4件目: 通信結果不明（RuntimeがまだResearcherの応答を確定できていない）。CompassはRequestを
      // requested/runningのまま保持するだけで、"通信結果不明"という別状態は持たない（Runtimeの解釈に委ねる）。
      await api(server.baseUrl, "POST", `/api/projects/${project.id}/intents/${intentC.id}/abandon`, { reason: "done" });
      const intentD = await createIntent(server.baseUrl, project.id, "D");
      const requestD = await initialRequestOf(server.baseUrl, project.id, intentD.id);
      assert.equal(requestD.status, "requested");

      const statuses = (await api(server.baseUrl, "GET", `/api/projects/${project.id}/research-requests`)).body.requests as { id: string; status: string; stopReason: string | null }[];
      assert.deepEqual(
        statuses.map((request) => request.status).sort(),
        ["completed", "insufficient", "not_needed", "requested"],
      );
      assert.equal(statuses.find((request) => request.id === requestB.id)?.stopReason, "Existing knowledge is sufficient");
      assert.equal(statuses.find((request) => request.id === requestC.id)?.stopReason, "Budget exhausted before conclusive evidence");

      // 別ProjectのResearcher Grantでは、このProjectのRequestに触れない（FORBIDDEN、Projectの存在は漏らさない）。
      await withAgent(server.baseUrl, "researcher-q", async (client) => {
        assert.equal(errorCode(await call(client, "get_researcher_context", { projectId: project.id, requestId: requestA.id })), "FORBIDDEN");
        assert.equal(errorCode(await call(client, "list_research_requests", { projectId: project.id })), "FORBIDDEN");
      });

      // Human向けWeb APIの読み取りはRole Grantを要求しない（Authorizationヘッダーなしでも参照できる）。
      const anonymous = await fetch(`${server.baseUrl}/api/projects/${project.id}/research-requests`, { headers: closeConnection });
      assert.equal(anonymous.status, 200);
      const anonymousAdr = await fetch(`${server.baseUrl}/api/projects/${project.id}/adr-references`, { headers: closeConnection });
      assert.equal(anonymousAdr.status, 200);

      await server.stop();
    });
  },
);
