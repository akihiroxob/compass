import { useState, type ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Link, useLocation } from "react-router-dom";
import { Button, Field, LinkButton, TextInput, ViewSwitch } from "./ui";
import { PageColumns } from "./PageColumns";
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

/** 区画の中の一覧。行ごとに囲まず罫線で区切る。リンクの行はhoverで面を変え、操作列は同じsizeにそろえる。 */
const SampleSection = ({ title, children }: { title: string; children: ReactNode }) => <section className="detail-section"><h2>{title}</h2>{children}</section>;
export const ColumnsAndLists: Story = {
  parameters: { docs: { description: { story: "PageColumnsの主列（判断・履歴）と補助列（参照・件数）。区画の間隔は列が、行の区切りは一覧が持つ。本文の幅が主列30rem・補助列20remを確保できれば2列、足りなければ1列で積む。fixtureの文言は検証用。" } } },
  render: () => <SampleColumns />,
};
export const ColumnsInNarrowParent: Story = {
  parameters: { docs: { description: { story: "親layoutの幅が足りない場合（sidebarを含む中間幅の本文、幅44rem）。viewportが広くても本文の幅で1列に積み、主列が補助列に潰されない。" } } },
  render: () => <div style={{ maxWidth: "44rem" }}><SampleColumns /></div>,
};
function SampleColumns() {
  return <PageColumns
    main={<>
      <div className="claim-holder-toolbar"><span>検証用の取得時刻</span><Button size="sm" variant="secondary">再読込</Button></div>
      <SampleSection title="次の行動">
        <p className="next-action-summary">確認が必要な項目が2件あります。</p>
        <ul className="next-action-list">
          <li><LinkButton size="sm" to="/accept">受入を判断</LinkButton><small>レビュー済みの項目（fixture）</small></li>
          <li><span><span className="status-badge tone-waiting">担当待ち</span> 1件 — 担当Roleが未割当（fixture）</span></li>
        </ul>
      </SampleSection>
      <SampleSection title="最近の記録">
        <ul className="outcome-list">
          <li><Link to="/a">記録の行A<small>actor ・ 時刻</small></Link></li>
          <li><Link to="/b">記録の行B（長い名前が折り返しても横にはみ出さないことを確認するための文言）<small>actor ・ 時刻</small></Link></li>
        </ul>
      </SampleSection>
    </>}
    side={<>
      <SampleSection title="参照">
        <ul className="link-list"><li><Link to="/p"><span>参照先</span><small>補足</small></Link></li></ul>
        <Link to="/all" className="text-link">一覧を開く →</Link>
      </SampleSection>
      <SampleSection title="状態"><p><span className="status-badge tone-done">完了</span> <span className="status-badge tone-progress">進行中</span> <span className="status-badge tone-attention">要対応</span></p></SampleSection>
    </>}
  />;
}
export const Cards: Story = {
  parameters: { docs: { description: { story: "カードの一覧。内容の高さだけを持ち、親のgridが列数と間隔を決める。" } } },
  render: () => <section className="project-grid" aria-label="カードの例">
    <Link className="project-card" to="/p/1"><p className="card-label">Project</p><h2>カードA</h2><p>説明（fixture）</p><time>更新日</time></Link>
    <article className="project-card locked"><p className="card-label">Project</p><h2>開けないカード</h2><p className="locked-note">Membershipが無い場合の表示</p><time>更新日</time></article>
  </section>,
};
