# Managerのブラウザ検証データ

Managerの専用プレビューは、`.ralph/config.json`の`verification.browser.setupCommands`で、`npm ci --ignore-scripts`・`npm rebuild better-sqlite3`・`scripts/prepare-browser-verification.mjs`の順に実行してから起動する。準備コマンドはホスト側で、検証対象Worktreeをcwdとして動く。依存関係もそのWorktree内へインストールし、親Repositoryのworkspace参照を使わない。

## 準備する状態

| シナリオ | データ |
| --- | --- |
| Targetなし | Workspace・Active Intent・Outcome。Target Projectなし |
| 一部未着手 | Target Project A/B。Aにはaccepted Taskを持つStoryとExecution Evidence、BにはStoryなし |
| 評価と判断 | 両Targetのaccepted WorkとEvidence、成功条件ごとのEvaluation、Research Result/Finding/Synthesis、関連するDirection Decision |

Ownerは`preview-owner@example.test`、Viewerは`preview-viewer@example.test`で開発用ログインする。Viewerは後二者のWorkspaceとProject Aのviewerで、Project Bには所属しない。Workspace Directionの参照、Project AのWork参照、Bの参照拒否、編集操作の拒否を比較できる。

## 対象SHAとの一致

スクリプトはcwdのschemaとapplication use caseを読み込み、同じWorktree内の`@compass/*`を使う。依存関係が親Repositoryを参照している場合は失敗するため、対象Worktreeで`npm ci`等を済ませる。

設定内のスクリプトパスは、検証準備を管理するProject checkoutの絶対パスにする。配置先を変える場合はこのパスも更新する。準備コードが対象SHAに含まれていなくても、対象側の実装からデータを作成できる。対象のuse caseが未実装・非互換なら準備は失敗し、別SHAのデータへ切り替えない。

`dataDirectory/browser-fixtures.json`に、対象`headSha`・準備スクリプトのSHA-256・Workspace/Project/Outcome等のID・画面パス・ログイン方法を保存する。Managerはプレビューの`headSha`と一致することを確認し、manifestのパスをプレビューURLへ連結して確認する。準備ログにもmanifestの絶対パスが出力される。

## 実行範囲

- `trusted-local`、`example.test`のOwner、専用ディレクトリの新規`preview.db`だけを許可する。既存DBは上書きしない。準備失敗時はログを確認し、新しい専用ディレクトリで再実行する。
- 準備時のDB操作はProjectで定義したこのコマンドに集約する。Managerが検証対象のソースや運用DBを変更して状態を作らない。
- 内部use caseでの準備は、管理用公開APIのACを満たした証拠にはしない。Evidence・判定・Researchは画面表示のための合成データであり、実成果や実Agentの自律運転の証明には使わない。
- 各ACに必要な状態がmanifestにない場合は、そのACの検証データを追加して検証する。データの作成成功だけでAcceptしない。

## 手動実行

検証対象Worktreeをcwdにし、新規の専用ディレクトリを用意する。

```sh
PREVIEW_DATA=$(mktemp -d)
COMPASS_DB_PATH="$PREVIEW_DATA/preview.db" \
COMPASS_AUTH_MODE=trusted-local \
COMPASS_INITIAL_OWNER_EMAIL=preview-owner@example.test \
node --import tsx /Users/aokayama/git/compass/scripts/prepare-browser-verification.mjs \
  --data-dir "$PREVIEW_DATA"
```

サーバーも同じDB・認証設定で起動する。Ralphでは専用DBの作成・起動・停止はプレビュー機構が管理する。
