import type { Meta, StoryObj } from "@storybook/react-vite";
import { useLocation } from "react-router-dom";
import { ViewSwitch } from "./index";

const meta = {
  title: "Components/ViewSwitch",
  component: ViewSwitch,
  tags: ["autodocs"],
  args: { label: "Taskの表示", size: "md", items: [
    { key: "open", label: "未完了", to: "/", current: true, count: 3 },
    { key: "all", label: "すべて", to: "/all", current: false, count: 8 },
  ] },
  argTypes: { size: { control: "select", options: ["md", "sm"] } },
  parameters: { docs: { description: { component: "URLで表す一覧の切替。labelはnavの読み上げ名、items.currentでaria-current=pageを指定する。MemoryRouter内で遷移を確認できる。" } } },
} satisfies Meta<typeof ViewSwitch>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Playground: Story = {};
export const Navigation: Story = {
  render: function Navigation(args) {
    const { pathname } = useLocation();
    return <><ViewSwitch {...args} items={args.items.map((item) => ({ ...item, current: pathname === item.to }))} /><p>現在のURL: {pathname}</p></>;
  },
};
export const Compact: Story = { args: { size: "sm" } };
