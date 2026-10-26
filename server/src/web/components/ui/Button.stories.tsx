import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button, LinkButton } from "./index";

const meta = {
  title: "Components/Button",
  component: Button,
  tags: ["autodocs"],
  args: { children: "保存する", variant: "primary", size: "md", pending: false, disabled: false },
  argTypes: {
    variant: { control: "select", options: ["primary", "secondary", "text"] },
    size: { control: "select", options: ["md", "sm"] },
    tone: { control: "select", options: [undefined, "danger"] },
  },
  parameters: { docs: { description: { component: "操作にはButton、URL遷移にはLinkButtonを使う。送信はtype=submitを明示。pendingはdisabled/aria-busyを付与する。外側配置は親layoutが所有。textにはsizeがない。Tabでfocus、ポインターでhoverを確認できる。" } } },
} satisfies Meta<typeof Button>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Playground: Story = {};
export const SizesAndVariants: Story = {
  render: () => <div className="form-section">
    {(["md", "sm"] as const).map((size) => <div className="action-row" key={size}>
      <Button size={size}>主要操作 {size}</Button>
      <Button size={size} variant="secondary">補助操作 {size}</Button>
      <Button size={size} tone="danger">取消 {size}</Button>
      <LinkButton size={size} to="/example">詳細へ {size}</LinkButton>
      <LinkButton size={size} variant="secondary" to="/example">一覧へ {size}</LinkButton>
    </div>)}
    <Button variant="text">入力を追加</Button>
  </div>,
};
// variantごとのdefault・disabled・pending。hoverはポインター、focusはTabで確認する。
export const States: Story = {
  render: () => <div className="form-section">
    {([["primary", undefined], ["secondary", undefined], ["primary", "danger"], ["secondary", "danger"]] as const).map(([variant, tone]) => <div className="action-row" key={`${variant}-${tone}`}>
      <Button variant={variant} tone={tone}>{variant}{tone ? ` ${tone}` : ""}</Button>
      <Button variant={variant} tone={tone} disabled>disabled</Button>
      <Button variant={variant} tone={tone} pending>pending...</Button>
    </div>)}
    <div className="action-row"><Button variant="text">text</Button><Button variant="text" disabled>text disabled</Button></div>
  </div>,
};
export const Disabled: Story = { args: { disabled: true, children: "変更できません" } };
export const Pending: Story = { args: { pending: true, children: "保存中..." } };
