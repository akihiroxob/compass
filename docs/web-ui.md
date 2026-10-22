# Web UIの構成

`server/src/web`のReact UIの配置・共通部品・構造検査の現行の対応付け。共通の方針は配信Skillの`principles/frontend-architecture.md`・`tips/frontend-quality-gates.md`に従い、このProjectの実際のpathと検査範囲をここに定める。

## 配置と依存

| 責務 | 配置 |
| --- | --- |
| app（起動・routing・画面合成） | `main.tsx` |
| features（機能固有のUI・hook・API・型） | `features/<機能>/`。他Featureは`index.ts`の公開入口から使う |
| 共通UI（機能に依存しない基本部品） | `components/ui/`。公開入口は`components/ui/index.ts` |
| 共通の組合せUI | `components/`（Shell・StateCard等） |
| style・トークン | `styles/`（`_tokens.scss` → `_base` → `_layout` → `_components` → `_features`） |
| 検査 | `npm run check:ui`（`server/tests/uiStructure.test.ts`・`server/tests/support/uiStructure.ts`） |

`components/ui`は`react`・`react-router-dom`と同じディレクトリ内だけに依存し、Feature・app・API・業務概念を参照しない。

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

- `components/ui`: Feature・app等への依存がない。
- 保護対象の範囲: `<button>`、基本部品のclass（`button`・`secondary-button`・`compact`・`view-switch`・`view-switch-item`・`list-switch`）を直接付けた要素、基本部品への`className`・`style`がない。`.list-toolbar`内に`a`・`Link`・`NavLink`・`button`を直接置かず、部品はすべて同じ`size`を文字列で指定する。保護対象のfile・componentが見つからなければ失敗する。
- SCSS: `control-size`がmd・smの`--control-*`トークンだけを使う。`.view-switch`・`.view-switch-item`と`.list-toolbar`内のbutton類に外側余白・固定sizeを足さない。廃止した`.list-switch`を使わない。

保護対象（段階適用の範囲）は`uiProtectedScopes`で定める。

| 対象 | 範囲 |
| --- | --- |
| `features/project/ProjectListPage.tsx` | file全体（参加中のProjectと`ProjectListSwitch`） |
| `features/workspace/WorkspacePages.tsx` | `ProjectsContent`（WorkspaceのProject一覧） |
| `features/execution/ExecutionSection.tsx` | `TaskFilterSwitch`（Taskの絞り込み） |

上記以外の画面にある`<button>`・`className="button"`等の既存実装は検査対象外で、未移行である。画面を基本部品へ移すときに、その範囲を`uiProtectedScopes`へ加える。検査は字句から読める`className`と文字列の`size`を対象とし、実際の描画寸法・見た目は実ブラウザで確認する。
