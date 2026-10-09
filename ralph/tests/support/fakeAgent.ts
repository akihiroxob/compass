import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/**
 * 結合テスト用の決定的なAgent（fixture）。`claude` / `codex` CLIの代わりにRalphのproviderから起動され、
 * providerが渡したMCP接続設定（URL・Bearerの環境変数・`X-Compass-Active-Role`）だけを使ってCompassへ結果を返す。
 * 実LLM・実Agentの起動ではなく、自律運転の実証として扱わない。
 *
 * 動作は`FAKE_AGENT_ACTIONS`（Roleごとの配列。n回目の起動でn番目を使う）で決める。
 * `FAKE_AGENT_CONTEXT_LOG`があれば、`get_role_context`で受け取った所属Workspace・Target Outcomeを記録する。
 */
const env = process.env;
const argv = process.argv.slice(2);

type Connection = { provider: "claude" | "codex"; url: string; headers: Record<string, string>; prompt: string };

const expand = (value: string) => value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => env[name] ?? "");

const parseClaude = (): Connection => {
  const configPath = argv[argv.indexOf("--mcp-config") + 1]!;
  if (!argv.includes("--strict-mcp-config")) throw new Error("--strict-mcp-config is required");
  const server = JSON.parse(readFileSync(configPath, "utf8")).mcpServers.compass as { url: string; headers: Record<string, string> };
  const headers = Object.fromEntries(Object.entries(server.headers).map(([name, value]) => [name, expand(value)]));
  return { provider: "claude", url: server.url, headers, prompt: argv[argv.indexOf("-p") + 1]! };
};

const parseCodex = (): Connection => {
  const settings = new Map<string, string>();
  argv.forEach((arg, index) => {
    if (arg !== "-c") return;
    const [key, ...rest] = argv[index + 1]!.split("=");
    settings.set(key!, rest.join("="));
  });
  const url = JSON.parse(settings.get("mcp_servers.compass.url")!) as string;
  const tokenEnv = JSON.parse(settings.get("mcp_servers.compass.bearer_token_env_var")!) as string;
  const role = /"X-Compass-Active-Role"\s*=\s*"([^"]+)"/.exec(settings.get("mcp_servers.compass.http_headers") ?? "")?.[1];
  return {
    provider: "codex",
    url,
    headers: { Authorization: `Bearer ${env[tokenEnv] ?? ""}`, "X-Compass-Active-Role": role ?? "" },
    prompt: readFileSync(0, "utf8"),
  };
};

const connection = argv[0] === "exec" ? parseCodex() : parseClaude();
const role = connection.headers["X-Compass-Active-Role"]!;
const log = env.FAKE_AGENT_LOG!;
const previous = existsSync(log)
  ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { role: string })
  : [];
const actions = (JSON.parse(env.FAKE_AGENT_ACTIONS ?? "{}") as Record<string, string[]>)[role] ?? [];
const action = actions[previous.filter((entry) => entry.role === role).length] ?? (role === "worker" ? "complete" : "approve");
appendFileSync(
  log,
  `${JSON.stringify({
    role,
    action,
    provider: connection.provider,
    pid: process.pid,
    authorization: connection.headers.Authorization,
    prompt: connection.prompt,
    visibleTokenEnv: (env.FAKE_TOKEN_ENV_NAMES ?? "").split(",").filter((name) => name && Object.hasOwn(env, name)),
  })}\n`,
);

if (action === "fail") process.exit(3);
if (action === "limit") {
  process.stderr.write("You've hit your usage limit.\n");
  process.exit(1);
}
if (action === "sleep-complete") await new Promise((resolve) => setTimeout(resolve, Number(env.FAKE_AGENT_SLEEP_MS ?? 1000)));

const projectId = /Project `([^`]+)`/.exec(connection.prompt)![1]!;
const client = new Client({ name: `fake-${role}`, version: "0" });
await client.connect(
  new StreamableHTTPClientTransport(new URL(connection.url), {
    requestInit: { headers: { ...connection.headers, Connection: "close" } },
  }),
);
const call = async (name: string, args: Record<string, unknown>) => {
  const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; structuredContent?: Record<string, any> };
  if (result.isError) throw new Error(`${name}: ${JSON.stringify(result.structuredContent)}`);
  return result.structuredContent!;
};

const context = await call("get_role_context", { projectId, role });
if (env.FAKE_AGENT_CONTEXT_LOG) {
  appendFileSync(
    env.FAKE_AGENT_CONTEXT_LOG,
    `${JSON.stringify({ role, projectId, workspaceId: context.workspace.id, outcomeIds: context.outcomes.map(({ id }: { id: string }) => id) })}\n`,
  );
}
const request = (step: string, taskId: string) => `fake-${role}-${process.pid}-${step}-${taskId}`;
if (role === "worker") {
  const { tasks } = await call("list_tasks", { projectId, filter: { availableFor: "work" } });
  const task = tasks[0];
  if (task) {
    const claim = await call("claim_task", { taskId: task.id, requestId: request("claim", task.id) });
    if (action !== "claim-only") {
      await call("add_task_comment", { taskId: task.id, claimId: claim.claimId, body: "fake worker done", requestId: request("comment", task.id) });
      await call("complete_task", { taskId: task.id, claimId: claim.claimId, requestId: request("complete", task.id) });
    }
  }
} else if (role === "reviewer") {
  const { tasks } = await call("list_tasks", { projectId, filter: { availableFor: "review" } });
  const task = tasks[0];
  if (task) {
    const claim = await call("claim_review", { taskId: task.id, requestId: request("claim", task.id) });
    await call("add_task_comment", { taskId: task.id, claimId: claim.claimId, body: "fake review ok", requestId: request("comment", task.id) });
    await call("reviewed_task", { taskId: task.id, claimId: claim.claimId, requestId: request("reviewed", task.id) });
  }
}
await client.close();
