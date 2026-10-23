import type { CSSProperties } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import tokensSource from "./_tokens.scss?raw";

// 名前も値も正本の宣言から生成する。実際の解決値はpreviewが読む製品SCSSに任せる。
const tokens = [...tokensSource.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)];
const meta = {
  title: "Foundations/Tokens",
  tags: ["autodocs"],
  parameters: { docs: { description: { component: "styles/_tokens.scssが正本。色・状態色・文字・余白・control size・角丸・影・動きの宣言をソースから生成する。色見本と文字は製品SCSSのCSS変数を参照する。新テーマの視覚方針と参照画像はdocs/ui-catalog.mdを参照。" } } },
} satisfies Meta;
export default meta;
export const Current: StoryObj = {
  render: () => <><h1>現在のデザイントークン</h1><p>値の正本: styles/_tokens.scss</p><dl>
    {tokens.map(([, name, value]) => {
      const style: CSSProperties = name.startsWith("--color-") || /-(fg|bg|border)$/.test(name)
        ? { borderLeft: `var(--space-lg) solid var(${name})`, paddingLeft: "var(--space-sm)" }
        : name.startsWith("--font-") ? { fontFamily: `var(${name})` } : {};
      return <div key={name}><dt><code>{name}</code></dt><dd style={style}>{value}</dd></div>;
    })}
  </dl></>,
};
