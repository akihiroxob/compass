import type { Meta, StoryObj } from "@storybook/react-vite";
import { Checkbox, Field, Fieldset, Select, TextArea, TextInput } from "./index";

const meta = {
  title: "Components/FormControls",
  component: TextInput,
  tags: ["autodocs"],
  args: { placeholder: "名前を入力", size: "md", disabled: false, readOnly: false, required: false, "aria-label": "名前" },
  argTypes: { size: { control: "select", options: ["md", "sm"] } },
  parameters: { docs: { description: { component: "TextInput/Selectはmd・sm、TextAreaはrowsで高さを指定。標準HTML属性とrefを受け取る。Fieldでラベルと説明を関連付け、必須はFieldと入力の双方へ指定。複数のCheckboxはFieldsetでまとめる。aria-invalidとエラー説明は利用側が設定する。" } } },
} satisfies Meta<typeof TextInput>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Playground: Story = {};
export const Fields: Story = {
  render: () => <div className="form-section">
    {(["md", "sm"] as const).map((size) => <div className="form-section" key={size}>
      <Field label={`名前 ${size}`} required description="公開される表示名"><TextInput size={size} required defaultValue="検証用の名前" /></Field>
      <Field label={`表示 ${size}`}><Select size={size} defaultValue="open"><option value="open">未完了</option><option value="all">すべて</option></Select></Field>
    </div>)}
    <Field label="説明"><TextArea rows={3} defaultValue="検証用の説明" /></Field>
    <Fieldset legend="通知" required="1つ以上必須"><Checkbox defaultChecked>更新通知</Checkbox><Checkbox>完了通知</Checkbox><Checkbox disabled>選択できない通知</Checkbox></Fieldset>
    <Field label="行内の絞り込み" layout="inline"><TextInput size="sm" /></Field>
  </div>,
};
export const States: Story = {
  render: () => <div className="form-section">
    <Field label="読取専用"><TextInput readOnly value="参照のみ" /></Field>
    <Field label="無効な入力"><TextInput disabled value="変更できません" /></Field>
    <Field label="エラー"><TextInput aria-invalid="true" aria-describedby="catalog-error" defaultValue="" /></Field>
    <p id="catalog-error" role="alert">名前を入力してください。</p>
    <Field label="無効な説明"><TextArea disabled defaultValue="変更できません" /></Field>
    <Field label="読取専用の説明"><TextArea readOnly value="参照のみ" /></Field>
    <Field label="説明のエラー"><TextArea aria-invalid="true" aria-label="説明のエラー" /></Field>
    <Field label="無効な選択"><Select disabled><option>選択できません</option></Select></Field>
    <Field label="選択のエラー"><Select aria-invalid="true"><option>選択してください</option></Select></Field>
    <Fieldset legend="無効な選択肢" disabled><Checkbox defaultChecked>チェック済み</Checkbox><Checkbox>未チェック</Checkbox></Fieldset>
  </div>,
};
