import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/app.ts";
import { InstructionService } from "../src/application/service/InstructionService.ts";
import { createApplicationServices } from "../src/createApplicationServices.ts";
import { createDatabase } from "../src/infrastructure/database/createDatabase.ts";
import { initializeSchema } from "../src/infrastructure/database/initializeSchema.ts";

/**
 * 空DBから Role付与 → 認証 → Instruction → Context → create_outcome までを、実HTTPサーバー・CLIプロセス・MCP SDK clientで通す。
 * すべて機械的に完結し、Humanの確認・承認・画面操作は使わない。
 * Runtime（Agentの自動起動）は未接続で、ここで「Agent」として動くのはtest内のMCP clientだけ。自律運転の実証ではない。
 */

type ToolResult = { isError?: boolean; structuredContent?: Record<string, any>; content?: { type: string; text: string }[] };

const agentRoot = new URL("../agent/", import.meta.url);
const publicIndex = new URL("../public/index.html", import.meta.url);
const execFileAsync = promisify(execFile);

const outcomeInput = {
  title: "No duplicate claims",
  description: "Claims are exclusive.",
  rationale: "Duplicate claims cause rework.",
  successCriteria: [
    { description: "duplicate_claim_count = 0", measurement: "Count duplicates", target: "= 0" },
    { description: "Audited", measurement: "Change log entry exists" },
  ],
};

type Running = { baseUrl: string; port: number; close: () => Promise<void> };

// listen失敗（'error'イベント）を握らないと、node:test内の未処理エラーとしてNode内部Assertionで異常終了する。
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
// 拒否（EPERM / EACCES）だけを理由付きでskipし、それ以外の失敗は隠さない。
const loopbackDenial = await new Promise<string | undefined>((resolve) => {
  const probe = createServer();
  probe.once("error", (error: NodeJS.ErrnoException) => resolve(error.code === "EPERM" || error.code === "EACCES" ? error.code : undefined));
  probe.listen(0, "127.0.0.1", () => probe.close(() => resolve(undefined)));
});
const loopbackSkip = loopbackDenial ? `127.0.0.1へのlistenが拒否された（${loopbackDenial}）。sandbox外で実行すること` : false;

/** DBファイル・サーバー・CLIを1つのDBパスで束ねる。 */
const withEnvironment = async (
  run: (environment: {
    path: string;
    start: (instructionService?: InstructionService, port?: number) => Promise<Running & { stop: () => Promise<void> }>;
    cli: (...args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
  }) => Promise<void>,
) => {
  const directory = await mkdtemp(join(tmpdir(), "compass-integration-"));
  const path = join(directory, "integration.db");
  const stops: (() => Promise<void>)[] = [];
  try {
    await run({
      path,
      start: async (instructionService, port) => {
        const database = createDatabase(path);
        await initializeSchema(database);
        const running = await listen(createApp(createApplicationServices(database, instructionService)), port);
        const stop = async () => {
          await running.close();
          await database.destroy();
        };
        stops.push(stop);
        return { ...running, stop };
      },
      cli: async (...args) => {
        try {
          const { stdout, stderr } = await execFileAsync("node", ["--import", "tsx", "src/presentation/cli/main.ts", ...args], {
            env: { ...process.env, COMPASS_DB_PATH: path },
          });
          return { code: 0, stdout, stderr };
        } catch (error) {
          const failed = error as { code: number; stdout: string; stderr: string };
          return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
        }
      },
    });
  } finally {
    // 各testが止めていないサーバーだけを片付ける（close済みでも例外にしない）。
    for (const stop of stops) await stop().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
};

// 再起動testで、閉じたサーバーへの接続を使い回さないよう、毎回接続を閉じる。
const closeConnection = { Connection: "close" };

const api = async (baseUrl: string, method: string, path: string, body?: unknown) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...closeConnection },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
};

const createProject = async (baseUrl: string, name = "Compass") =>
  ((await api(baseUrl, "POST", "/api/projects", { name, mission: "Keep direction explicit" })).body.project as { id: string }).id;

