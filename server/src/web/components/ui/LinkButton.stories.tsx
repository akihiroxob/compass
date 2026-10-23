import type { Meta, StoryObj } from "@storybook/react-vite";
import { LinkButton } from "./index";

const meta = {
  title: "Components/LinkButton",
  component: LinkButton,
  tags: ["autodocs"],
  args: { children: "詳細へ", to: "/example", variant: "primary", size: "md" },
  argTypes: {
    variant: { control: "select", options: ["primary", "secondary"] },
    size: { control: "select", options: ["md", "sm"] },
  },
  parameters: { docs: { description: { component: "ボタンの見た目でURLへ遷移するLink。to/target等のRouter Link属性を渡せる。Buttonのdisabled/pendingは持たない。MemoryRouterをpreviewで供給し、実運用サービスを使わずに表示できる。" } } },
} satisfies Meta<typeof LinkButton>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Playground: Story = {};
export const CompactSecondary: Story = { args: { size: "sm", variant: "secondary" } };
