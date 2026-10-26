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

## Managerによる検証データ追加の許可

Managerは、Ralphが今回返した専用プレビューURL・対象SHA・専用DBを確認したうえで、その環境の公開Web API・MCPを使って検証用データを追加・変更してよい。この許可はプレビューの中だけに適用する。実行中のWacha Task・Claim、開発サーバー、運用DB、GitHub、検証対象コード、Ralphの設定・実行記録は対象外とする。

初期データでACの状態が足りない場合は、すぐにblockedにせず、manifestの`dataPreparation`を読み、許可された操作で状態を作って検証する。

- 接続先は`start_browser_preview`が返したURLのoriginにある`/mcp`。普段利用するWacha MCPへ検証データを作らない。
- 利用主体はmanifestの`actors`に記載した`preview-manager`・`preview-worker`・`preview-reviewer`。`trusted-local`の専用環境だけで、`Authorization: Bearer <preview actor>`と`X-Compass-Active-Role`を指定する。これは検証用Principalであり、実行中のAgentへRoleを追加するものではない。
- Workの準備はmanifestの`projectIds`内だけに限定する。`allowedTools`に記載したStory/Taskの作成・参照、Claim取得/更新/解放、コメント・完了・レビュー・受入を許可する。操作したID・requestId・結果を証跡へ残す。Task/Claimへの操作はそこで作成した検証用Entityだけを対象とする。
- 相談の作成・参照・応答lease・返信・結論・取消と、Taskの`wait_for_consultation`・`list_consultation_resumptions`・`resume_consultation_task`・`confirm_consultation_continuation`は、manifestで公開されている操作を検証用Projectと検証用Entityに限って使用できる。Manager/Worker/Reviewerはmanifestの対応主体とactiveRoleを使い、取消後の継続確認・結論の保存はManagerが行う。既存の認可・lease・版・自己レビュー禁止を迂回しない。
- 許可一覧は対象SHAの`tools/list`と照合して生成する。`consultationResumptionEnabled`がfalseなら、そのSHAには待機/再開の公開契約が揃っていない。別SHAのtoolやDB操作で補わない。
- 待機・再開で必要な成果物とContextは、専用検証ディレクトリ内に対象SHAの別Git checkoutを作り、そこで保持する。そのSHAの`ralph/runtime/consultation-context.mjs`でHEAD・差分・Contextのfingerprintを取得する。実際の受入TaskのWorktree・Context・Claimを検証用に流用しない。
- ログイン・Membership等の準備は専用プレビューのOwnerによるWeb UI・認証済みWeb APIで行う。権限差の検証時はOwnerで準備した後にViewer等へ切り替える。
- SQL直接実行、schemaの変更、API応答や時刻の差し替え、Claim期限のDB直接更新、未登録のホストコマンド実行は許可しない。公開操作で作れない状態は不足する入口と必要な追加準備を具体的に示す。

### 期限内Claimと期限切れの確認

1. manifestからProject A/Bと既存Outcomeを選ぶ。検証用Storyを`issue_story`、そのTaskを`issue_task`で作成する。Outcomeに結びつける場合は`outcomeId`とTaskの`taskKey`も指定する。
2. `preview-worker`で`claim_task`を実行する。取得したTask/Claim IDと`expiresAt`を記録する。別Projectにも検証用Task・Claimを用意し、自Projectの表示と混同されないことを確認できる。
3. OwnerでProject OverviewとTask詳細を実際に開き、保持者・状態・Task導線をDesktopと狭い画面で確認する。有効期間が足りなければ同じ検証用Claimを`renew_claim`で更新する。
4. 専用プレビューでは`COMPASS_CLAIM_TTL_MS=60000`を設定している。期限切れ確認では更新を止め、APIが返した`expiresAt`を過ぎてから表示・再読込・再取得を確認する。`release_claim`による解放を期限切れの代用にしない。実環境の有効期間は変更しない。

Playwrightのページ内から呼ぶ場合は、現在のoriginが返された専用URLと一致することを最初に検査する。例えば`tools/call`は次のHTTP形式で送る。toolの入力は対象SHAの`tools/list`で確認する。

```js
// previewUrlはstart_browser_previewの戻り値。実行ContextのWacha URLは渡さない。
const origin = new URL(previewUrl).origin;
if (location.origin !== origin) throw new Error('Dedicated preview origin mismatch');
const response = await fetch(new URL('/mcp', origin), {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: 'Bearer preview-worker',
    'X-Compass-Active-Role': 'worker',
  },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
    name: 'claim_task', arguments: { taskId: createdPreviewTaskId, requestId: crypto.randomUUID() },
  } }),
});
const raw = await response.text();
// SSEならid:1のdata行をJSONとして読む。result.isErrorとstructuredContentも確認する。
```

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