const createIntent = async (baseUrl: string, projectId: string) =>
  ((await api(baseUrl, "POST", `/api/projects/${projectId}/intents`, { title: "I", desiredState: "S" })).body.intent as { id: string }).id;

/** Bearer付き（principal省略でBearerなし）のMCP clientを実HTTPで接続する。 */
const withAgent = async <T>(baseUrl: string, principal: string | undefined, run: (client: Client) => Promise<T>) => {
  const client = new Client({ name: "integration-test", version: "0" });
  const requestInit = {
    headers: { ...closeConnection, ...(principal === undefined ? {} : { Authorization: `Bearer ${principal}` }) },
  };
  await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit }));
  try {
    return await run(client);
  } finally {
    await client.close();
  }
};

const call = async (client: Client, name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as ToolResult;

const errorCode = (result: ToolResult) => {
  assert.equal(result.isError, true);
  return result.structuredContent?.error.code as string;
};

const outcomesOf = async (baseUrl: string, projectId: string, intentId: string) =>
  (await api(baseUrl, "GET", `/api/projects/${projectId}/intents/${intentId}/outcomes`)).body.outcomes as unknown[];

test("空DBから、API（Project・Intent）→ CLI（Grant）→ MCP（Instruction・Context・create_outcome）→ Web参照までHuman操作なしで完了する", { skip: loopbackSkip }, async () => {
  await withEnvironment(async ({ start, cli }) => {
    const server = await start();
    const projectId = await createProject(server.baseUrl);
    const intentId = await createIntent(server.baseUrl, projectId);

    // Grant: CLI（サーバー稼働中でも同じDBへ書き、次のMCP呼び出しから反映される）。
    const granted = await cli("grant", projectId, "strat-cli", "strategist");
    assert.equal(granted.code, 0);
    assert.equal(JSON.parse(granted.stdout).created, true);

    await withAgent(server.baseUrl, "strat-cli", async (client) => {
      // Instruction: Bearer・Grantに依存せず、role-policy → strategist の順で返る。
      const instructions = await call(client, "get_role_instructions", { role: "strategist", includeShared: true });
      assert.equal(instructions.isError, undefined);
      const files = instructions.structuredContent?.files as { path: string; kind: string; content: string }[];
      assert.deepEqual(files.map((file) => [file.path, file.kind]), [
        ["agent/role-policy.md", "shared"],
        ["agent/strategist.md", "role"],
      ]);

      // Context: Project・Active Intent・（まだ無い）Outcome。未実装の入力は unavailable で明示される。
      const context = await call(client, "get_strategist_context", { projectId });
      assert.equal(context.isError, undefined);
      assert.equal(context.structuredContent?.principalId, "strat-cli");
      assert.equal(context.structuredContent?.role, "strategist");
      assert.equal(context.structuredContent?.project.id, projectId);
      assert.equal(context.structuredContent?.activeIntent.id, intentId);
      assert.deepEqual(context.structuredContent?.outcomes, []);
      assert.deepEqual(context.structuredContent?.unavailable, ["research", "evaluation", "evidence"]);

      // create_outcome → Web APIから、rationale・固定された成功条件まで同じ内容で参照できる。
      const created = await call(client, "create_outcome", { projectId, intentId, ...outcomeInput });
      assert.equal(created.isError, undefined);
      const outcome = created.structuredContent?.outcome;
      assert.equal(outcome.status, "active");
      const viaWeb = await api(server.baseUrl, "GET", `/api/projects/${projectId}/intents/${intentId}/outcomes/${outcome.id}`);
      assert.equal(viaWeb.status, 200);
      assert.deepEqual(viaWeb.body.outcome, outcome);
      assert.equal(viaWeb.body.outcome.rationale, outcomeInput.rationale);
      assert.deepEqual(
        viaWeb.body.outcome.successCriteria.map((criterion: any) => [criterion.description, criterion.measurement, criterion.target]),
        outcomeInput.successCriteria.map((criterion) => [criterion.description, criterion.measurement, (criterion as any).target ?? null]),
      );

      // 成功条件は作成後に変えられない（取消して作り直す）。
      const edited = await call(client, "update_outcome", { projectId, intentId, outcomeId: outcome.id, successCriteria: [] });
      assert.equal(errorCode(edited), "CONFLICT");

      // 次のContextには作成済みOutcomeが載る。
      const after = await call(client, "get_strategist_context", { projectId });
      assert.deepEqual(after.structuredContent?.outcomes.map((item: { id: string }) => item.id), [outcome.id]);
    });
    await server.stop();
  });
});

test("Grantは API・CLI のどちらでも発行でき、MCPにはGrant管理toolが無く、Agentは自分に権限を付けられない", { skip: loopbackSkip }, async () => {
  await withEnvironment(async ({ start, cli }) => {
    const server = await start();
    const projectId = await createProject(server.baseUrl);
    const intentId = await createIntent(server.baseUrl, projectId);

    const viaApi = await api(server.baseUrl, "POST", `/api/projects/${projectId}/grants`, { principalId: "strat-api", role: "strategist" });
    assert.equal(viaApi.status, 201);
    assert.equal((await cli("grant", projectId, "strat-cli", "strategist")).code, 0);
    const listed = (await api(server.baseUrl, "GET", `/api/projects/${projectId}/grants`)).body.grants as { principalId: string }[];
    assert.deepEqual(listed.map((grant) => grant.principalId).sort(), ["strat-api", "strat-cli"]);

    for (const principal of ["strat-api", "strat-cli"]) {
      await withAgent(server.baseUrl, principal, async (client) => {
        assert.equal((await call(client, "create_outcome", { projectId, intentId, ...outcomeInput })).isError, undefined, principal);
      });
    }
    assert.equal((await outcomesOf(server.baseUrl, projectId, intentId)).length, 2);

    // MCPからGrantを発行・取消・一覧するtoolは公開されず、呼んでも権限は増えない。
    await withAgent(server.baseUrl, "self-grant", async (client) => {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      assert.equal(names.filter((name) => name !== "get_role_instructions" && /grant|role/i.test(name)).length, 0);
      const attempt = await client
        .callTool({ name: "grant_project_role", arguments: { projectId, principalId: "self-grant", role: "strategist" } })
        .then((result) => result as ToolResult, () => ({ isError: true }) as ToolResult);
      assert.equal(attempt.isError, true);
      assert.equal(errorCode(await call(client, "create_outcome", { projectId, intentId, ...outcomeInput })), "FORBIDDEN");
    });
    const grants = (await api(server.baseUrl, "GET", `/api/projects/${projectId}/grants`)).body.grants as { principalId: string }[];
    assert.ok(!grants.some((grant) => grant.principalId === "self-grant"));
    await server.stop();
  });
});

test("get_role_instructionsの応答はWacha互換（role・includeShared・files[{path, kind, content}]）で、内容はagent/の文書と一致する", { skip: loopbackSkip }, async () => {
  await withEnvironment(async ({ start }) => {
    const server = await start();
    await withAgent(server.baseUrl, undefined, async (client) => {
      const shared = await call(client, "get_role_instructions", { role: "strategist", includeShared: true });
      assert.equal(shared.isError, undefined);
      const value = shared.structuredContent as Record<string, any>;
      assert.deepEqual(Object.keys(value).sort(), ["files", "includeShared", "role"]);
      assert.equal(value.role, "strategist");
      assert.equal(value.includeShared, true);
      assert.ok(Array.isArray(value.files));
      for (const file of value.files) {
        assert.deepEqual(Object.keys(file).sort(), ["content", "kind", "path"]);
        assert.equal(typeof file.path, "string");
        assert.ok(["shared", "role"].includes(file.kind));
        assert.equal(typeof file.content, "string");
        assert.ok(file.content.length > 0);
        // pathはrepo相対で、内容は実ファイルと一致する。
        assert.equal(file.content, await readFile(new URL(file.path.replace(/^agent\//, ""), agentRoot), "utf-8"));
      }
      assert.deepEqual(value.files.map((file: { kind: string }) => file.kind), ["shared", "role"]);
      // text contentも同じJSON（structuredContent非対応のclientでも読める）。
      assert.deepEqual(JSON.parse(shared.content?.[0]?.text ?? "null"), value);

      // includeShared省略・falseはRole文書のみ。
      for (const args of [{ role: "strategist" }, { role: "strategist", includeShared: false }]) {
        const roleOnly = (await call(client, "get_role_instructions", args)).structuredContent as Record<string, any>;
        assert.equal(roleOnly.includeShared, false);
        assert.deepEqual(roleOnly.files.map((file: { path: string; kind: string }) => [file.path, file.kind]), [["agent/strategist.md", "role"]]);
      }
    });
    await server.stop();
  });
});

test("権限なし・別Project・Grant取消・Bearerなし・Role不一致・存在しないProjectを拒否し、Outcomeを作らない", { skip: loopbackSkip }, async () => {
  await withEnvironment(async ({ start, cli }) => {
    const server = await start();
    const projectId = await createProject(server.baseUrl, "P");
    const otherId = await createProject(server.baseUrl, "Q");
    const intentId = await createIntent(server.baseUrl, projectId);
    await cli("grant", projectId, "strat-p", "strategist");
    await cli("grant", otherId, "strat-q", "strategist");

    // 権限なし（Grantなし）・別Projectだけのstrategist・存在しないProjectは同じFORBIDDEN。
    await withAgent(server.baseUrl, "nobody", async (client) => {
      assert.equal(errorCode(await call(client, "create_outcome", { projectId, intentId, ...outcomeInput })), "FORBIDDEN");
      assert.equal(errorCode(await call(client, "get_strategist_context", { projectId })), "FORBIDDEN");
    });
    await withAgent(server.baseUrl, "strat-q", async (client) => {
      assert.equal(errorCode(await call(client, "create_outcome", { projectId, intentId, ...outcomeInput })), "FORBIDDEN");
      assert.equal(errorCode(await call(client, "get_strategist_context", { projectId })), "FORBIDDEN");
      assert.equal(errorCode(await call(client, "create_outcome", { projectId: "missing", intentId, ...outcomeInput })), "FORBIDDEN");
    });

    // Bearerなしは認証エラー。
    await withAgent(server.baseUrl, undefined, async (client) => {
      assert.equal(errorCode(await call(client, "create_outcome", { projectId, intentId, ...outcomeInput })), "UNAUTHENTICATED");
      assert.equal(errorCode(await call(client, "get_strategist_context", { projectId })), "UNAUTHENTICATED");
    });

    // Role不一致: Strategistの読み書き経路（Instruction・Grant発行）にstrategist以外のRoleは通らない。
    await withAgent(server.baseUrl, "strat-p", async (client) => {
      for (const role of ["worker", "manager", "reviewer"]) {
        assert.equal((await call(client, "get_role_instructions", { role, includeShared: true })).isError, true, role);
      }
      // 職務分離: Strategist Grantを持つPrincipalはDirection（Intent）を変更できない。
      assert.equal(errorCode(await call(client, "update_intent", { projectId, intentId, title: "Renamed" })), "FORBIDDEN");
    });
    const workerGrant = await api(server.baseUrl, "POST", `/api/projects/${projectId}/grants`, { principalId: "agent-w", role: "worker" });
    assert.equal(workerGrant.status, 400);
    assert.equal(workerGrant.body.error.code, "VALIDATION_ERROR");
    const workerCli = await cli("grant", projectId, "agent-w", "worker");
    assert.equal(workerCli.code, 1);
    assert.equal(JSON.parse(workerCli.stderr).error.code, "VALIDATION_ERROR");

    // 取消後は、同じAgentが次の呼び出しから拒否される（サーバー再起動なし）。作成済みOutcomeは残る。
    await withAgent(server.baseUrl, "strat-p", async (client) => {
      assert.equal((await call(client, "create_outcome", { projectId, intentId, ...outcomeInput })).isError, undefined);
      assert.deepEqual(JSON.parse((await cli("revoke", projectId, "strat-p", "strategist")).stdout), { revoked: true });
      assert.equal(errorCode(await call(client, "create_outcome", { projectId, intentId, ...outcomeInput })), "FORBIDDEN");
      assert.equal(errorCode(await call(client, "get_strategist_context", { projectId })), "FORBIDDEN");
    });

    // 拒否された呼び出しはOutcomeを増やしていない（許可した1件だけ）。
    assert.equal((await outcomesOf(server.baseUrl, projectId, intentId)).length, 1);
    await server.stop();
  });
});

test("Instructionファイルが欠落するとINSTRUCTION_UNAVAILABLEで失敗し、部分的な応答を返さず、Context・Outcome作成には影響しない", { skip: loopbackSkip }, async () => {
  const empty = await mkdtemp(join(tmpdir(), "compass-agent-missing-"));
  try {
    await withEnvironment(async ({ start, cli }) => {
      const server = await start(new InstructionService(empty));
      const projectId = await createProject(server.baseUrl);
      const intentId = await createIntent(server.baseUrl, projectId);
      await cli("grant", projectId, "strat-1", "strategist");

      await withAgent(server.baseUrl, "strat-1", async (client) => {
        for (const includeShared of [true, false]) {
          const result = await call(client, "get_role_instructions", { role: "strategist", includeShared });
          assert.equal(errorCode(result), "INSTRUCTION_UNAVAILABLE");
          assert.match(result.structuredContent?.error.message, /agent\/(strategist|role-policy)\.md/);
          assert.equal(result.structuredContent?.files, undefined);
        }
        // Instructionの欠落はGrant・Contextの経路を壊さない。
        assert.equal((await call(client, "get_strategist_context", { projectId })).isError, undefined);
        assert.equal((await call(client, "create_outcome", { projectId, intentId, ...outcomeInput })).isError, undefined);
      });
      await server.stop();
    });
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
});

test("サーバーを再起動（同じDB・同じport）してもGrantとOutcomeは保持され、/api・/mcpが使える", { skip: loopbackSkip }, async () => {
  await withEnvironment(async ({ start, cli }) => {
    const first = await start();
    const projectId = await createProject(first.baseUrl);
    const intentId = await createIntent(first.baseUrl, projectId);
    await cli("grant", projectId, "strat-1", "strategist");
    const outcomeId = await withAgent(first.baseUrl, "strat-1", async (client) => {
      const created = await call(client, "create_outcome", { projectId, intentId, ...outcomeInput });
      assert.equal(created.isError, undefined);
      return created.structuredContent?.outcome.id as string;
    });
    await first.stop();

    const second = await start(undefined, first.port);
    assert.equal(second.port, first.port);
    assert.equal((await api(second.baseUrl, "GET", "/api")).status, 200);
    assert.equal((await api(second.baseUrl, "GET", "/health")).status, 200);
    assert.deepEqual(
      ((await api(second.baseUrl, "GET", `/api/projects/${projectId}/grants`)).body.grants as { principalId: string }[]).map((grant) => grant.principalId),
      ["strat-1"],
    );
    await withAgent(second.baseUrl, "strat-1", async (client) => {
      const context = await call(client, "get_strategist_context", { projectId });
      assert.equal(context.isError, undefined);
      assert.deepEqual(context.structuredContent?.outcomes.map((item: { id: string }) => item.id), [outcomeId]);
      assert.equal((await call(client, "create_outcome", { projectId, intentId, ...outcomeInput, title: "After restart" })).isError, undefined);
    });
    await withAgent(second.baseUrl, "nobody", async (client) => {
      assert.equal(errorCode(await call(client, "get_strategist_context", { projectId })), "FORBIDDEN");
    });
    await second.stop();
  });
});

// 画面は`npm run build`が`public/`へ出力する。ビルド前の環境ではこのtestだけを飛ばし、理由を残す。
test("同じport・同じサーバーで / のWeb UIも配信される", { skip: loopbackSkip || (existsSync(publicIndex) ? false : "public/index.html が無い（npm run build 前）") }, async () => {
  await withEnvironment(async ({ start }) => {
    const server = await start();
    const response = await fetch(`${server.baseUrl}/`, { headers: closeConnection });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    assert.equal((await fetch(`${server.baseUrl}/api`)).status, 200);
    assert.equal((await fetch(`${server.baseUrl}/mcp`, { method: "DELETE" })).status < 500, true);
    await server.stop();
  });
});
