import type { Meta, StoryObj } from "@storybook/react-vite";
import { IntentGoalCard } from "./IntentGoalCard";
import { MetricTrend } from "./MetricTrend";
import { addDays, type IntentMetric, type MetricObservation } from "./metric";

const to = "2026-11-08";
const source = { name: "検証用の集計表（fixture）", uri: null };
const point = (offset: number, value: number | null, span = 0): MetricObservation => ({
  id: `o${offset}`, metricId: "m", periodStart: addDays(to, -offset - span), periodEnd: addDays(to, -offset), revision: 1,
  status: value === null ? "failed" : "observed", value, failureReason: value === null ? "取得に失敗した" : null, source, observedAt: 0,
});
const metric = (points: MetricObservation[], state: IntentMetric["current"]["state"]): IntentMetric => ({
  id: "m", key: "revenue", name: "月間売上", unit: "円", targetValue: 300000, staleAfterDays: 3,
  current: { state, latest: points.at(-1) ?? null, lastObserved: [...points].reverse().find(({ value }) => value !== null) ?? null },
  series: { from: addDays(to, -29), to, points },
});
const daily = Array.from({ length: 30 }, (_, index) => 29 - index).filter((offset) => offset !== 12 && offset !== 13)
  .map((offset) => point(offset, offset === 5 ? null : 120000 + (29 - offset) * 2000));

const meta = {
  title: "Patterns/MetricTrend",
  component: MetricTrend,
  tags: ["autodocs"],
  decorators: [(Story) => <div style={{ maxWidth: "36rem" }}><Story /></div>],
  parameters: { docs: { description: { component: "目標の観測値の日次の推移。観測の無い日・取得失敗の日をまたいで線を結ばず、0や補間値で埋めない。値はfixtureで、実データ・達成を表さない。" } } },
  args: { metric: metric(daily, "observed"), to, days: 30 },
} satisfies Meta<typeof MetricTrend>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Days30WithGapAndFailure: Story = {};
export const Days7: Story = { args: { days: 7 } };
export const NoObservation: Story = { args: { metric: metric([], "unmeasured") } };
export const GoalCardCompact: Story = {
  render: () => <IntentGoalCard workspaceId="w" intent={{ id: "i", title: "売上を月30万円へ" } as never} metrics={{ ok: true, value: { intentId: "i", observedAt: Date.parse(`${to}T03:00:00Z`), metrics: [metric(daily, "observed")] } }} />,
};
export const GoalCardFetchFailed: Story = {
  render: () => <IntentGoalCard workspaceId="w" intent={{ id: "i", title: "売上を月30万円へ" } as never} metrics={{ ok: false, error: "接続できません" }} />,
};
