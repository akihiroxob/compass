# Web UIの構成

`server/src/web`のReact UIの配置・共通部品・構造検査の現行の対応付け。共通の方針は配信Skillの`principles/frontend-architecture.md`・`tips/frontend-quality-gates.md`に従い、このProjectの実際のpathと検査範囲をここに定める。

## 配置と依存

| 責務 | 配置 |
| --- | --- |
| app（起動・routing・Provider・画面合成） | `app/`。`main.tsx`（起動・`BrowserRouter`）、`App.tsx`（routing）、`AppLayout.tsx`（route layout・Provider・Shellの合成）、`NotFoundPage.tsx`（未定義のURL） |
| features（機能固有のUI・hook・API・型・validation） | `features/<機能>/`。他Featureは公開入口（`index.ts`・`model.ts`）から使う |
| 共通UI（機能に依存しない基本部品） | `components/ui/`。公開入口は`components/ui/index.ts` |
| 共通の組合せUI | `components/`（Shell・StateCard・FormErrorSummary・ListInputs・ReasonPanel） |
| 共通処理 | `web`直下の`.ts`（`api.ts`の汎用transport・エラー分類・部分取得`settle`、`paths.ts`の画面URL・Web API path、`statusTone.ts`、`useHashTarget.ts`） |
| style・トークン | `styles/`（`_tokens.scss` → `_base` → `_layout` → `_components` → `_features`） |
| 検査 | `npm run check:ui`（`server/tests/uiStructure.test.ts`・`server/tests/support/uiStructure.ts`） |

依存はapp → Feature → 共通層（`components/`・`web`直下）の向きだけにする。共通層は業務の型・判定を持たず、共通UIは自身のpropsの形だけを定義する（例: `ListInputs`のリンク行）。appは各Featureの公開入口と共通層を使ってよい。FeatureはappとShellの枠に依存せず、共通層はFeature・appに依存しない。`components/ui`は`react`・`react-router-dom`と同じディレクトリ内だけに依存し、Feature・app・API・業務概念を参照しない。

## 入口・Provider・layout

| 責務 | 所有 | 内容 |
| --- | --- | --- |
| 起動 | `app/main.tsx` | `index.html`の入口。`StrictMode`・`BrowserRouter`・全体のstyle（`styles/main.scss`）を読み、`App`を描画する |
| routing | `app/App.tsx` | 全routeを定義し、各Featureの画面を公開入口から割り当てる。`/login`・`/invite`は`PublicLayout`、それ以外（未定義のURLの`NotFoundPage`を含む）は`AuthenticatedLayout`の子route |
| Session無しの枠 | `app/AppLayout.tsx`の`PublicLayout` | Shellのheaderに`SessionMenu`（auth）だけを出す。Session復元中・接続失敗は、同じ枠（`PublicFrame`）を`AuthGate`の`layout`として渡して表示する |
| ログイン後の枠 | `app/AppLayout.tsx`の`AuthenticatedLayout` | `AuthGate`（auth。Sessionの復元・未ログイン時のログイン画面への移動）→ `WorkspaceNavigationProvider`（workspace。URLから現在のWorkspace）→ Shellの順に合成し、Shellの`navigation`へ`WorkspaceSwitcher`・`WorkspaceNav`、`footer`へ参加中のProject、`session`へ`SessionMenu`を渡す。画面は`Outlet`へ描画する |
| 枠の表示 | `components/Shell.tsx` | brand・sidebar・本文の配置とskip linkだけを持つ表示部品。`navigation`を渡すとsidebar、省略するとheaderだけになる |
| 認可ゲート | `features/access/`の`ProjectOperationGate`・`WorkspaceDirectionGate` | 作成・編集の画面を直接開いたときに操作できなければ、フォームの代わりに理由と戻り先を出す。枠はroute layoutが持つ |

Featureの画面は`<main>`から始まる本文だけを返し、Shell・Providerを自分で包まない。ログイン後の画面間の移動ではShellとProviderを保持し、本文だけを差し替える。

## Featureと公開入口

