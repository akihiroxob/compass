# Web UIの構成

`server/src/web`のReact UIの配置・共通部品・構造検査の現行の対応付け。共通の方針は配信Skillの`principles/frontend-architecture.md`・`tips/frontend-quality-gates.md`に従い、このProjectの実際のpathと検査範囲をここに定める。

## 配置と依存

| 責務 | 配置 |
| --- | --- |
| app（起動・routing・Provider・画面合成） | `app/`。`main.tsx`（起動・`BrowserRouter`）、`App.tsx`（routing）、`AppLayout.tsx`（route layout・Provider・Shellの合成）、`NotFoundPage.tsx`（未定義のURL） |
| features（機能固有のUI・hook・API・型・validation） | `features/<機能>/`。他Featureは公開入口（`index.ts`・`model.ts`）から使う |
| 共通UI（機能に依存しない基本部品） | `components/ui/`。公開入口は`components/ui/index.ts` |
| 共通の組合せUI | `components/`（Shell・StateCard・FormErrorSummary・ListInputs・ReasonPanel（`ConfirmPanel`・`ReasonPanel`）） |
| 共通処理 | `web`直下の`.ts`（`api.ts`の汎用transport・エラー分類・部分取得`settle`、`paths.ts`の画面URL・Web API path、`statusTone.ts`、`useHashTarget.ts`） |
| style | 入口`app/main.scss`。共有は`styles/`、部品・組合せUI・app・Featureのstyleはそれぞれのdirectoryのpartial（[style](#style)） |
| 検査 | `npm run check:ui`（`server/tests/uiStructure.test.ts`・`server/tests/support/uiStructure.ts`） |

依存はapp → Feature → 共通層（`components/`・`web`直下）の向きだけにする。共通層は業務の型・判定を持たず、共通UIは自身のpropsの形だけを定義する（例: `ListInputs`のリンク行）。appは各Featureの公開入口と共通層を使ってよい。FeatureはappとShellの枠に依存せず、共通層はFeature・appに依存しない。`components/ui`は`react`・`react-router-dom`と同じディレクトリ内だけに依存し、Feature・app・API・業務概念を参照しない。

## 入口・Provider・layout

| 責務 | 所有 | 内容 |
| --- | --- | --- |
| 起動 | `app/main.tsx` | `index.html`の入口。`StrictMode`・`BrowserRouter`・全体のstyle（`app/main.scss`）を読み、`App`を描画する |
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
| `consultation` | Project相談の型・Web API path・表示の判定（`consultation.ts`）、Project詳細の「判断待ち」（`ConsultationSection.tsx`）と相談詳細（`ConsultationDetailPage.tsx`） |
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
| `Fieldset` | `<fieldset>`の標準属性とref（`className`・`style`を除く）、`legend`・`required`（`true`で「必須」、文字列でその文言）・`children`（複数の入力部品） | `<fieldset class="fieldset">`と`<legend>`。`Field`と同じ必須表示 |

URLで表す遷移と表示切替はリンクのままにし、新しいタブ・戻る・再読込でも同じ表示になる。部品は外側余白・幅・配置を持たないため、`className`・`style`を受け取らない。

共通の組合せUIのうち、状態の表示と確認は次を使う。

| 部品 | 用途 |
| --- | --- |
| `StateCard`（`components/StateCard`） | 読込・失敗・空・案内の枠。`tone="error"`、`role`（`alert`・`status`）・`id`・`tabIndex`・refを受け、`className`・`style`は受けない。`Loading`・`ErrorState`はこれを使う |
| `ConfirmPanel`（`components/ReasonPanel`） | 操作の確定前の確認パネル（見出し・説明・入力・失敗・やめる/確定）。`danger`で確定ボタンを危険操作の色に、`focusHeading`で見出しへfocusを移す。Credentialのrotation等の入力つき確認 |
| `ReasonPanel`（`components/ReasonPanel`） | `ConfirmPanel`に理由欄と`useReasonAction`の状態をつないだ、取消・放棄・アーカイブ等の確認 |

### 操作の部品の選び方

| 操作 | 使うもの |
| --- | --- |
| 画面を変えない操作（再読込・さらに読む・開閉・確定・取消） | `Button`。開閉は`aria-expanded`を付ける。送信中・読込中は`pending` |
| 画面へ移るボタンの見た目の導線（作成・編集・ホームへ・別タブでログイン） | `LinkButton`（`target="_blank"`等の`Link`のpropsを渡せる） |
| 一覧の表示の切替（status・絞り込み） | `ViewSwitch` |
| 本文・一覧・カードの中のリンク、戻る・パンくず | 通常の`Link`（`text-link`・`back-link`・`breadcrumb`・カードのclass）。ボタンにしない |
| 画面の間のナビゲーション（Workspaceのナビゲーション・Project詳細のview） | `nav`内の`Link`と`nav-link` mixin。`aria-current="page"`で現在地を示す。表示切替の部品にしない |
| 開閉する詳細（Role定義・過去のIntent等） | `details`・`summary` |

`<button>`の個別の例外は、Workspaceの切替のdialogを開くカード（`features/workspace/WorkspaceSwitcher.tsx`の`workspace-switch`）だけとする。現在のWorkspaceの名前を示すWorkspace固有の表示で、操作ボタンのsize契約を持たないため。

### フォームの組立て

- 入力の欄は`Field`で入力部品を包む。`Field`の`required`は表示だけのため、検証する入力部品にも`required`を指定する。
- 送信の検証エラーは`components/FormErrorSummary`が持つ。入力部品へ`fieldProps(invalid, id)`を渡すと、`id`と、検証に失敗した欄の`aria-invalid="true"`・要約（`#form-error-summary`）への`aria-describedby`が付き、要約のリンクから欄へ移れる。同じ画面に複数フォームを出す設定画面（Member・Grant・Credential）では、フォームごとに`useId()`を生成し、`fieldProps(invalid, id, formId)`と`<FormErrorSummary formId={formId}>`へ同じ値を渡す。入力・要約・リンク・ARIA参照を同じprefixで分離し、APIの論理field IDは変更しない。省略形は単一フォームの画面に限る。
- 送信ボタンは`<Button type="submit" pending={送信中}>`とし、送信中の文言は利用側が切り替える。保存の失敗時も入力stateを保持し、そのまま再送信できるようにする。
- 複数のcheckbox等の組は`Fieldset`、可変行の入力は`components/ListInputs`（`TextListInput`・`LinkListInput`）、危険操作の確認・理由は`ReasonPanel`、入力つきの確認は`ConfirmPanel`を使う。いずれも内部で基本部品を使う。
- 入力の検証・保存・認可はFeatureが持ち、基本部品は持たない。

## size契約

`size`は`md`（既定）・`sm`。値は`_tokens.scss`の`--control-{md|sm}-height`・`--control-{md|sm}-padding-x`・`--control-{md|sm}-font-size`と共通の`--control-border-width`・`--control-line-height`で定め、`_mixins.scss`の`control-size($size)`だけが適用する。`.button`・`.secondary-button`・`.view-switch-item`は同じmixin（形は`control-shape`。角丸`--control-radius`）を使うため、トークンを変えるとButton・LinkButton・ViewSwitchの同じsizeへ反映される。

| size | 高さ（min-height） | 左右padding | 文字 |
| --- | --- | --- | --- |
| `md` | 2.5rem（40px） | 1rem | .875rem（14px） |
| `sm` | 2rem（32px） | .75rem | .8125rem（13px） |

入力（`.input`・`.select`）も同じ`control-size`を使い、`TextArea`は`--control-md-padding-x`・`--control-md-font-size`と`--field-padding-y`・`--field-line-height`を使う。入力の枠・角丸・label内の間隔・エラー・無効・読取専用の表示は`_tokens.scss`の`--field-*`（`--field-gap`・`--field-radius`・`--field-border-color`・`--field-hover-border-color`・`--field-invalid-color`・`--field-disabled-background`・`--field-readonly-background`）と、ボタンと共通の`--control-disabled-opacity`で定める。Featureのstyleは部品の見た目・sizeを上書きせず、配置（幅・flex・grid）と字体（例: tokenの等幅表示）だけを指定する。

部品間のgap・折返し・一覧との余白は親layoutが持つ。フォームでは`.form-section`（grid・gap `--space-md`）・`.grant-form`（grid・gap `--space-md`）・`.criterion-row`・`.fieldset`等のgapが欄の上下の間隔を持ち、`Field`・入力部品は外側余白を持たない。一覧の上の操作列は`.list-toolbar`（flex・折返し・`align-items: center`・gap `--space-sm`・下余白`--space-lg`）を使い、列内の部品は同じ`size`を指定する。切替だけを置く一覧でも、下余白は`.list-toolbar`が持つ。送信の失敗の要約（`FormErrorSummary`）と作成・編集フォーム（`.project-form`）の間は`.state-card + .project-form`が持つ。`.detail-section`の字下げ（`padding-left`）はclassの無い本文の箇条書きにだけ付け、classを持つ一覧（`.outcome-list`・`.grant-list`等の行カード）は自身の余白で区画の見出しと左端を揃える。

## 視覚方針

白と青灰色の面に、青藍（ブランド）を現在地・主要操作・リンクだけに使う。サンセリフの太さ・大きさと面・罫線で階層を表し、太い囲みや大きな余白を一律に使わない。値の正本は`styles/_tokens.scss`で、製品とUIカタログは同じtoken・部品・SCSSを読む。参照は[ムードボード](design/compass-moodboard-blue.png)の配色・文字・部品の密度で、画像内の架空データ・進捗率・Agent表示・ダッシュボード配置は採用しない。

| 対象 | 採用した判断 | token |
| --- | --- | --- |
| 面 | ページは青灰色、区画・カード・入力は白、注記・読取専用は淡い青灰色 | `--color-paper` #f5f7fa・`--color-surface`/`--color-raised` #fff・`--color-note` #eef2f6 |
| 文字 | 本文は濃い青墨、補助・注記は青灰色の2段 | `--color-text` #1d2935・`--color-text-secondary` #44515e・`--color-text-muted` #56636f |
| 罫線 | 区画は淡い罫線、入力・表示切替の枠は3:1以上の濃さ | `--color-line` #dce3ea・`--color-line-input` #7a8794 |
| ブランド | 主要操作（Button primary）、選択中のnav・ViewSwitch、リンク・eyebrow、焦点表示。hoverは濃色、淡い強調は補助操作・navのhover | `--color-brand` #285a78・`--color-brand-strong` #1f4a63・`--color-brand-soft` #e7eff5 |
| 状態 | ブランドと別の色相。失敗・危険操作は赤、要対応は橙、警告は黄、完了は緑、進行中は淡い青。必ずラベル文字を併記し、エラーの入力は枠の色に加えて内側の線と要約（`role="alert"`）で示す | `--color-danger*`・`--tone-*` |
| 文字 | 外部フォントを配信しない。OS標準のサンセリフ（system-ui、和文はヒラギノ角ゴ・Noto Sans JP・Yu Gothic UI・メイリオ）へフォールバックし、セリフ体は使わない | `--font-sans` |
| 文字の階層 | h1 32px/44・h2 20px・h3 16px（700）、本文14px/1.6、注記13px、ラベル12px（大文字・字間.08em） | `--text-h1`〜`--text-label`・`--line-height-*` |
| 余白・密度 | 4px基準の`--space-*`（4/8/12/16/24/36px）。区画のpaddingは24px、本文上端は36〜48px | `--space-*` |
| 角丸 | 操作・入力は6px、行カード6〜8px、区画10px、カード12px。pillは状態badgeだけ | `--control-radius`・`--radius-*` |

操作部品の状態は次のとおり。disabledは`--control-disabled-opacity`で薄くし、hoverを変化させない。pendingは`Button`だけが持ち、disabledと`aria-busy="true"`・`cursor: progress`、文言は利用側が切り替える。focusはすべての操作・入力で`--focus-ring`（3px・offset 2px）の実線を出す。

| 部品 | default | hover | 選択中・error |
| --- | --- | --- | --- |
| Button primary / LinkButton primary | ブランドの面・白文字 | `--color-brand-strong` | — |
| Button secondary / LinkButton secondary | 白地・ブランドの枠と文字 | `--color-brand-soft` | — |
| Button `tone="danger"` | primaryは赤の面、secondaryは赤文字・淡い赤の枠 | 濃い赤 / `--color-danger-soft` | — |
| Button text | ブランドの文字 | 下線 | — |
| ViewSwitch | 白地・入力と同じ枠・補助文字 | `--color-brand-soft` | `aria-current="page"`でブランドの面・白文字 |
| TextInput / Select / TextArea | 白地・`--field-border-color` | 枠を`--field-hover-border-color`へ | `aria-invalid="true"`で赤の枠＋内側線。読取専用は淡い青灰色 |

文字・背景・枠・焦点表示のコントラストは`server/tests/uiTokens.test.ts`（`npm run check:ui`）が`_tokens.scss`の値から測定し、文字はWCAG AA 4.5:1、入力の枠・焦点表示等の非テキストは3:1を下回ると失敗する。測定値は実行時のdiagnosticに出る（例: 本文13.77:1、muted 5.47〜6.15:1、ブランド文字6.39〜7.43:1、主要ボタンの白文字7.43:1、入力の枠3.26〜3.67:1、焦点表示6.39〜7.43:1、状態badge 5.42〜7.41:1）。

## style

Sassの入口は`app/main.scss`（`app/main.tsx`が読む）で、共有 → 部品 → 組合せUI → app → Featureの順に`@use`する。各partialは自分の所有するclassだけを定義し、命名は既存のclass名を保つ。

| 所有者 | partial | 置くもの |
| --- | --- | --- |
| 共有 | `styles/_tokens.scss`・`_mixins.scss` | CSS変数のトークン（`:root`）・breakpoint、mixin（`control-size`・`control-shape`・`heading`・`nav-link`・`list-link`等） |
| 共有 | `styles/_base.scss` | reset・要素の既定値（`main`の幅、`fieldset`、焦点表示、`details`の開閉、reduced-motion）。要素へのselectorはここだけ |
| 共有 | `styles/_layout.scss` | 複数のFeature・appが使うlayout・区画・操作列（`.action-row`・`.list-toolbar`・`.form-actions`）・一覧・カード・文字の型・状態badge |
| 基本部品 | `components/ui/_button.scss`・`_view-switch.scss`・`_field.scss` | Button・LinkButton・ViewSwitch・Field・Fieldset・入力部品の内側の見た目と状態 |
| 組合せUI | `components/_shell.scss`・`_state-card.scss`・`_reason-panel.scss`・`_list-inputs.scss` | Shell・StateCard・ConfirmPanel・ListInputsの見た目 |
| app | `app/_app.scss` | 未定義のURLの画面、sidebarの参加中のProjectへのリンク |
| Feature | `features/<機能>/_<機能>.scss` | そのFeatureだけが使うclass（Shellのslotに置くSession・Workspaceの切替/ナビゲーションの見た目を含む） |

1つのFeatureだけが使うclassはそのFeatureのpartialへ、2つ以上のFeature・appが使うclassは`styles/_layout.scss`へ置く。利用側の文脈による調整（例: `.app-sidebar .session-menu`）は、調整されるclassを所有するpartialに書く。

## 構造検査（`npm run check:ui`）

rootの`npm run check:ui`は`server`の同名scriptへ委譲し、検査自体をfixtureで確かめたうえで実際の`server/src/web`全体を検査する。`server`の`npm run lint`（rootの`lint`）は型チェックの後に`check:ui`を実行し、`npm test`も同じ検査を含むため、通常の完了前検証で実行される。

- 依存方向（web全体の`.ts`・`.tsx`）: 共通層からFeature・app、Featureからappへの依存がない。他Featureへは`features/<機能>/index.ts(x)`・`model.ts`の公開入口だけを使う。Feature内から自身の`index`を経由しない。`model.ts`から`.tsx`へ推移的に辿れない。公開入口を経由したものを含め、Feature間の依存が循環しない（循環の各辺のimportを示す）。`import`・`export ... from`（型だけを含む）・文字列の`import()`・`require()`・`import("x")`型を、TypeScriptのbundler解決とweb tsconfigの`paths`で実際のfileへ解決して判定するため、alias・再exportの経由も検出する。web内で解決できないlocal importと文字列でない`import()`は失敗にする。app・Feature・共通層のいずれかのsourceが無い（空走査）と失敗する。
- `components/ui`: Feature・app等への依存がない。
- コントラスト（`tests/uiTokens.test.ts`）: [視覚方針](#視覚方針)の色の組合せがWCAG AAの基準を満たし、ブランド色と状態色が別の値である。
- 操作・入力（`components/ui`を除くweb全体の`.tsx`）: nativeの`<button>`・`<input>`・`<textarea>`・`<select>`を使わない。例外は`<input type="hidden">`（ログインのform POSTで`returnTo`・招待tokenを運ぶ）と、上記の`<button className="workspace-switch">`だけで、例外の対象が見つからなければ失敗する。基本部品へ`className`・`style`を渡さない。`.list-toolbar`内に`a`・`Link`・`NavLink`・`button`を直接置かず、部品はすべて同じ`size`を文字列で指定する。
- size契約（SCSS）: `control-size`の全宣言（補間`#{$size}`を含む）の値が`0`か`--control-*`トークンだけで、`min-height`・`padding`・`font-size`を定め、md・smのトークンが定義されている。表示切替・入力・文字だけのボタンの部品と`.list-toolbar`内のbutton類に外側余白を持たせない。`.input`・`.textarea`・`.select`・`.text-button`・`.button`・`.secondary-button`のsizeは、どのselectorからも`0`か`--control-*`・`--field-*`トークンだけで指定する。`.list-switch`のselectorを使わない（表示切替は`ViewSwitch`）。
- classの所有（SCSSとTSX）: 入れ子と`&`を展開したselectorが定義するclassごとに、定義するpartialは1つだけ。部品・組合せUIのclassへ所有partialの外から指定できるのは配置（幅・flex・grid・字体。組合せUIには外側余白も）だけ。`styles/_base.scss`・`_tokens.scss`以外の最上位のselectorはclassから始める。部品・組合せUI・app・Featureのpartialのclassはその所有者のsource（`className`と、class名を組み立てる式の文字列。attributeに渡したslotのJSXを含む）だけが使い、`styles/`の共有classは2つ以上の所有者が使う。どこからも使わないclassを残さない。
- Sassの入口: `app/main.scss`をcompileし、web内の全partialが入口から読まれている。出力CSSで、同じ@規則の中の同じselectorの同じpropertyを別のruleで宣言しない（partialの二重出力・後のruleによる打消し）。

他Featureの内部fileへの依存と、SCSSのclassの所有に例外は設けない。

### 機械的に保証しない範囲と手動レビュー

| 範囲 | 理由 | 確認方法 |
| --- | --- | --- |
| viteの`resolve.alias`（現在は未使用）・実行時に組み立てる依存 | TypeScriptの解決で読めない | alias・文字列でない`import()`を追加する変更で、依存先をレビューする（文字列でない`import()`は検査で失敗する） |
| SCSSの`@use`の依存方向・計算で組み立てるclass名 | class名は字句から読める文字列だけを対象にする | partialの`@use`は`styles/`の共有だけにする。`className`へ渡す値を組み立てる関数は、文字列リテラルで全候補を書く |
| ボタン風のリンク | 独自のclassで`Link`・`a`をボタンに見せると、部品のclassを使わない限り検出できない | 操作の見た目の`Link`は`LinkButton`を使う。カード・一覧のリンクのclassをボタンの見た目にしていないかを差分で確認する |
| `nav`・`details`等の意味の選択 | 遷移・ナビゲーション・開閉の区別は要件による | 上記の「操作の部品の選び方」に照らしてレビューする |
| 実際の描画寸法・折返し・見た目 | 検査は字句から読める`className`・文字列の`size`・SCSSの宣言を対象とする | 実ブラウザでDesktop（1280px）・狭い画面（390px）の画像と寸法を確認する（[ブラウザ検証](browser-verification.md)。代表的な経路と確認項目は[UI構成の統合検証](implementation-status.md#ui構成の統合検証)） |


## UIカタログ

[UIカタログ](ui-catalog.md)で製品の実部品・同じ`app/main.scss`・現行tokenを確認できる。`npm run catalog:dev`・`npm run catalog:build`をRepository rootで実行する。基本部品は`components/ui`近傍のstoryから同じ公開入口を使い、組合せとtokenも近傍のstoryに置く。previewは`MemoryRouter`だけを供給し、実運用サービスを使わない。

`check:ui`はstoryを含む全sourceを検査する。`components/ui/*.stories.tsx`のStorybook型importだけを限定的に許可し、storyのnative基本部品・基本部品のstyle上書き・操作列sizeも検査する。製品からstoryへの依存は禁止する。部品・SCSSの例外を増やすためにstoryを使わない。
