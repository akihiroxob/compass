# Web UIの構成

`server/src/web`のReact UIの配置・共通部品・構造検査の現行の対応付け。共通の方針は配信Skillの`principles/frontend-architecture.md`・`tips/frontend-quality-gates.md`に従い、このProjectの実際のpathと検査範囲をここに定める。

## 配置と依存

| 責務 | 配置 |
| --- | --- |
| app（起動・routing・Provider・画面合成） | `app/`。`main.tsx`（起動・`BrowserRouter`）、`App.tsx`（routing）、`AppLayout.tsx`（route layout・Provider・Shellの合成）、`NotFoundPage.tsx`（未定義のURL） |
| features（機能固有のUI・hook・API・型） | `features/<機能>/`。他Featureは`index.ts`の公開入口から使う |
| 共通UI（機能に依存しない基本部品） | `components/ui/`。公開入口は`components/ui/index.ts` |
| 共通の組合せUI | `components/`（Shell・StateCard・ProjectOperationGate等） |
| 共通処理 | `web`直下の`.ts`（`api.ts`・`paths.ts`・`permissions.ts`等） |
| style・トークン | `styles/`（`_tokens.scss` → `_base` → `_layout` → `_components` → `_features`） |
| 検査 | `npm run check:ui`（`server/tests/uiStructure.test.ts`・`server/tests/support/uiStructure.ts`） |

依存はapp → Feature → 共通層（`components/`・`web`直下）の向きだけにする。appは各Featureの公開入口と共通層を使ってよい。FeatureはappとShellの枠に依存せず、共通層はFeature・appに依存しない。`components/ui`は`react`・`react-router-dom`と同じディレクトリ内だけに依存し、Feature・app・API・業務概念を参照しない。

## 入口・Provider・layout

| 責務 | 所有 | 内容 |
| --- | --- | --- |
| 起動 | `app/main.tsx` | `index.html`の入口。`StrictMode`・`BrowserRouter`・全体のstyle（`styles/main.scss`）を読み、`App`を描画する |
| routing | `app/App.tsx` | 全routeを定義し、各Featureの画面を公開入口から割り当てる。`/login`・`/invite`は`PublicLayout`、それ以外（未定義のURLの`NotFoundPage`を含む）は`AuthenticatedLayout`の子route |
| Session無しの枠 | `app/AppLayout.tsx`の`PublicLayout` | Shellのheaderに`SessionMenu`（auth）だけを出す。Session復元中・接続失敗は、同じ枠（`PublicFrame`）を`AuthGate`の`layout`として渡して表示する |
| ログイン後の枠 | `app/AppLayout.tsx`の`AuthenticatedLayout` | `AuthGate`（auth。Sessionの復元・未ログイン時のログイン画面への移動）→ `WorkspaceNavigationProvider`（workspace。URLから現在のWorkspace）→ Shellの順に合成し、Shellの`navigation`へ`WorkspaceSwitcher`・`WorkspaceNav`、`footer`へ参加中のProject、`session`へ`SessionMenu`を渡す。画面は`Outlet`へ描画する |
| 枠の表示 | `components/Shell.tsx` | brand・sidebar・本文の配置とskip linkだけを持つ表示部品。`navigation`を渡すとsidebar、省略するとheaderだけになる |
| 認可ゲート | `components/ProjectOperationGate.tsx`・`WorkspaceDirectionGate.tsx` | 作成・編集の画面を直接開いたときに操作できなければ、フォームの代わりに理由と戻り先を出す。枠はroute layoutが持つ |

Featureの画面は`<main>`から始まる本文だけを返し、Shell・Providerを自分で包まない。ログイン後の画面間の移動ではShellとProviderを保持し、本文だけを差し替える。

## 基本部品

| 部品 | API | 描画 |
| --- | --- | --- |
| `LinkButton` | `react-router-dom`の`Link`のprops（`className`・`style`を除く）と`variant`（`primary`既定・`secondary`）・`size` | 通常の`<a href>`。class `button` / `secondary-button`、`size="sm"`で`compact` |
| `ViewSwitch` | `label`（`nav`のaria-label）・`items`（`key`・`to`・`label`・`current`・任意の`count`）・`size` | `<nav>`内の`<a href>`。選択中の項目に`aria-current="page"` |

