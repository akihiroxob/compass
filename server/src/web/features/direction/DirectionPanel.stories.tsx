import type { Meta, StoryObj } from "@storybook/react-vite";
import { PageColumns } from "../../components/PageColumns";
import { DirectionPanel } from "./DirectionStatus";

const meta = {
  title: "Patterns/OverviewLayout",
  component: DirectionPanel,
  tags: ["autodocs"],
  parameters: { docs: { description: { component: "Workspace・Projectの概要の組合せ。Mission・Visionの帯を本文より先に置き、その下をPageColumnsの主列・補助列に分ける。fixtureの文言は検証用で、実データ・進捗率・Agentの稼働を表さない。" } } },
  args: { mission: "検証用のMission（fixture）", vision: null },
} satisfies Meta<typeof DirectionPanel>;
export default meta;
type Story = StoryObj<typeof meta>;

export const MissionOnly: Story = {};
export const WithVision: Story = { args: { vision: "検証用のVision。長い文言が折り返しても帯の高さだけが伸び、横にはみ出さないことを確認する（fixture）。" } };
export const WithColumns: Story = {
  render: (args) => <>
    <DirectionPanel {...args} />
    <PageColumns
      main={<section className="detail-section"><h2>要対応</h2><p className="unset">要対応はありません。</p></section>}
      side={<section className="detail-section"><h2>Project</h2><p className="unset">activeなProjectはありません。</p></section>}
    />
  </>,
};
