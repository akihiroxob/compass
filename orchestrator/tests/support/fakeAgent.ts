import { appendFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/**
 * 結合テスト用の決定的なAgent（fixture）。Orchestratorが渡した環境変数だけを使い、Roleの最小限の結果をMCPで返す。
 * Credentialは設定のscope別`agentEnv`が渡す`FAKE_AGENT_TOKEN`（Workspace RoleはWorkspace、managerはProjectのAgent Credential）。
 * 実LLM・実Agentの起動ではなく、自律運転の実証として扱わない。
 */
const env = process.env;
const role = env.COMPASS_ROLE!;
const workspaceId = env.COMPASS_WORKSPACE_ID!;
const projectId = env.COMPASS_PROJECT_ID ?? null;
const subjectId = env.COMPASS_SUBJECT_ID!;
appendFileSync(
  env.FAKE_AGENT_LOG!,
  `${JSON.stringify({ role, workspaceId, projectId, subject: `${env.COMPASS_SUBJECT_KIND}:${subjectId}`, key: env.COMPASS_DISPATCH_KEY, attempt: Number(env.COMPASS_DISPATCH_ATTEMPT), pid: process.pid, prompt: env.COMPASS_PROMPT, credentialVisible: Object.hasOwn(env, "ORCHESTRATOR_TOKEN") })}\n`,
);
if (env.FAKE_AGENT_SLEEP_MS) await new Promise((resolve) => setTimeout(resolve, Number(env.FAKE_AGENT_SLEEP_MS)));
if (env.FAKE_AGENT_EXIT) process.exit(Number(env.FAKE_AGENT_EXIT));

const client = new Client({ name: `fake-${role}`, version: "0" });
await client.connect(
  new StreamableHTTPClientTransport(new URL("/mcp", env.COMPASS_SERVER_URL!), {
    requestInit: { headers: { Authorization: `Bearer ${env.FAKE_AGENT_TOKEN}`, "X-Compass-Active-Role": role, Connection: "close" } },
  }),
);
const call = async (name: string, args: Record<string, unknown>) => {
  const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; structuredContent?: Record<string, any> };
  if (result.isError) throw new Error(`${name}: ${JSON.stringify(result.structuredContent)}`);
  return result.structuredContent!;
};

if (role === "strategist") {
  const context = await call("get_strategist_context", { workspaceId });
  const intentId = context.activeIntent.id as string;
  if (context.research.requests.length === 0) {
    // 情報不足と判断して追加Researchを依頼する。
    await call("create_direction_decision", {
      workspaceId,
      intentId,
      type: "additional_research",
      judgment: "Learn first",
      reason: "Nothing is known",
      research: { question: "What is known?", scope: "Intent", completionCondition: "Known", budgetTotal: 10 },
      requestKey: `research:${intentId}`,
      runRef: env.COMPASS_DISPATCH_KEY!,
    });
  } else {
    const created = await call("create_outcome", {
      workspaceId,
      intentId,
      title: "First outcome",
      description: "D",
      rationale: "R",
      successCriteria: [{ description: "d", measurement: "m" }],
    });
    // Target Projectの選択はStrategistの判断。fixtureは指定されたProjectをすべてTargetにする。
    for (const target of env.FAKE_TARGET_PROJECTS!.split(",")) await call("set_outcome_target", { workspaceId, outcomeId: created.outcome.id, projectId: target });
  }
} else if (role === "researcher") {
  await call("complete_research_request", { workspaceId, requestId: subjectId, conclusion: "not_needed", stopReason: "Known" });
} else if (role === "manager") {
  const story = await call("issue_story", { projectId, title: "Story", outcomeId: subjectId, requestId: `story:${subjectId}` });
  await call("issue_task", { projectId, storyId: story.id, title: "Task", taskKey: "task", requestId: `task:${subjectId}` });
}
await client.close();
