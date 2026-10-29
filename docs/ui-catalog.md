# UIカタログ

製品の共通部品の用途・API・使用例・状態を、Storybook React/Viteで確認する。製品と同じtoken・SCSSを読むため、[Web UIの視覚方針](web-ui.md#視覚方針)（青藍・白・青灰色、サンセリフ）がカタログと製品の両方へ同じbuildで反映される。[ムードボード](design/compass-moodboard-blue.png)は視覚方向の参照であり、架空のデータ・進捗率・Agent表示は業務仕様にしない。情報構造・密度の参照は`/Users/aokayama/git/compass-prototype`（ローカル参照URL `http://localhost:8443/`）。現行の配置・API・UI検査は[Web UI](web-ui.md)を正本とする。

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

外部サービス・CI・有料画像比較・Storybook MCPを運用要件にしない。Agent向け追加manifest/MCPは接続していない。Agentは人と同じく、部品近傍のstory（用途・props・使用例）と[Web UIの基本部品](web-ui.md#基本部品)を読む。`catalog:build`が生成する`server/storybook-static/index.json`は、状態例ごとの`id`・`title`・`importPath`（story）・`componentPath`（公開入口）の一覧として使える。いずれも実ブラウザの操作・視覚確認の代替ではない。

## 4つの正本

| 要素 | 正本 | 他の要素との関係 |
| --- | --- | --- |
| UI方針 | [Web UIの視覚方針](web-ui.md#視覚方針)（配色・文字・余白・密度・画面の構成・残す囲み） | 値を書く場合は採用判断の説明として書き、値の正本はtokenとする |
| token | `server/src/web/styles/_tokens.scss` | 色の値はここだけに置き、他のSCSS・TSXに色を直書きしない。Foundationsはこのソースから一覧を生成する |
| 部品 | `components/ui/`（公開入口`index.ts`）と組合せUI（`components/`）・その所有partial。APIは[基本部品](web-ui.md#基本部品)・[size契約](web-ui.md#size契約) | 製品とカタログが同じソースを読む |
| カタログ | 部品・tokenの近傍の`*.stories.tsx`と`server/.storybook/` | 部品・SCSS・tokenを持たず、状態例・使用例だけを持つ |

## 構成

| 対象 | ソース・役割 |
| --- | --- |
| 設定 | `server/.storybook/main.ts`。製品のVite設定を読まず、API proxy・public成果物を取り込まない。JSX automatic runtimeを明示し、環境変数の公開prefixを`CATALOG_PUBLIC_`に限定 |
| preview | `server/.storybook/preview.tsx`。製品と同じ`app/main.scss`と`MemoryRouter`を使う。認証・Workspace Providerは基本部品に不要なので起動しない |
| Foundations | `styles/Tokens.stories.tsx`。`styles/_tokens.scss?raw`から名前・値を生成し、見本は製品のCSS変数で描画。色・状態色・文字・余白・control size・角丸・影・動きの値一覧を二重管理しない |
| Components | `components/ui/*.stories.tsx`。製品と同じ`components/ui/index.ts`からButton/LinkButton、入力、Field/Fieldset、ViewSwitchを使用 |
| Patterns | `components/Patterns.stories.tsx`。既存の操作列・フォーム・ConfirmPanel・StateCard・PageColumns・罫線区切りの一覧・Projectカードを使用。APIに依存せずローカル状態で入力・確認・完了を用意。`features/direction/DirectionPanel.stories.tsx`はMission・Visionの帯とPageColumnsの組合せ |

カタログ用の部品・SCSSは持たない。Foundationsのinline styleはtoken見本の描画だけに用い、基本部品のstyleを上書きしない。状態例は対応する部品/トークンの近くに置き、製品の公開入口からexportしない。将来Contextが必要な部品を追加する場合も、必要範囲だけをpreviewで用意し、実運用APIや秘密をfixtureへ持ち込まない。

## 見る・操作する

| 一覧 | 使用例と確認する契約 |
| --- | --- |
| `Foundations/Tokens` | 現在の全CSS token宣言。参照値も正本から表示する。用途とコントラストは[視覚方針](web-ui.md#視覚方針) |
| `Components/Button` | Controlsでvariant/size/tone、md/smのButton・LinkButton、text、disabled、pendingを確認。`States`でvariant・toneごとのdefault/disabled/pendingを並べる。pendingはdisabledとaria-busyを付ける。textはsizeを持たない |
| `Components/LinkButton` | URL遷移のControls、primary/secondaryとmd/sm。Router Link標準属性を受ける |
| `Components/FormControls` | TextInputのControls、md/smの入力とSelect、TextArea、必須/説明つきField、inline Field、FieldsetとCheckbox。readOnly/disabled/aria-invalid、選択済み・未選択を確認 |
| `Components/ViewSwitch` | md/sm、件数と選択中表示。NavigationでURLとaria-currentの切替を確認 |
| `Patterns/SharedUI` | 同sizeの操作列、標準HTML検証つきフォーム、確認の見出しfocus・キャンセル・確定、pending/error/読込/空状態。`ColumnsAndLists`で主列・補助列、`ColumnsInNarrowParent`で親layoutの幅が足りない場合の1列、罫線区切りの一覧（リンク行のhover・長い文言の折返し）、補助列の縦積み、状態badge。`Cards`でProjectカード（開ける・開けない） |
| `Patterns/OverviewLayout` | Mission・Visionの帯（Visionの未設定・長い文言）と、帯の下のPageColumns。本文の幅が足りれば2列、足りなければ1列 |

各Docsに用途・Controls/props・使用コードを表示する。詳細な標準属性・部品API・部品の使い分けは[Web UIの基本部品](web-ui.md#基本部品)も参照する。hoverはポインターを重ね、focusはTab/Shift+Tabで確認する。disabled/pendingをクリックしても操作されないこと、入力ラベル・required・エラーの関連付け、ViewSwitchのリンクと選択中表示を確認する。未実装のloading等のAPIを見本だけに追加しない。

## 構造検査

`npm run check:ui`はstoryも走査する。web内の`*.stories.tsx`だけに`import type ... from "@storybook/react-vite"`を許可し、Storybookの実行時importは許可せず、基本部品近傍ではFeature/app/API依存も許可しない。storyにもnative基本部品禁止・propsによるstyle上書き禁止・操作列のsize整合を適用する。製品sourceからstoryへの依存は禁止する。SCSSの所有・重複・入口検査も維持する。storyを丸ごと除外しない。

## 運用手順

部品を探す → 用途・状態を確認する → 実画面へ適用する → レビュー・受入の順に進める。カタログの確認だけで画面の受入を済ませない。

### Worker（UIを変更する）

1. 探す: カタログの`Components`・`Patterns`と[基本部品](web-ui.md#基本部品)から使う部品・組合せを選ぶ。該当がなければ`components/`・`features/`の類似実装を探し、新しい部品・variantを作る前に既存APIで足りない理由を記録する。
2. 確認する: storyのDocsで用途・props・size/variant・関係する状態（disabled・pending・error・選択中・空）を確認する。値は`Foundations/Tokens`と[視覚方針](web-ui.md#視覚方針)で確認し、色・寸法をFeatureのSCSSへ直書きしない。
3. 適用する: 製品の部品・token・SCSSを修正する。共通部品・token・組合せUIを変えたら、近傍storyの用途・API・状態例を同じ変更で更新し、その部品を使う製品画面（[主要画面](web-ui.md#主要画面への適用と残存する囲み)のうち該当するもの）を一覧にする。
4. 検査する: `npm run check:ui`（tokenのコントラスト測定を含む）・`npm run typecheck`（`.storybook`設定を含む）・`npm run lint`・関連テスト・`npm run build`・`npm run catalog:build`を実行する。
5. 実画面で確かめる: 変更した状態例と、手順3で一覧にした製品画面を、Desktop（1280px）・狭い画面（390px）の実ブラウザで開く。描画・操作・focus・折返し・横はみ出しを確認し、画像を保存して目視する。製品画面は[ブラウザ検証データ](browser-verification.md)の専用previewで、実データ・権限差・空・失敗の状態を含めて確認する。
6. 記録する: 対象HEAD・作業差分、配信HTMLが参照するasset名（[配信assetとbuild](#配信assetとbuild)）、状態・操作・実測・画像・未検証を結果へ残す。

### Reviewer

- 部品・token・SCSSの変更に対し、近傍storyの状態例と適用画面の一覧が更新されているかを差分で確認する。カタログ用の部品・SCSS・色定数、Feature側の上書きで見た目を変えていないかを見る。
- 検査コマンドの結果と、Workerが記録したasset名・画像・実測が対象HEADのbuildに対応しているかを確かめる。必要ならカタログと製品画面を開き直す。
- [機械的に保証しない範囲](web-ui.md#機械的に保証しない範囲と手動レビュー)（描画寸法・折返し・nav/detailsの意味・ボタン風のリンク等）を差分と画面で確認する。

### Manager（受入）

- 専用previewで、変更した部品を使う製品画面をACの状態・Roleで開き、Desktop・狭い画面で受け入れる。カタログの状態例は部品の契約の確認に使い、画面の受入の代わりにしない。
- previewの配信HTMLが参照するassetが受入対象SHAのbuildであることを確認し、古い生成物の画面で受け入れない。

## 配信assetとbuild

- 製品: `npm run build`が`server/public/index.html`と`server/public/assets/index-<hash>.css`・`index-<hash>.js`を生成し、Serverがそれを配信する。rootの`npm start`はbuildしてから起動する。確認時は配信HTMLが参照するasset名をbuild直後の`server/public/index.html`と照合する。
- カタログ: `npm run catalog:build`が`server/storybook-static/`を生成し、状態例は`iframe.html`が`assets/iframe-<hash>.css`を読む。製品と同じ`app/main.scss`をViteで処理するため、SCSS・tokenが同じならCSSのファイル名のhashと内容は製品と一致する。一致しなければ、どちらかが古いbuildか、カタログ側でstyleを追加している。
- 生成物はGit管理しない。検証の記録には、SHA・asset名・必要ならCSSのSHA-256を残す。

## 検査の限界

- `check:ui`は字句から読める依存・class・SCSS宣言・tokenのコントラストを検査する。描画寸法・折返し・見た目は実ブラウザで確認する。token以外への色の直書きは検査しないため、差分で確認する（例: `grep -rnE '#[0-9a-fA-F]{3,8}\b|rgba?\(' server/src/web --include='*.scss' --include='*.tsx' --include='*.ts'`の該当が`styles/_tokens.scss`だけであること）。
- カタログは部品単位の状態と組合せを、APIに依存しない局所状態で示す。実データ・認可・取得失敗・画面遷移は製品画面でしか確認できない。
- full-pageの画像では、viewportに固定した要素（狭い画面の下端のWorkspaceナビゲーション、Desktopのsidebarの面）が最初のviewportの位置・高さで写る。末尾の内容と重ならないかは、スクロールした状態の画像で確認する。
- Viteのchunk警告（製品jsの500kB超過）は性能改善の余地を示し、検証の失敗ではない。カタログは外部配信せず、製品へ同梱しない。
