import type { Meta, StoryObj } from "@storybook/react-vite";
import { RoleHelpButton } from "./RoleHelp";

const meta = {
  title: "Patterns/RoleHelp",
  component: RoleHelpButton,
  tags: ["autodocs"],
  args: { workspaceName: "表示検証Workspace", size: "sm" },
  parameters: { docs: { description: { component: "Member管理の「権限について」。製品のRoleHelpButtonをそのまま表示する。Role説明は常設せず、ボタンで共通Dialogを開く。×・Escape・背景で閉じ、閉じた後は操作元のボタンへfocusが戻る。狭幅では折り返して横にはみ出さない。製品適用画面はWorkspaceのMember管理。" } } },
} satisfies Meta<typeof RoleHelpButton>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Closed: Story = {};
/** 長いWorkspace名でも折り返して表示する。 */
export const LongWorkspaceName: Story = { args: { workspaceName: "とても長い名前のWorkspace（折返しの確認）The quick brown fox jumps over the lazy dog without horizontal overflow" } };
