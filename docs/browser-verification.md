# Managerのブラウザ検証データ

Managerの専用プレビューは、`.ralph/config.json`の`verification.browser.setupCommands`で、`npm ci --ignore-scripts`・`npm rebuild better-sqlite3`・`scripts/prepare-browser-verification.mjs`の順に実行してから起動する。準備コマンドはホスト側で、検証対象Worktreeをcwdとして動く。依存関係もそのWorktree内へインストールし、親Repositoryのworkspace参照を使わない。

## 準備する状態

| シナリオ | データ |
| --- | --- |
| Targetなし | Workspace・Active Intent・Outcome。Target Projectなし |
| 一部未着手 | Target Project A/B。Aにはaccepted Taskを持つStoryとExecution Evidence、BにはStoryなし |
| 評価と判断 | 両Targetのaccepted WorkとEvidence、成功条件ごとのEvaluation、Research Result/Finding/Synthesis、関連するDirection Decision |

評価と判断のシナリオには`consultationReflection`として、Project相談とWorkspace相談（Project Aへ引継ぎ）の結論を文書へ反映した状態も準備する。専用ディレクトリ内のbare repository（`verification-docs.git`）とcheckoutを作り、Project Aへ`https://example.test/verification-docs.git`として登録する。`request_consultation_followup`→Workerの`claim_task`と実際の文書commit→通常の`claim_review`・`reviewed_task`→`claim_acceptance`・`accept_task`（`deliverables`にcommitとpath）→`record_consultation_artifact`を公開MCPで通す。manifestの`path`から反映済み表示・再読込・viewerとの権限差の確認へ進める。HumanのRepository登録・返信はOwnerのHuman use caseで行う。これらは検証用Principalの公開操作で、実Agentの稼働を示さない。対象SHAに反映の公開契約が無い場合は`status: unavailable`と`kind`（`tool_unavailable` / `policy_denied`）を記録し、内部操作で補わない。

Ownerは`preview-owner@example.test`、Viewerは`preview-viewer@example.test`で開発用ログインする。Viewerは後二者のWorkspaceとProject Aのviewerで、Project Bには所属しない。Workspace Directionの参照、Project AのWork参照、Bの参照拒否、編集操作の拒否を比較できる。

## 対象SHAとの一致

スクリプトはcwdのschemaとapplication use caseを読み込み、同じWorktree内の`@compass/*`を使う。依存関係が親Repositoryを参照している場合は失敗するため、対象Worktreeで`npm ci`等を済ませる。

設定内のスクリプトパスは、登録済み準備コマンドの識別に使う。Reviewer・Managerの実行では、`verification.preparationFiles`で指定したファイルへの直接の引数を、Ralphが`verification.preparationRevision`（省略時は本体SHA）のGit blobから作成した専用コピーへ置き換える。Workerの実行は登録済みのパスをそのまま使うため、Workerは使用した準備ファイルが`preparationRevision`のblobと一致することを照合して記録する。準備コードの正本はそのGit revisionであり、固定Project checkoutの作業ファイルではない。対象のuse caseが未実装・非互換なら準備は失敗し、別SHAの本体やデータへ切り替えない。

実行時の適用は、`verificationPreparation`と検証記録の本体`headSha`・準備元`sourceSha`・fingerprint/差分、実際の実行コマンドと生成manifestの一致で確認する。専用コピーを使った必要な検証が成功していれば、固定Project checkoutの旧ファイルが未更新であることだけを追加の受入条件にしない。別サービスへの配備が明示的なACなら、その配備の確認は別途行う。

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
- 利用主体はmanifestの`actors`に記載した`preview-manager`・`preview-worker`・`preview-reviewer`・`preview-strategist`・`preview-evaluator`。`trusted-local`の専用環境だけで、`Authorization: Bearer <preview actor>`と`X-Compass-Active-Role`を指定する。これは検証用Principalであり、実行中のAgentへRoleを追加するものではない。
- 許可はmanifestの`operationPolicy`（`kind: scoped-public-operations`）で定める。Tool名の一覧では許可しない。対象は、対象SHAの`tools/list`で`_meta`の`compass/context`が`work`または`collaboration`、`compass/caller`が`agent`に分類された公開操作で、manifestの`actors`がそのactiveRoleで呼ぶものに限る。`projectId`は`projectIds`、`workspaceId`は`workspaceIds`の範囲内とする。Task/Story/Claim/相談等のEntity ID（引数中の`*Id`/`*Ids`。ネストを含み、`requestId`・`correlationId`を除く）は、許可scope内の呼出し結果で観測したIDだけを対象とする。Human入口で作成した成果物（Repository・返信等）は、許可Project/Workspaceを指定して明示的に観測へ登録する。未観測のID、scopeの手掛かりが無い呼出しは対象不明として拒否する。ServerのGrantはmanifestのscopeを強制しないため、この判定を送信前に行う。
- 分類はServerがToolを登録するmoduleで付ける（`server/src/mcp/toolContext.ts`）。Work・Collaborationへ追加された新しいToolは、manifestやこの文書への名前の追記、Humanの再承認なしで同じ範囲に入る。Human管理・Direction・Organization等の未分類Toolと、Runtime Credential専用の`compass/caller: runtime`は範囲外とする。
- Policyは操作を許可するだけで、Grant・Role・Claim・lease・版・自己レビュー/自己受入禁止はServerが強制する。迂回しない。操作したID・requestId・結果を証跡へ残す。
- `observedTools`は準備時の`tools/list`とその分類の観測記録で、許可一覧ではない。呼び出す前に現在の`tools/list`とinput schemaを読み直す。`consultationResumptionEnabled`がfalseなら、そのSHAには待機/再開の公開契約が揃っていない。別SHAのtoolやDB操作で補わない。
- `scripts/preview-operation-policy.mjs`の`createPreviewMcpClient`はこの判定を行い、失敗を区別する。`tool_unavailable`は現在の`tools/list`に無い、`policy_denied`は分類・主体・scopeがPolicy外、`authorization_denied`はServerの認可拒否（`FORBIDDEN`・`UNAUTHENTICATED`、HTTP 401/403）、`operation_failed`は業務規則の拒否、`transport_failure`は通信失敗・不正な応答を表す。Playwrightから直接呼ぶ場合も同じ順で判定する。
- 相談では、Workerの作成・`wait_for_consultation`等の待機/再開、Managerの応答lease・結論・取消・継続確認・文書反映依頼（`request_consultation_followup`）と成果物参照登録（`record_consultation_artifact`）、StrategistのWorkspace相談の結論・引継ぎを、manifestの対応主体とactiveRoleで行う。
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