URLで表す遷移と表示切替はリンクのままにし、新しいタブ・戻る・再読込でも同じ表示になる。部品は外側余白・幅・配置を持たないため、`className`・`style`を受け取らない。

## size契約

`size`は`md`（既定）・`sm`。値は`_tokens.scss`の`--control-{md|sm}-height`・`--control-{md|sm}-padding-x`・`--control-{md|sm}-font-size`と共通の`--control-border-width`・`--control-line-height`で定め、`_mixins.scss`の`control-size($size)`だけが適用する。`.button`・`.secondary-button`・`.view-switch-item`は同じmixinを使うため、既存の`.button`・`.compact`も同じ値になる。

| size | 高さ（min-height） | 左右padding | 文字 |
| --- | --- | --- | --- |
| `md` | 3rem | `--space-md`（1.25rem） | 1rem |
| `sm` | 2.4rem | .9rem | `--text-note`（.9rem） |

部品間のgap・折返し・一覧との余白は親layoutが持つ。一覧の上の操作列は`.list-toolbar`（flex・折返し・`align-items: center`・gap `--space-sm`・下余白`--space-lg`）を使い、列内の部品は同じ`size`を指定する。切替だけを置く一覧でも、下余白は`.list-toolbar`が持つ。

## 構造検査（`npm run check:ui`）

rootの`npm run check:ui`は`server`の同名scriptへ委譲し、検査自体をfixtureで確かめたうえで実際の`server/src/web`を検査する。

- 依存方向（web全体の`.ts`・`.tsx`）: 共通層からFeature・app、Featureからappへの依存がない。他Featureへは`features/<機能>/index.ts(x)`の公開入口だけを使う。`import`・`export ... from`（型だけを含む）・文字列の`import()`・`require()`・`import("x")`型を、TypeScriptのbundler解決とweb tsconfigの`paths`で実際のfileへ解決して判定するため、alias・再exportの経由も検出する。web内で解決できないlocal importと文字列でない`import()`は失敗にする。app・Feature・共通層のいずれかのsourceが無い（空走査）と失敗する。
- `components/ui`: Feature・app等への依存がない。
- 保護対象の範囲: `<button>`、基本部品のclass（`button`・`secondary-button`・`compact`・`view-switch`・`view-switch-item`・`list-switch`）を直接付けた要素、基本部品への`className`・`style`がない。`.list-toolbar`内に`a`・`Link`・`NavLink`・`button`を直接置かず、部品はすべて同じ`size`を文字列で指定する。保護対象のfile・componentが見つからなければ失敗する。
- SCSS: `control-size`の全宣言（補間`#{$size}`を含む）の値が`0`か`--control-*`トークンだけで、`min-height`・`padding`・`font-size`を定め、md・smのトークンが定義されている。`.view-switch`・`.view-switch-item`と`.list-toolbar`内のbutton類に外側余白・固定sizeを足さない。廃止した`.list-switch`を使わない。

保護対象（段階適用の範囲）は`uiProtectedScopes`で定める。

| 対象 | 範囲 |
| --- | --- |
| `features/project/ProjectListPage.tsx` | file全体（参加中のProjectと`ProjectListSwitch`） |
| `features/workspace/WorkspacePages.tsx` | `ProjectsContent`（WorkspaceのProject一覧） |
| `features/execution/ExecutionSection.tsx` | `TaskFilterSwitch`（Taskの絞り込み） |

他Featureの内部fileへの既存の依存は、`knownCrossFeatureImports`に`from -> to`の組で個別に列挙する（Featureの公開入口の整理を所有する後続Taskで解消する）。一覧に無い依存は失敗し、解消した依存が一覧に残っていても失敗する。

viteの`resolve.alias`（現在は未使用）、SCSSの依存、実行時に組み立てる依存は機械的に検査しない。

上記以外の画面にある`<button>`・`className="button"`等の既存実装は検査対象外で、未移行である。画面を基本部品へ移すときに、その範囲を`uiProtectedScopes`へ加える。検査は字句から読める`className`と文字列の`size`を対象とし、実際の描画寸法・見た目は実ブラウザで確認する。
