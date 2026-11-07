import type { Meta, StoryObj } from "@storybook/react-vite";
import { IconButton } from "./index";

const meta = {
  title: "Components/IconButton",
  component: IconButton,
  tags: ["autodocs"],
  args: { icon: "close", label: "閉じる" },
  argTypes: { icon: { control: "select", options: ["close", "menu"] } },
  parameters: { docs: { description: { component: "アイコンだけのボタン。操作領域は44px四方（`--control-icon-size`）、labelは読み上げ名（aria-label）として必須。閉じる×はDialogの右上、メニューは狭い画面のheaderで使う。aria-expanded=trueでブランド色になる。" } } },
} satisfies Meta<typeof IconButton>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Playground: Story = {};
export const Icons: Story = {
  render: () => <div className="action-row">
    <IconButton icon="close" label="閉じる" />
    <IconButton icon="menu" label="メニュー" aria-expanded={false} />
    <IconButton icon="menu" label="メニュー（開いている）" aria-expanded />
  </div>,
};
