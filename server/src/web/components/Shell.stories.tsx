import type { Meta, StoryObj } from "@storybook/react-vite";
import { Link, useLocation } from "react-router-dom";
import { Shell } from "./Shell";
import { Select } from "./ui";

const meta = {
  title: "Patterns/Shell",
  component: Shell,
  tags: ["autodocs"],
  parameters: {
    layout: "fullscreen",
    docs: { description: { component: "画面の枠。上端のheaderにブランドとSession、Desktopは左のメニューにswitcher・navigation・footerを置く。狭い画面（700px以下）はheaderの名前アイコン（account）の右のメニューボタン（44px・aria-expanded）から、同じ内容とSessionを右端のDialogで開き、×をswitcherと同じ行に置く。Escape・背景・×・画面の移動で閉じ、閉じるとメニューボタンへfocusが戻る。slotの中身はappが各Featureから合成し、このfixtureはlocalのリンクだけを使う。" } },
  },
  args: { session: <span>検証ユーザー</span>, account: <span aria-label="検証ユーザーでログイン中" role="img">検</span>, children: null },
} satisfies Meta<typeof Shell>;
export default meta;
type Story = StoryObj<typeof meta>;

const SampleNavigation = () => {
  const { pathname } = useLocation();
  const items = [["/", "概要"], ["/waiting", "対応待ち"], ["/outcomes", "Outcome"], ["/activity", "Activity"], ["/agents", "Agent管理"], ["/settings", "設定"]];
  return <nav aria-label="Workspace 検証"><ul>{items.map(([to, label]) => <li key={to}><Link to={to} aria-current={pathname === to ? "page" : undefined}>{label}</Link></li>)}</ul></nav>;
};

export const WithMenu: Story = {
  render: (args) => (
    <Shell
      {...args}
      switcher={<Select aria-label="Workspaceを切り替える" defaultValue="a"><option value="a">Taneru</option><option value="b">Petari</option></Select>}
      navigation={<SampleNavigation />}
      footer={<Link to="/projects">参加中のProject</Link>}
    >
      <main><h1>本文</h1><p>狭い画面ではheader右のメニューから開きます。</p></main>
    </Shell>
  ),
};

export const PublicFrame: Story = {
  render: (args) => <Shell {...args}><main><h1>ログイン</h1></main></Shell>,
};