検証対象Worktreeをcwdにし、新規の専用ディレクトリを用意する。準備ファイルはRalphと同じく`verification.preparationRevision`のGit blobから、Repository内の相対配置を保った専用コピーを作って実行する（manifestの`policyPath`はコピー内の本書を指す）。

```sh
PREVIEW_DATA=$(mktemp -d)
PREPARATION=$(mktemp -d)
REVISION=<verification.preparationRevision>
for file in <verification.preparationFiles>; do
  mkdir -p "$PREPARATION/$(dirname "$file")"
  git show "$REVISION:$file" > "$PREPARATION/$file"
done
COMPASS_DB_PATH="$PREVIEW_DATA/preview.db" \
COMPASS_AUTH_MODE=trusted-local \
COMPASS_INITIAL_OWNER_EMAIL=preview-owner@example.test \
node --import tsx "$PREPARATION/scripts/prepare-browser-verification.mjs" \
  --data-dir "$PREVIEW_DATA"
```

サーバーも同じDB・認証設定で起動する。Ralphでは専用DBの作成・起動・停止はプレビュー機構が管理する。

## 実Agentによる相談応答と自動再開

`verification.hostCommands`の`node --import tsx /Users/aokayama/git/compass/scripts/verify-consultation-resumption.mjs`を`run_host_verification`へそのまま渡す。Reviewer・Managerの実行では、スクリプトは準備ファイルとして`preparationRevision`の専用コピーで実行される。対象WorktreeのHEADを固定し、専用DB・loopbackサーバー・別Git checkout・検証用ProjectのRuntime Credentialだけを使用する。実際の受入実行と運用DB・GitHubを変更しない。

このコマンドは公開操作で相談待ちTaskを作り、Humanの返信を送信して、対象SHAのOrchestratorから実CodexのManagerを1回、対象SHAのRalphから実CodexのWorkerを1回起動する。回答・状態遷移・Claim取得を偽Agentや固定応答で代用しない。各プロセスの実行上限は240秒、Managerのdispatch試行上限は1回。Taskの受入・commit・pushは行わない。

終了時にJSONで`evidencePath`・対象SHA・成功/失敗を出力する。証跡には専用DB、Manager/Workerログ、dispatch記録、保存Context、未commit成果物を保持する。公開`list_tasks`・Claimコメントと成果物を照合して、新Claimでの`in_review`到達・元Contextと成果物の保持を確認する。検証サーバーは終了時に停止する。Agentの認証・利用枠が不足した場合は失敗として記録し、成功とみなさない。

同じSHAの有効な実Agent証跡がある場合は、対象SHA・実行コード・dispatch・新Claim・保存成果物を独立に照合して使用できる。読み取り確認だけを直せばよい場合に実Agentを再起動し直さない。偽Agentによる回帰テストは実Agent稼働の証明として扱わない。

## 参照プロトタイプとの比較

参照プロトタイプは、管理者がRalphのProject設定（`verification.browser.profiles`）へ`prototype` profileを登録した環境でだけ起動できる。このRepositoryの`.ralph/config.json`には登録されていないため、`start_browser_preview`が未登録profileを拒否した場合は比較を未検証として記録し、別の起動方法で代替しない。登録済みなら`start_browser_preview({"profile":"prototype"})`で起動する。想定する参照先は`/Users/aokayama/git/compass-prototype`、localhostに限定したViteの専用portで、製品のDB・MCPは使わない。停止済みの固定URLへ依存せず、返されたURLを使用する。参照コードは編集しない。Repository外の参照資料なので、比較時にファイル内容のdigest等で参照版を記録する。

同時に起動できるpreviewは一つである。先にプロトタイプの対応画面をDesktopと狭幅で操作し、画像・画面名・viewport・参照版を`artifactDirectory`へ保存して停止する。続いてprofileを省略して製品previewを起動し、同じ画面・viewport・操作で比較する。保存画像を実見して採用した配置・情報密度・操作導線と意図した差を記録する。参照にない画面も製品側のACに従って独立確認する。参照prototypeが起動しても製品ACの成功にはならない。