| Feature | 所有するもの |
| --- | --- |
| `access` | Project・Workspaceの操作可否（`permissions.ts`・`projectAccess.ts`）、取得hook（`useProjectAccess.ts`・`useWorkspaceDirection.ts`）、認可ゲート |
| `direction` | Directionの現在地・要対応・貢献の判定（`direction.ts`・`overview.ts`）と取得（`directionData.ts`）、評価段階の表示（`DirectionStatus.tsx`）。Workspaceの概要・方向とProjectの概要が使う |
| `project` | Projectの型・入力検証（`project.ts`）、アーカイブ（`projectArchive.ts`）、Project詳細・一覧 |
| `intent`・`outcome`・`decision`・`research`・`adr` | 各Directionの型・入力検証・変換（`intent.ts`・`outcome.ts`・`decision.ts`・`research.ts`・`adr.ts`）と画面 |
| `workspace` | Workspaceの型・ナビゲーション（`workspace.ts`）・入力検証（`workspaceForm.ts`）・所属Projectの取得（`workspaceProjects.ts`）と画面 |
| `execution`・`activity`・`agent`・`grant`・`credential`・`member`・`auth` | 各機能の型・API取得・画面 |

公開入口は2種類とする。

- `index.ts(x)`: UIを含む入口。appと他Featureの画面が使う。
- `model.ts`: 純粋な型・関数だけの入口。他Featureの純関数のmodule（`.ts`）が読み、`.tsx`へ推移的に依存しない。必要なFeatureだけが持つ（`access`・`credential`・`direction`・`execution`・`grant`）。`index.ts`は`model.ts`を再exportする。

Feature内のfileは自身の`index`を経由せず内部fileを直接参照する。Feature間の依存は非循環にする。逆向きの連携が必要な場合は、構造型（必要な項目だけの型）で受けるか、appがslotで合成する（例: Task詳細のWorkspaceパンくずは`app/App.tsx`が`TaskDetailPage`の`workspaceCrumbs`へ`WorkspaceBreadcrumbItems`を渡す）。テストはFeatureの内部fileを直接読んでよい（`server/tests`は検査対象外）。

## 基本部品

| 部品 | API | 描画 |
| --- | --- | --- |
| `LinkButton` | `react-router-dom`の`Link`のprops（`className`・`style`を除く）と`variant`（`primary`既定・`secondary`）・`size` | 通常の`<a href>`。class `button` / `secondary-button`、`size="sm"`で`compact` |
| `Button` | `<button>`の標準属性とref（`className`・`style`を除く）、`variant`（`primary`既定・`secondary`・`text`）・`size`・`tone="danger"`・`pending` | `<button>`。`type`の既定は`button`で、送信は`type="submit"`を明示する。`pending`で`disabled`と`aria-busy="true"`。`text`は枠の無い文字だけのボタン（`text-button`。sizeを持たない） |
| `ViewSwitch` | `label`（`nav`のaria-label）・`items`（`key`・`to`・`label`・`current`・任意の`count`）・`size` | `<nav>`内の`<a href>`。選択中の項目に`aria-current="page"` |
| `Field` | `label`・`required`（「必須」の表示）・`description`（説明）・`labelHidden`（読み上げだけのlabel）・`layout`（`stack`既定・`inline`）・`children`（入力部品1つ） | 入力を包む`<label class="field">`。説明もlabelに含めて読み上げる |
| `TextInput` | `<input>`の標準属性とref（`className`・`style`・`size`を除く）、`type`（`text`既定・`email`・`url`・`search`・`password`・`number`・`tel`）・`size` | `<input class="input">`。`required`で`aria-required="true"`も付く |
| `TextArea` | `<textarea>`の標準属性とref（`className`・`style`を除く） | `<textarea class="textarea">`。高さは`rows` |
| `Select` | `<select>`の標準属性とref（`className`・`style`・`size`・`multiple`を除く）、`size`。選択肢は`<option>`・`<optgroup>`を子に渡す | `<select class="select">` |
| `Checkbox` | `<input type="checkbox">`の標準属性とref、`children`（label） | `<label class="checkbox">`で包んだcheckbox |

