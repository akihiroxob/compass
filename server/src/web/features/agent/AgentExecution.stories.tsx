import type { Meta, StoryObj } from "@storybook/react-vite";
import { AgentExecutionSection, ExecutionFact } from "./AgentExecution";
import { IncompleteSources } from "./AgentList";
import { agentExecutionOf, type AgentRun } from "./agentRuns";

const meta = {
  title: "Patterns/AgentExecution",
  tags: ["autodocs"],
  parameters: { docs: { description: { component: "Agent一覧のExecutionFactと詳細のAgentExecutionSectionをそのまま表示。観測の有無・取得不能・期限内・途絶・終了と、一覧の欠け（取得できなかった情報源）を区別する。固定時刻のfixtureで、自律運転の実証ではない。製品適用画面はWorkspaceのAgent一覧・詳細。" } } },
} satisfies Meta;
export default meta;
type Story = StoryObj;
const now = Date.UTC(2026, 10, 5, 0);
const run: AgentRun = {
  runId: "fixture-run-0001", principalId: "fixture-worker", scope: { kind: "project", id: "fixture-project" }, role: "worker",
  source: "ralph", provider: "test-adapter", workRef: { kind: "task", id: "fixture-task" }, reporter: { kind: "agent", principalId: "fixture-worker" },
  status: "running", observation: "running", startedAt: now - 300_000, observedAt: now - 30_000, staleAt: now + 60_000, endedAt: null, reason: null,
};
const stateStory = (observation: AgentRun["observation"]): Story => ({
  render: () => {
    const terminal = observation === "succeeded" || observation === "failed";
    const execution = agentExecutionOf(run.principalId, { asOf: now, runs: [{
      ...run, observation, status: terminal ? observation : "running", endedAt: terminal ? now : null,
      ...(terminal ? { observedAt: now, staleAt: now } : {}),
      ...(observation === "stale" ? { observedAt: now - 180_000, staleAt: now - 60_000 } : {}),
      reason: observation === "failed" ? "テストadapter 終了コード 2" : null,
    }] });
    return <AgentExecutionSection execution={execution} scopeName={() => "表示検証Project"} />;
  },
});
export const Running = stateStory("running");
export const Stale = stateStory("stale");
export const Succeeded = stateStory("succeeded");
export const Failed = stateStory("failed");
export const NoObservation: Story = { render: () => <AgentExecutionSection execution={{ kind: "none" }} scopeName={() => ""} /> };
export const Unavailable: Story = { render: () => <AgentExecutionSection execution={{ kind: "unavailable", error: "接続エラー（fixture）" }} scopeName={() => ""} /> };
export const ListFact: Story = {
  render: () => <dl className="agent-card-facts"><div><dt>実行状況</dt><dd><ExecutionFact execution={agentExecutionOf(run.principalId, { asOf: now, runs: [run] })} /></dd></div></dl>,
};
/** 実行観測・Projectを読み込めなかったときの一覧・詳細の注記。観測だけが残るAgentが欠けうるため、0件・不存在を断定しない。 */
export const IncompleteList: Story = {
  render: () => <IncompleteSources gaps={[{ kind: "project", id: "fixture-project", name: "Fixture Project", error: "権限がありません（fixture）" }, { kind: "runs", error: "接続エラー（fixture）" }]} />,
};
