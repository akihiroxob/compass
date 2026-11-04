import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { Button, Dialog, Select } from "./index";

const meta = {
  title: "Components/Dialog",
  component: Dialog,
  tags: ["autodocs"],
  args: { open: false, onClose: () => undefined, title: "権限について", children: null },
  parameters: { docs: { description: { component: "モーダル（native dialogのshowModal）。開閉は利用側のopen/onCloseで持つ。閉じる操作は右上の×（44px・読み上げ名「閉じる」）だけで、Escape・背景のclickでもonCloseを呼び、閉じた後は開いたボタンへfocusを戻す。headerを渡すと×と同じ行に置き、titleは読み上げ名だけに使う。placement=endは右端の全高（狭い画面のメニュー）。" } } },
} satisfies Meta<typeof Dialog>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Centered: Story = {
  render: function Centered(args) {
    const [open, setOpen] = useState(false);
    return <>
      <Button variant="secondary" onClick={() => setOpen(true)}>権限について</Button>
      <Dialog {...args} open={open} onClose={() => setOpen(false)}>
        <p>WorkspaceのMemberの権限は、Workspaceと配下の全Projectへ同じように適用されます。</p>
        <p>長い説明も区画の中で折り返し、横にはみ出しません。The quick brown fox jumps over the lazy dog without horizontal overflow.</p>
      </Dialog>
    </>;
  },
};

export const EndWithHeader: Story = {
  args: { title: "メニュー", placement: "end" },
  render: function EndWithHeader(args) {
    const [open, setOpen] = useState(false);
    return <>
      <Button variant="secondary" onClick={() => setOpen(true)}>メニューを開く</Button>
      <Dialog {...args} open={open} onClose={() => setOpen(false)} header={<Select aria-label="Workspaceを切り替える" defaultValue="a"><option value="a">とても長い名前のWorkspace（折返しと省略の確認）</option><option value="b">Petari</option></Select>}>
        <p>×はWorkspace選択と同じ行に置き、専用の行を作りません。</p>
      </Dialog>
    </>;
  },
};
