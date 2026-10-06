import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Runtime, type Json, type Tokens } from "./support/lv6Runtime.ts";

// MCPの通信だけを置換し、Runtimeと各Agentの実際の処理をlisten無しで検証する。
const setup = (t: TestContext, event: Json, timeout = false) => {
  const projectId = "project-A";
  const calls: { tool: string; args: Json }[] = [];
  const credential = (principal: string) => ({ principal, token: `test-${principal}` });
  const tokens: Tokens = {
    runtime: credential("runtime"), researcher: credential("researcher"), strategist: credential("strategist"),
    manager: credential("manager"), workers: [], reviewer: credential("reviewer"), evaluator: credential("evaluator"),
  };
  let fetched = false;
  t.mock.method(Client.prototype, "connect", async () => {});
  t.mock.method(Client.prototype, "close", async () => {});
  t.mock.method(Client.prototype, "callTool", async ({ name, arguments: args }: { name: string; arguments: Json }) => {
    calls.push({ tool: name, args });
    assert.equal(args.projectId, projectId, `${name} must use the fetch Project Context`);
    let content: Json;
    switch (name) {
      case "fetch_runtime_events":
        content = { events: fetched ? [] : [event], nextCursor: 1, resumeCursor: 0 };
        fetched = true;
        break;
      case "get_researcher_context":
        content = { request: { status: "requested", question: "Which signal?" } };
        break;
      case "register_research_result":
        content = { result: { findings: [{ id: "finding-A" }] } };
        break;
      case "register_research_synthesis":
      case "complete_research_request":
        content = {};
        break;
      case "get_strategist_context":
        content = {
          activeIntent: { id: "intent-A", completionDefinition: "CI passes" },
          evaluations: event.type === "outcome_evaluated" ? [{ id: "evaluation-A", result: "achieved" }] : [],
        };
        break;
      case "decide_next_outcome":
        content = { outcome: { id: "outcome-A" } };
        break;
      case "create_direction_decision":
        content = {};
        break;
      case "issue_story":
        content = { id: "story-A", successCriteria: [] };
        break;
      case "list_tasks":
        content = { tasks: [] };
        break;
      case "issue_task":
        content = { id: "task-A" };
        break;
      case "ack_runtime_event":
        assert.equal(args.eventId, event.id);
        assert.equal(typeof args.attemptId, "string");
        content = { recorded: true };
        break;
      default:
        assert.fail(`Unexpected MCP tool: ${name}`);
    }
    return { structuredContent: content };
  });
  const runtime = new Runtime(
    { baseUrl: () => "http://127.0.0.1:1", now: () => 1_800_000_000_000, calls: [], dropNextResponse: new Set() },
    tokens,
    { resumeCursor: 0, changeCursor: 0, reflected: {} },
    { projectIds: () => [projectId], managerTimeoutAfterStory: () => timeout },
  );
  return { runtime, calls };
};

const event = (type: string, version = 2): Json => ({
  id: "event-A", cursor: 1, version, type, workspaceId: "workspace-A",
  intentId: "intent-A", researchRequestId: "research-A", outcomeId: "outcome-A", evaluationId: "evaluation-A",
  correlationId: "outcome:outcome-A",
});

for (const [type, expectedTools] of [
  ["research_requested", ["get_researcher_context", "register_research_result", "register_research_synthesis", "complete_research_request"]],
  ["research_completed", ["get_strategist_context", "decide_next_outcome"]],
  ["outcome_confirmed", ["issue_story", "list_tasks", "issue_task"]],
  ["outcome_evaluated", ["get_strategist_context", "create_direction_decision"]],
] as const) {
  test(`v2 ${type}はfetch時のProject ContextでAgentを実行しprocessedをackする`, async (t) => {
    const input = event(type);
    const { runtime, calls } = setup(t, input);
    assert.equal(await runtime.processEvents(), 1);
    assert.deepEqual(calls.filter(({ tool }) => !["fetch_runtime_events", "ack_runtime_event"].includes(tool)).map(({ tool }) => tool), expectedTools);
    assert.equal(calls.at(-1)!.args.outcome, "processed");
    assert.equal(runtime.dispatches[0]!.correlationId, input.correlationId);
    assert.equal(runtime.fetchedEvents[0]!.workspaceId, "workspace-A");
    assert.equal("projectId" in input, false);
  });
}

test("未知versionはAgentを起動せずfetch時のProject Contextでterminal_failureをackする", async (t) => {
  const { runtime, calls } = setup(t, event("outcome_confirmed", 999));
  assert.equal(await runtime.processEvents(), 1);
  assert.deepEqual(calls.map(({ tool }) => tool), ["fetch_runtime_events", "fetch_runtime_events", "ack_runtime_event"]);
  assert.equal(calls.at(-1)!.args.outcome, "terminal_failure");
  assert.equal(calls.at(-1)!.args.reason, "unknown event version 999");
});

test("v2 Agentのtimeoutもfetch時のProject Contextでretryable_failureをackする", async (t) => {
  const { runtime, calls } = setup(t, event("outcome_confirmed"), true);
  assert.equal(await runtime.processEvents(), 1);
  assert.equal(calls.at(-1)!.args.outcome, "retryable_failure");
  assert.equal(calls.at(-1)!.args.reason, "manager timed out after issue_story");
});