URLで表す遷移と表示切替はリンクのままにし、新しいタブ・戻る・再読込でも同じ表示になる。部品は外側余白・幅・配置を持たないため、`className`・`style`を受け取らない。

### フォームの組立て

- 入力の欄は`Field`で入力部品を包む。`Field`の`required`は表示だけのため、検証する入力部品にも`required`を指定する。
- 送信の検証エラーは`components/FormErrorSummary`が持つ。入力部品へ`fieldProps(invalid, id)`を渡すと、`id`と、検証に失敗した欄の`aria-invalid="true"`・要約（`#form-error-summary`）への`aria-describedby`が付き、要約のリンクから欄へ移れる。
- 送信ボタンは`<Button type="submit" pending={送信中}>`とし、送信中の文言は利用側が切り替える。保存の失敗時も入力stateを保持し、そのまま再送信できるようにする。
- 可変行の入力は`components/ListInputs`（`TextListInput`・`LinkListInput`）、危険操作の確認・理由は`components/ReasonPanel`を使う。どちらも内部で基本部品を使う。
- 入力の検証・保存・認可はFeatureが持ち、基本部品は持たない。

## size契約

`size`は`md`（既定）・`sm`。値は`_tokens.scss`の`--control-{md|sm}-height`・`--control-{md|sm}-padding-x`・`--control-{md|sm}-font-size`と共通の`--control-border-width`・`--control-line-height`で定め、`_mixins.scss`の`control-size($size)`だけが適用する。`.button`・`.secondary-button`・`.view-switch-item`は同じmixinを使うため、既存の`.button`・`.compact`も同じ値になる。

| size | 高さ（min-height） | 左右padding | 文字 |
| --- | --- | --- | --- |
| `md` | 3rem | `--space-md`（1.25rem） | 1rem |
| `sm` | 2.4rem | .9rem | `--text-note`（.9rem） |

入力（`.input`・`.select`）も同じ`control-size`を使い、`TextArea`は`--control-md-padding-x`・`--control-md-font-size`と`--field-padding-y`・`--field-line-height`を使う。入力の枠・角丸・label内の間隔・エラー・無効・読取専用の表示は`_tokens.scss`の`--field-*`（`--field-gap`・`--field-radius`・`--field-border-color`・`--field-invalid-color`・`--field-disabled-background`・`--field-readonly-background`）と、ボタンと共通の`--control-disabled-opacity`で定める。Featureのstyleは入力・ボタンのsizeを上書きせず、字体（例: tokenの等幅表示）や配置だけを指定する。

部品間のgap・折返し・一覧との余白は親layoutが持つ。フォームでは`.form-section`（grid・gap `--space-md`）・`.grant-form`（grid・gap `--space-md`）・`.criterion-row`等のgapが欄の上下の間隔を持ち、`Field`・入力部品は外側余白を持たない。一覧の上の操作列は`.list-toolbar`（flex・折返し・`align-items: center`・gap `--space-sm`・下余白`--space-lg`）を使い、列内の部品は同じ`size`を指定する。切替だけを置く一覧でも、下余白は`.list-toolbar`が持つ。

## 構造検査（`npm run check:ui`）

rootの`npm run check:ui`は`server`の同名scriptへ委譲し、検査自体をfixtureで確かめたうえで実際の`server/src/web`を検査する。

