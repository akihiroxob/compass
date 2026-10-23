# UIカタログ

製品の共通部品の用途・API・使用例・状態を、Storybook React/Viteで確認する。現在の製品表示が対象で、[ムードボード](design/compass-moodboard-blue.png)の青藍・白・青灰色とサンセリフへの更新はまだ適用していない。画像は視覚方向の参照であり、架空のデータ・進捗率・Agent表示は業務仕様にしない。情報構造・密度の参照は`/Users/aokayama/git/compass-prototype`（ローカル参照URL `http://localhost:8443/`）。現行の配置・API・UI検査は[Web UI](web-ui.md)を正本とする。

## 起動とbuild

Repository rootで実行する。Compass Server・DB・ログイン・Credentialは不要。

```sh
npm ci
npm run catalog:dev
# http://127.0.0.1:6006/
npm run catalog:build
# server/storybook-static/（生成物はGit管理しない）
```

devはループバックだけでlistenする。終了は`Ctrl+C`。静的buildを確認する場合は`python3 -m http.server 6007 --bind 127.0.0.1 --directory server/storybook-static`で配信し、確認後に停止する。製品buildの`server/public`とは独立した出力で、Serverからカタログを公開しない。

## 選定と依存

`storybook`・`@storybook/react-vite`・`@storybook/addon-docs`を同じ`10.6.3`に固定し、`server` workspaceの開発依存として導入する。[React/Vite公式構成](https://storybook.js.org/docs/get-started/frameworks/react-vite/)を採用し、CSF・Controls・Autodocs・使用コード表示を利用する。React/Viteの別実装や新しいCSS基盤を必要としない。

導入版のnpm peer metadataはReact/React DOM `^19.0.0`、Vite `^7.0.0`、TypeScript `>=4.9.x`を含む。Node `24.16.0`・React `19.3.0`・Vite `7.3.6`・TypeScript `6.0.3`の既存環境でtypecheck・製品build・カタログbuild・dev描画を確認する。[公式の導入要件](https://storybook.js.org/docs/get-started/install/)も参照する。互換性上の阻害要因がなく、第一候補で必要機能が揃うため、Ladle等への置換は行わない。

外部サービス・CI・有料画像比較・Storybook MCPを運用要件にしない。導入版が生成する`index.json`を部品/状態例の一覧確認に使える。これは実ブラウザ操作や視覚確認の代替ではない。Agent向け追加manifest/MCPは初期導入に不要なため接続していない。

## 構成と共有する正本

| 対象 | ソース・役割 |
| --- | --- |
| 設定 | `server/.storybook/main.ts`。製品のVite設定を読まず、API proxy・public成果物を取り込まない。JSX automatic runtimeを明示し、環境変数の公開prefixを`CATALOG_PUBLIC_`に限定 |
| preview | `server/.storybook/preview.tsx`。製品と同じ`app/main.scss`と`MemoryRouter`を使う。認証・Workspace Providerは基本部品に不要なので起動しない |
| Foundations | `styles/Tokens.stories.tsx`。`styles/_tokens.scss?raw`から名前・値を生成し、見本は製品のCSS変数で描画。色・状態色・文字・余白・control size・角丸・影・動きの値一覧を二重管理しない |
| Components | `components/ui/*.stories.tsx`。製品と同じ`components/ui/index.ts`からButton/LinkButton、入力、Field/Fieldset、ViewSwitchを使用 |
| Patterns | `components/Patterns.stories.tsx`。既存の操作列・フォーム・ConfirmPanel・StateCardを使用。APIに依存せずローカル状態で入力・確認・完了を用意 |

カタログ用の部品・SCSSは持たない。Foundationsのinline styleはtoken見本の描画だけに用い、基本部品のstyleを上書きしない。状態例は対応する部品/トークンの近くに置き、製品の公開入口からexportしない。将来Contextが必要な部品を追加する場合も、必要範囲だけをpreviewで用意し、実運用APIや秘密をfixtureへ持ち込まない。

## 見る・操作する

| 一覧 | 使用例と確認する契約 |
| --- | --- |
| `Foundations/Tokens` | 現在の全CSS token宣言。参照値も正本から表示する |
| `Components/Button` | Controlsでvariant/size/tone、md/smのButton・LinkButton、text、disabled、pendingを確認。pendingはdisabledとaria-busyを付ける。textはsizeを持たない |
| `Components/LinkButton` | URL遷移のControls、primary/secondaryとmd/sm。Router Link標準属性を受ける |
| `Components/FormControls` | TextInputのControls、md/smの入力とSelect、TextArea、必須/説明つきField、inline Field、FieldsetとCheckbox。readOnly/disabled/aria-invalid、選択済み・未選択を確認 |
| `Components/ViewSwitch` | md/sm、件数と選択中表示。NavigationでURLとaria-currentの切替を確認 |
| `Patterns/SharedUI` | 同sizeの操作列、標準HTML検証つきフォーム、確認の見出しfocus・キャンセル・確定、pending/error/読込/空状態 |

各Docsに用途・Controls/props・使用コードを表示する。詳細な標準属性・部品API・部品の使い分けは[Web UIの基本部品](web-ui.md#基本部品)も参照する。hoverはポインターを重ね、focusはTab/Shift+Tabで確認する。disabled/pendingをクリックしても操作されないこと、入力ラベル・required・エラーの関連付け、ViewSwitchのリンクと選択中表示を確認する。未実装のloading等のAPIを見本だけに追加しない。

## 構造検査と更新手順

`npm run check:ui`はstoryも走査する。web内の`*.stories.tsx`だけに`import type ... from "@storybook/react-vite"`を許可し、Storybookの実行時importは許可せず、基本部品近傍ではFeature/app/API依存も許可しない。storyにもnative基本部品禁止・propsによるstyle上書き禁止・操作列のsize整合を適用する。製品sourceからstoryへの依存は禁止する。SCSSの所有・重複・入口検査も維持する。storyを丸ごと除外しない。

1. 製品のtoken/部品を修正し、近傍storyの用途・API・関係する状態例を更新する。
2. `npm run check:ui`・`npm run typecheck`・`npm run lint`・関連テスト・`npm run build`・`npm run catalog:build`を実行する。typecheckは`.storybook`設定も含む。
3. devと静的buildの対象例を開き、Desktop（1280px）・狭い画面（390px）で描画・操作・focus・折返しを確認し、画像を保存して目視する。
4. 対象HEADと作業差分、配信HTMLが参照するasset名/ハッシュ、状態・操作・実測・未検証を結果へ記録する。部品修正時は製品の利用画面も確認する。カタログの成功だけで全画面や新テーマを検証済みとしない。

生成物の大きさに対するViteのchunk警告は性能改善の余地を示す。カタログの初期導入では外部配信や製品への同梱を行わない。
