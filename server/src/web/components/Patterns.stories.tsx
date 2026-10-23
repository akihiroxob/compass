import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useLocation } from "react-router-dom";
import { Button, Field, LinkButton, TextInput, ViewSwitch } from "./ui";
import { ConfirmPanel } from "./ReasonPanel";
import { ErrorState, Loading, StateCard } from "./StateCard";

const meta = {
  title: "Patterns/SharedUI",
  tags: ["autodocs"],
  parameters: { docs: { description: { component: "製品の共通layoutと組合せUI。操作列は同じsizeで構成する。フォームはFieldと標準HTML検証、確認はConfirmPanelを使い、API実行と業務判断はFeatureが所有する。このfixtureの送信はローカル状態のみを変更する。" } } },
} satisfies Meta;
export default meta;
type Story = StoryObj;
export const Toolbar: Story = {
  render: function Toolbar() {
    const { pathname } = useLocation();
    return <div className="list-toolbar">
      <ViewSwitch size="sm" label="表示" items={[{ key: "open", label: "未完了", to: "/", current: pathname === "/", count: 3 }, { key: "all", label: "すべて", to: "/all", current: pathname === "/all", count: 8 }]} />
      <LinkButton size="sm" to="/new">追加</LinkButton>
      <Button size="sm" variant="secondary">再読込</Button>
    </div>;
  },
};
export const Form: Story = {
  render: function Form() {
    const [saved, setSaved] = useState(false);
    return <form className="form-section" onSubmit={(event) => { event.preventDefault(); setSaved(true); }}>
      <Field label="名前" required description="検証用の入力です"><TextInput required /></Field>
      <div className="form-actions"><Button type="submit">保存する</Button></div>
      {saved && <StateCard role="status">入力を確認しました（API送信なし）。</StateCard>}
    </form>;
  },
};
export const Confirmation: Story = {
  render: function Confirmation() {
    const [open, setOpen] = useState(false);
    const [done, setDone] = useState(false);
    return <>{open ? <ConfirmPanel title="取消を確認" description="検証用の確認です。実データは変更しません。" error={null} pending={false} danger focusHeading submitLabel="取消を確定" onCancel={() => setOpen(false)} onSubmit={(event) => { event.preventDefault(); setDone(true); setOpen(false); }} /> : <Button tone="danger" onClick={() => setOpen(true)}>取消を確認する</Button>}{done && <StateCard role="status">確認しました。</StateCard>}</>;
  },
};
export const ConfirmationPending: Story = {
  render: () => <ConfirmPanel title="取消を確認" description="処理中の表示例" error={null} pending danger submitLabel="取消中..." onCancel={() => {}} onSubmit={(event) => event.preventDefault()} />,
};
export const ConfirmationError: Story = {
  render: () => <ConfirmPanel title="取消を確認" description="失敗時にも確認内容を保持する" error="検証用の失敗です。再試行してください。" pending={false} danger submitLabel="再試行" onCancel={() => {}} onSubmit={(event) => event.preventDefault()} />,
};
export const States: Story = { render: () => <><Loading /><ErrorState message="検証用の接続エラー" /><StateCard>表示する項目がありません。</StateCard></> };