- 依存方向（web全体の`.ts`・`.tsx`）: 共通層からFeature・app、Featureからappへの依存がない。他Featureへは`features/<機能>/index.ts(x)`・`model.ts`の公開入口だけを使う。Feature内から自身の`index`を経由しない。`model.ts`から`.tsx`へ推移的に辿れない。公開入口を経由したものを含め、Feature間の依存が循環しない（循環の各辺のimportを示す）。`import`・`export ... from`（型だけを含む）・文字列の`import()`・`require()`・`import("x")`型を、TypeScriptのbundler解決とweb tsconfigの`paths`で実際のfileへ解決して判定するため、alias・再exportの経由も検出する。web内で解決できないlocal importと文字列でない`import()`は失敗にする。app・Feature・共通層のいずれかのsourceが無い（空走査）と失敗する。
- `components/ui`: Feature・app等への依存がない。
- web全体（`components/ui`を除く`.tsx`）: nativeの`<input>`・`<textarea>`・`<select>`を使わず、入力部品（`TextInput`・`TextArea`・`Select`・`Checkbox`）を使う。例外は`<input type="hidden">`だけ（表示・操作を持たず、ログインのform POSTで`returnTo`・招待tokenを運ぶため）。基本部品（`Button`・`LinkButton`・`ViewSwitch`・`Field`・入力部品）へ`className`・`style`を渡さない。
- 保護対象の範囲: `<button>`と、基本部品のclass（`button`・`secondary-button`・`text-button`・`compact`・`view-switch`・`view-switch-item`・`list-switch`・`field`・`input`・`textarea`・`select`・`checkbox`）を直接付けた要素がない。`.list-toolbar`内に`a`・`Link`・`NavLink`・`button`を直接置かず、部品はすべて同じ`size`を文字列で指定する。保護対象のfile・componentが見つからなければ失敗する。
- SCSS: `control-size`の全宣言（補間`#{$size}`を含む）の値が`0`か`--control-*`トークンだけで、`min-height`・`padding`・`font-size`を定め、md・smのトークンが定義されている。`.view-switch`・`.view-switch-item`と`.list-toolbar`内のbutton類に外側余白・固定sizeを足さない。`.field`・`.input`・`.textarea`・`.select`・`.checkbox`・`.text-button`に外側余白を持たせない。`.input`・`.textarea`・`.select`・`.text-button`・`.button`・`.secondary-button`のsize（`min-height`・`height`・`padding`・`font-size`・`line-height`・`border-width`）は、どのselectorからも`0`か`--control-*`・`--field-*`トークンだけで指定する。廃止した`.list-switch`を使わない。

保護対象（段階適用の範囲）は`uiProtectedScopes`で定める。

| 対象 | 範囲 |
| --- | --- |
| `features/project/ProjectListPage.tsx` | file全体（参加中のProjectと`ProjectListSwitch`） |
| `features/workspace/WorkspacePages.tsx` | `ProjectsContent`（WorkspaceのProject一覧） |
| `features/execution/ExecutionSection.tsx` | `TaskFilterSwitch`（Taskの絞り込み） |
| `components/ListInputs.tsx`・`components/ReasonPanel.tsx` | file全体（可変行の入力、危険操作の確認・理由） |
| `features/project/ProjectForm.tsx`・`features/intent/IntentForm.tsx`・`features/outcome/OutcomeForm.tsx` | file全体（作成・編集フォーム） |
| `features/workspace/WorkspaceFormPages.tsx` | `WorkspaceForm` |
| `features/execution/ExecutionItemFormPages.tsx`・`features/execution/TaskDetailPage.tsx` | `ExecutionItemForm`（Story・Task）、`CommentForm` |
| `features/auth/LoginPage.tsx` | `LoginForms` |
| `features/credential/CredentialSection.tsx`・`features/member/MembershipSection.tsx`・`features/member/WorkspaceMembershipSection.tsx`・`features/grant/GrantSection.tsx`・`features/grant/GrantRow.tsx` | file全体（発行・招待・Role・割当と一度だけのtoken・リンク表示） |
| `features/activity/ActivitySection.tsx` | `ActivityTypeFilter`（種別の絞り込み） |

他Featureの内部fileへの依存に例外は設けない。

viteの`resolve.alias`（現在は未使用）、SCSSの依存、実行時に組み立てる依存は機械的に検査しない。

上記以外の画面にある`<button>`・`className="button"`等の既存実装（ナビゲーション・操作パネル等）は検査対象外で、未移行である。入力のnative要素はweb全体で検査する。画面を基本部品へ移すときに、その範囲を`uiProtectedScopes`へ加える。検査は字句から読める`className`と文字列の`size`を対象とし、実際の描画寸法・見た目は実ブラウザで確認する。
