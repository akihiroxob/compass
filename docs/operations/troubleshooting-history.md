# エージェント開発を止めた問題と対処の記録

記録開始: 2026-11-07。対象はCompass開発に使うWacha、agent-foundationのRalph、GitHub連携、検証環境。

この文書は障害史・発表素材であり、現在仕様や操作方法の正本ではない。現在の構成は[文書の入口](../README.md)から参照する。会話で登場した問題を原因のまとまりごとに整理し、同じ問題の再発は同じIDへ追記する。

## 証拠と読み方

- **直接確認**: このセッションで実行記録・コード・CLI・API・OSログを照合したもの。
- **会話報告**: 過去の会話で症状・対処が報告されたもの。今回、当時のログや差分まで再検証していない。
- **未確定**: 原因の断定や対処後の効果測定ができていないもの。「再実行できた」と「根本原因を除去した」を分ける。
- Token、Credential、個人のメールアドレス、生の実行Context、DB本体は掲載しない。実行ログは保存期間があるため、参照先だけでなく必要な事実を本文へ残す。

## 発表の中心にできる話

エージェントがコードを書けても、自律開発全体が継続するとは限らなかった。停止は実装の外側――認証、Claim、Git、検証準備、証跡の引継ぎ、再試行の境界――でも起きた。

大きかったのは、失敗をすべて「Agentをもう一度起動する」で扱えないことだった。結果が完成しているなら反映だけを再開し、前提不足なら起動せず、成否不明の外部操作は照合する必要があった。

## 2026年10月からの問題

以下は原則として会話報告。当時の実装差分やログを再確認していない項目には、復旧済みの断定を付けない。

### I-01: Broken pipeをToken切れ・MCP無応答と見誤りやすかった

- 症状: 10/06、Wacha backendの`printf: write error: Broken pipe`。
- 切り分け: 下流のプロセスがpipeを閉じても発生するため、この一行ではToken切れ・MCP無応答のどちらも断定できない。会話では`jq`等の早期終了を調査した。
- 対処: 上下流の終了状態、応答の構造、呼出しエラーを分けて確認する方向へ。正確な発生条件と修正差分は今回未確認。

### I-02: sandboxでGitの書込み・実HTTP検証ができなかった

- 症状: `.git`の書込み拒否、サーバー起動の`EPERM`、検証のskip。
- 対処: Agentによる実装・判断と、ホスト側のGit／PR反映・許可済み検証コマンドを分けた。コマンドはProject設定の引数配列で許可し、対象Worktreeで実行する。
- 学び: 型チェック・build成功だけで、実HTTPやブラウザのACを確認したことにはならない。sandbox全体を外すことを標準解にしない。

### I-03: Project全体の実行ロックが複数Agentの並行作業を阻んだ

- 症状: 別Roleを起動しようとして`Ralph is already running for this Project`。
- 対処: Principal・Role単位のRunnerロックとWorktreeへ分離。作業場所は`.ralph/worktrees/<principal>/<role>`。共有Git metadataの一時競合は再試行する。
- 学び: Worktreeを採用しただけでは、停止状態・ログ・Claim・検証環境まで分離されたことにならない。

### I-04: 同一GitHubアカウントで自己Approveできない

- 課題: 複数AgentのためだけにGitHubアカウントを増やしたくない。
- 対処: GitHubのApproveを必須にせず、PRコメントのTask・Review Claim・head SHA・判定を照合する。Worker／Reviewer／ManagerのPrincipalは別にする。
- 注意: CIはProjectで任意。CI任意は、独立レビューや必要な検証の省略を意味しない。

### I-05: OAuth期限切れとGitHubのPATを混同しやすかった

- 症状: 10/08、`OAuth session expired and could not be refreshed`でWorkerが起動しない。
- 切り分け: Agent Providerのログインと、GitHubのPATは別の認証経路。
- 対処: 認証をProvider・Wacha／Compass・GitHubに分けて扱う。該当時の再認証手順と結果は今回未再検証。

### I-06: PATがあってもGitがSSH鍵を要求した

- 症状: GitHub APIへPATで接続できるのに、pushはSSH鍵を求めた。
- 原因として扱ったこと: Gitのremote・transportとAPIの認証は別。PATをGitへ渡す処理も必要だった。
- 対処: RalphのGit操作でHTTPSと一時Credential helperを使い、PATを引数・ログへ出さずに渡す。URL rewriteによる別host／SSHへの転送も検査する。`gh`の導入を必須にしない。

### I-07: 「GitHub実行結果を反映できませんでした」では停止箇所が分からない

- 症状: commit・push・PR・Wachaへの反映のどこが失敗したか不明。
- 対処: 実行段階・Task・保存記録・エラー分類を出し、保存済み実行を復旧できるようにする。
- 残る例: I-25ではpushの詳細が`command failed`へ丸められ、原因の特定ができなかった。詳細化は一度で完結していない。

### I-08: Workerが結果JSONを作らず終了した

- 症状: 実装やテストを実行していても、必須の`.ralph-result.json`がない。
- 背景: 端末停止・バックグラウンド検証中断の可能性が話題になったが、それだけを原因とは断定しなかった。
- 対処: 検証の終了コード取得、結果JSONの書込みと読戻しを終了条件にする。欠落時は成果物を残して同じWorktreeで引き継ぐ。

### I-09: Claim期限切れで成果物を反映できなかった

- 症状: 長い作業・検証後に更新権限を失う。
- 対処: RunnerがTaskの現在段階・所有・要件を照合し、期限切れClaimを再取得する。同じrequestIdで成否不明の取得を照合し、結果を別Taskへ付け替えない。
- 残った課題: 検証Toolへ渡したClaimの更新、スリープ後の復旧、予算の持越しはI-29〜I-31で再発した。

### I-10: Git反映エラーをWorkerへ返せず、最後のPython処理で停止した

- 症状: 実装完了後のmanifest・diff・Gitエラーで、Agentへ修正を戻せない。
- 対処: 同じWorktree・保存済み結果・診断を渡すWorker修正フローと、回数・時間を制限した復旧判断を追加。成否不明の外部操作は再送前に照合する。
- 学び: Pythonが業務判断を抱え込まない一方、所有・冪等性・操作境界の検査は必要だった。

### I-11: Worktreeとローカルbranchが蓄積した

- 症状: 完了後も作業場所・branchが大量に残り、ディレクトリとGitの表示も一致しない。
- 対処: 成功時の清掃、清掃失敗の保持記録・再試行、ローカルbranch清掃を追加。未反映commitや追跡先を確認できないbranchは保護する。
- 残る事実: 11月のログにも`Local branch commit has no remote tracking reference; retained`が多数ある。保護されたbranchを一律にゴミ扱いして削除していない。

### I-12: ログ肥大・複数プロセスのローテーション競合

- 要望: 日ごとに時系列で見返し、20日分を保持したい。
- 対処: 日付別ファイルへ直接追記し、同じファイルのrenameによる世代交代を避ける。Role・Principalのprefixで追跡する。
- 注意: 期限を過ぎた生ログは参照できなくなるため、重要な障害の要約は本記録へ残す。

### I-13: Ctrl+CでRunnerを止められない

- 症状: 待機中や子プロセス実行中に停止が遅れる。
- 対処: 割込み可能な待機と、対象Runnerのプロセス群だけを段階的に終了する管理処理を追加。実行記録は保持する。
- 学び: 終了コードだけでなく、子Agent・MCP・preview・Role lockの解放までが停止処理の範囲だった。

### I-14: 状態ファイルを消すだけのresumeでは復旧できない

- 症状: pause・quota・PID・GitHub状態・保留記録が増え、何を戻すべきか分かりにくい。
- 対処: 共有runtime状態とPrincipal／Role別の実行記録を区別。resumeは再開許可、成果物の反映完了ではないと整理した。明示的な破棄操作と通常再開を分ける。

### I-15: ブラウザがAbort・Transport closed・接続拒否になる

- 症状: Chromium系プロセスのAbort、MCPの`Transport closed`、`ERR_CONNECTION_REFUSED`。
- 対処: 探索的な検証にはPlaywright MCPを採用し、独立セッション・専用port・専用DB・準備完了待ち・終了記録を持つpreviewを提供した。
- 注意: 過去の各Abortの原因がすべて同一だったとは確認していない。ブラウザ操作と対象アプリのServer起動は別機能。

### I-16: Provider固有のMCP指定へ依存していた

- 課題: Providerごとの設定へ追加Toolを固定したくない。
- 対処: Projectの`.mcp.json`を共通入力として各Providerの形式へ変換する。Wachaの接続とClaimに紐づく検証ToolはRunnerが追加する。
- 学び: MCP定義があること、Providerが読み込むこと、Toolの利用を許可されることは別。

### I-17: Toolがあるのに権限・Policyで使えない

- 症状: trust設定を増やすべきか、Project側の許可不足か判断しにくい。
- 対処: MCP接続先・公開契約・主体・activeRole・scope・Project Policyを照合する。検証環境の操作許可を、運用DBや実Taskへの操作許可と分けた。

### I-18: ACに必要なデータを、そのTaskのSHAで準備できない

- 症状: 作成APIがまだない対象を一覧から確認するなど、後続機能を待たないと受け入れられない。
- 対処: Givenの準備入口・利用可能時点・所有Task・対象SHAを起票時に確認。公開操作のACをfixtureで代替せず、必要な順序・分割・AC割当を修正する。
- 学び: 保留の原因は実装の不足だけでなく、計画の循環でも起きる。

### I-19: Manager／Reviewerが検証準備の不具合を直せない

- 症状: 製品コードを変えてはいけないRoleが、fixtureや準備scriptの不備でも停止する。
- 対処: 許可ファイルだけを専用コピーで編集可能にし、本体SHA・期待結果・認可・ホストコマンドを固定する。準備版と差分を記録し、変更後は検証を再実行する。

### I-20: 固定checkoutの旧準備コードと専用コピーを混同した

- 症状: 専用コピーで検証できていても、固定checkoutへの反映が必要として保留する。
- 対処: 正規経路を、本体SHA・準備元SHA・専用コピーのfingerprint・実行コマンド・manifestの一致で確認する。準備の成功だけをAC成功としない。
- 再発: Workerへのコピー提供が未配布だった問題はI-28。HEADを更新した後の準備世代はI-30。

### I-21: Project作成がDB制約で500になる

- 症状: `NOT NULL constraint failed: project.mission`。
- 切り分け: ProjectからWorkspaceへの責務移動と、DB／書込処理の整合を確認する必要があった。ログ一行だけで、古いDBか書込コードのどちらかに断定しない。
- 経緯: 開発DBの破棄可否と、変更をTask・コメントへ記録してから修正する進め方を相談した。最終修正の差分と再現試験は今回未確認。

### I-22: 共通UI・ディレクトリ規約が実装へ適用されない

- 症状: ボタンサイズの不一致、共通部品の未利用、Feature責務・依存方向の不統一。
- 対処: 共通React部品・SCSS・token・カタログの方針を整え、起票・実装・レビューで適用する。配置名の変更だけで構造改善とせず、利用画面も確認する。
- 学び: Skillに書くことと、実装・レビューで検証することは別だった。

## 2026-11-04以降に直接確認した問題

### I-23: ReviewerにUI検証手段がなく、先頭Taskから後続が詰まった

- 対象: UI-A1、PR #55、head `9f3778dd`。
- 原因: previewがManager限定。Workerが記載した`.playwright-mcp/a1-*.png`も参照可能な保存先に見つからなかった。
- 対処: Worker／ReviewerにもClaim別の専用previewを提供し、画像を`.ralph/verification/<claimId>/browser/`へ保存。Reviewerの対象SHAで準備・起動成功を確認した。
- 確認: 11/04のRuntime実行記録と、当時の全188回帰テスト成功の記録。

### I-24: 依存待ちTaskをClaim・起動してから保留していた

- 原因: 依存はTask説明文にしかなく、RalphがAgent起動前に判定できなかった。
- 対処: Projectの`taskDependencies`へ28 Taskの依存を明示し、新規選択と保留復元でacceptedを確認。実データで後続27件が依存待ち、起動候補0件と確認した。
- 制限: この制御はRalphのProject設定であり、WachaのClaim契約や別クライアントへ依存制約を追加したものではない。

### I-25: B3のpushが失敗し、復旧上限に達した

- 対象: 11/06、PR #66。未送信commit `b916025`、remote head `29e430d`。
- 確認: cleanなWorktree、保存済み結果、fast-forward可能なdry-runを照合。Workerを止めて退避後、Ralphの復旧処理で同じcommitをpushし、Taskを`in_review`へ戻した。
- 未確定: 実pushの再試行は成功した。元の失敗は`command failed`に丸められており、通信・認証等のどれだったか特定できていない。

### I-26: 1 TaskのContextとモデル呼出しが大きくなった

- 確認: B3のClaude実行は約22分、変更78ファイル、モデル呼出し149回。1回の入力Contextは約2.9万から約32.8万Token、累計出力は約9.6万Tokenだった。計測時の直近10セッションにcompaction記録はなかった。
- 対処: Story分解SkillにContext範囲・検証範囲・実測による粒度調整を追加。ユーザーはOpusからSonnetへ切り替え、消費が軽くなったと報告。
- 制限: キャッシュを含む延べToken、Contextピーク、5時間枠の使用率は別。自動収集・Task別集計は未実装で、今回の値はClaudeのJSONLを調査して取得した。モデル変更だけの定量比較や品質評価は未実施。

### I-27: 復旧用プロセスがProject workflowを読み込まなかった

- 症状: B3が`recover/initialization: Required field missing: baseBranch`で保留。
- 原因: 新規プロセスの復旧処理では`workflow`が空なのに、base branchを必要とする処理へ進んだ。
- 対処: `apply_recovery`で現在のProject workflowを読み直す修正がソースに存在した。11/07、その修正がRuntimeに未配布と確認し、配布した。新規プロセスの再現を含む全189テスト成功。

### I-28: 配布漏れとAgent作成merge commitが再開を妨げた

- A2: Workerへの専用準備コピー対応はソースにあったが、インストール済みRuntimeにはなかった。配布後、準備3件・preview起動成功とWorker完了を確認。
- B3: Agentがmerge commit `3624b68`を作成し、Ralphのcommit所有検査が拒否。元commitをbundleとGit参照へ保持し、同一tree・元の親を保つ未commit merge状態へ復元した。manifest照合をWorkerへ戻し、PR更新・再レビューへ進んだ。
- 再発防止: Worker手順に`merge --no-commit --no-ff`とmanifestの照合を明記。ソース変更、インストール、Runner再開は別の確認点。

### I-29: Macの自動スリープ中にClaim更新と通信が止まった

- 対象: 11/07のA2 Reviewer。
- 証拠: `pmset -g log`に02:36:44のIdle Sleep、04:20:51の復帰。Ralphでは04:21に`Verification Claim expired`。再試行後も04:36:13に再スリープし、05:37にwatchの期限切れ、08:49に接続再試行と検証拒否が記録された。
- 判断: OSのスリープとClaim期限切れ・通信中断の時刻が対応する。スリープ中もClaim更新できるとは扱わない。
- 対処: 本修正でmacOSのRunnerに`caffeinate -i`を付け、実行中の自動idle sleepを抑止する。明示的なスリープ・蓋を閉じる操作・電源断を防ぐ保証はしない。Claim期限切れ時の再取得と検証Context再生成を残す。
- 11/07の確認: インストール済みRuntimeへ配布後、WorkerとReviewer／Managerの両Runnerに実際の`caffeinate -i`プロセスを確認。実機を意図的に長時間sleepさせる復帰試験は行っていない。

### I-30: HEAD更新後も、古いHEAD専用の検証準備を使おうとした

- 対象: O2。準備は`3b4e87f`、本体は`863b44d`。準備元SHA・許可ファイル一覧は同じだった。
- 原因: 準備先が古い`worktreeClaimId`で固定され、本体HEADが変わる正常な再開を「準備元か境界が変わった」として拒否した。
- 証拠: 既存記録を変更せず`ensure_preparation`で同じ例外を再現。
- 対処: 本修正で、取得元と許可範囲が同じまま本体HEADが変わった場合は新しい準備世代を作る。旧コピー・差分・証跡を保持し、旧編集の適合性はAgentが確認する。旧SHAの検証成功は新SHAへ流用しない。
- 11/07の確認: O2を通常復元処理で再開し、本体`863b44d`に対応する`preparation-versions/`の新コピーと、旧`3b4e87f`のコピーへの参照を確認。Workerは実行中。Taskの完了・最終受入は確認待ち。

### I-31: 検証Claimの復旧と15分の修復予算が混ざった

- 対象: A2。復旧予算開始04:36、最終保留08:50。`finish`は結果を読む前に時間切れとして保留し、期限切れ検証の再復旧へ進めなかった。
- 原因: Claim更新後の通常レビューへ修復用のwall-clock期限を持ち越した。watchの終了だけではAgent全体が停止しないため、スリープ・再接続後も古い条件で処理が進んだ。
- 対処: 本修正で検証Context再取得を回数制限付きの別枠に分離。操作／Worker修復の時間制限は維持し、新規予算はmonotonic時計を使う。修復期限が過ぎても、完了済みの結果JSONを保留記録へ保存する。
- 注意: 旧形式の予算は互換処理を持ち、検証の再試行は無制限にしない。再開前に対象SHA・Claim・Task段階を照合する。
- 11/07の確認: 全197回帰テスト成功。A2を新Claimで復元し、MCPのClaimと一致、古い期限切れ印なし、復旧用時間制限の持越しなしを確認した。対象HEAD`c7e1d91`のReviewerは実行中で、レビュー・受入完了とは区別する。

### I-32: PRの報告コメントが読みにくい

- 確度: 会話報告。JSON由来の一段落の長い報告など、変更・検証・未確認が見分けにくいという指摘。
- 対処: Worker／ReviewerのsummaryをMarkdownにし、見出し・箇条書き・path・SHAを区別してPRへ渡す手順を追加した。
- 学び: 内容を保存できるだけでなく、人が差し戻し・障害を判断できる表示も必要だった。

### I-33: Toolや修正を追加しても、APM／Runtimeへ反映されていない

- 確度: 会話報告とI-27・I-28での直接確認。会話では`apm update`忘れ、相談follow-up／artifact Tool等の利用条件不足も確認対象になった。
- 対処: 配布元、Projectへ展開された設定、CLIが使うRuntime、Agentへ渡ったTool／権限を分けて確認する。
- 学び: ソースに修正があることだけで稼働系が直ったとは言えない。APM更新とRalphインストールも異なる操作。

### I-34: 検証文書の競合で、どちらの規則を残すか判断が必要になった

- 確度: 会話報告。`docs/browser-verification.md`の競合について相談・統合を依頼した。
- 対処: 一方を丸ごと採用するのではなく、検証境界・準備方法・公開操作の許可を整合させる方針。今回、その時点の統合差分までは再確認していない。
- 学び: 同じ文書を複数Taskが変える場合、受入条件と準備Policyを欠落させない確認が必要。

### I-35: 作業中のreset／pullで未コミット修正が消えた

- 確度: 会話報告。検証手順の未コミット修正が消え、最新mainへ適用し直す方針をユーザーが承認した。
- 対処: 作業内容を退避・照合し、対象SHAと作業場所を特定して最新mainへ適用する。退避・差分・未追跡ファイルを確認せずにリセットで復旧しない。
- 学び: Worktreeを使う以前も以後も、所有する作業場所と未反映成果物の保護が必要。

### I-36: 証跡と一緒に保存した配列JSONで、レビュー結果の反映が落ちた

- 日時・対象: 11/07、A2、PR #72。Reviewerの判定は`approve`。対象HEAD`ff625f1`、Review Claim `b3353b15-cc0c-4b4b-9afc-dfe8c96491c6`。
- 症状: 15:34のAgent終了後、保存済み結果の`finish`で`AttributeError: 'list' object has no attribute 'get'`。調査時点のログには同じ例外が10回あり、300秒おきに再試行していた。
- 原因・確度: 直接確認。`preparation_workspace.py`の`assert_preparation_verified`がClaim配下の全JSONを再帰走査し、JSON objectであることを確認せず`.get()`を呼んでいた。最初の`task-scope-facts.json`は3件の配列で、正しいJSONだが検証記録ではなかった。JSONの読取部分だけを使い、状態を書き換えず同じ例外を再現した。
- 確認結果: 現在のClaim・本体SHA・準備fingerprint `909479d8…`・差分・成功状態が完全一致する検証記録が3件あった（ホスト検証2件、正常停止したpreview1件）。先に調査メモへ当たるため、これらを評価する前に停止していた。
- 反映範囲: GitHubのPRはopen・未mergeで、今回のClaimに紐づくレビューコメントは未投稿。Wachaは`in_review`、レビュー済みSHA・merge SHAも未記録。停止位置はGitHub／Wachaへのレビュー結果反映の前にある、ローカルの検証準備チェック。
- 再試行の問題: `AttributeError`はCLIの処理対象例外に含まれず、通常のエラー記録・有限回のAgent復旧へ入らず終了コード1になった。shellの一般エラー経路が同じ保存済み判断を再試行した。Agentを毎回再起動するループではない。
- 対処: 対象Reviewer／Manager Runnerを停止し、実行記録・結果JSON・Claim配下の証跡を退避。agent-foundationの証跡探索をRunner生成のホスト結果とpreview記録へ限定し、JSON object・status・準備情報の型を確認する。Claim・SHA・準備版の完全一致要件は維持し、調査メモは削除しない。
- 再発防止: `AttributeError`／`TypeError`は安全な例外名・発生ファイル・行番号と処理段階を保存し、終了コード78で該当Roleを停止する。同じ内部不具合を無限再試行したり、製品Agentへ繰り返し解消を求めたりしない。生の例外本文は出力しない。運用文書も更新した。
- 検証: 全201テスト成功。配列メモの混在、非object JSON、型不正、Claim／SHA／準備版の不一致、symlink、証跡不足、CLIの停止・状態保持を回帰テストで確認。安全な発生位置表示の追加後も対象テストを再実行して成功。実際の証跡一式を読み取り専用で再評価し、一致する証拠を取得でき、メモが不変であることを確認した。
- 実行環境への反映: 検証済み6ファイルを既存変更とのhash照合後に反映し、グローバルRuntimeを再インストール。変更したPythonモジュールのsource／Runtime一致を確認。Workerは停止せず、Reviewer／Managerを17:16に再開した。
- 再開時の状態: GitHub live headとWorktreeは`ff625f1`で一致、Worktree clean、PRはopen・merge可能。保存済み結果の処理は配列例外を通過したが、停止中のClaim期限切れにより新Claim `644504ce-916d-4cb5-a38f-55d03d88967d`へ再取得されたため、旧Claimの証跡をそのまま承認に使わず通常のAgent復旧へ移行した。証跡のClaimを書き換えて承認する操作はしていない。レビュー反映・merge・Manager受入の完了とは区別する。

### I-37: 保存済みレビューのClaim再取得後に、検証Contextを更新せず保守待ちになった

- 日時・対象: 11/07、UI-A2、PR #72。I-36の配列JSON修正後の再開で発生。
- 症状: Claim再取得後の`finish`で準備検証の成功証跡が不足とされ、診断Agentが基盤修正を必要と判断して`defer`。Reviewerが保留し、後続Taskも依存待ちとなった。Runnerは稼働していたが、実作業は進んでいなかった。
- 原因・確度: 直接確認。新Claimに対して古い`mcpClaimId`の接続情報・証跡が残った。検証ガードは現在Claimの証跡を要求する一方、保存済みapprove/acceptを新しい検証Contextへ戻す経路がなかった。既存の再検証経路は検証中に期限切れを報告したblocked結果だけを扱っていた。
- 対処方針: 古い証跡のClaimは変更しない。準備を修正した保存済みapprove/acceptについてClaimとMCP Contextが異なる場合、前回の結果・実行を退避し、通常Roleへ`verificationRetry`で返す。prepareで新Claim用MCP Contextを生成し、固定SHA・準備版について現在Claimの成功証跡を取得する。過去の調査と証跡は保持し、他の確認は影響範囲と未完了分を実施する。
- 再発防止: Reviewer／Managerとblocked時の再検証を共通経路で扱い、既存の`retry.recovery.maxAttempts`で上限を設ける。同じClaimでの証跡不足は迂回しない。通常の保留復元からもこの経路へ進める回帰テストを追加する。
- 実施・検証結果: agent-foundationの共通再検証経路と運用文書を修正し、全205テスト成功。Reviewer・Managerの期限切れ、保留したapproveからの復元、新MCP Context生成、旧証跡だけでの承認拒否、新Claim証跡による通常遷移、再検証上限での成果保持を確認した。生成設定の整合チェックも成功。グローバルRuntimeへ反映し、sourceとの一致を確認した。
- 復旧状態: 停止中に対象の実行記録・結果・診断結果を`/tmp/compass-a2-claim-refresh-backup-20261107/`へ退避し、Roleロック下で通常のresume／保留復元を実施。A2のWorktreeと保存済みapproveを保持して再開待ちへ戻した。旧証跡は変更せず、GitHub／Wachaの業務状態も変更していない。ユーザー自身が起動する指示に従い、Runner・Agentは起動していない。実運用での再検証・merge・受入完了は未確認。
- 追加確認: 復旧作業時、PR #72はopen・対象head `ff625f1`のままだが、GitHubの`mergeable`はfalseへ変化していた。Claim問題の解消をマージ可能・レビュー完了と同一視しない。製品の競合処理は次回起動時の通常Reviewer／Workerフローで扱う。

## 今後の追記方法

- 新しい運用障害を調査・復旧したとき、最終報告前に本書を更新する。同じ原因は既存IDへ再発日・差分を追記する。一般的な一度だけのテスト失敗をすべて障害項目へ増やさない。
- 記録する項目: 日時・対象／症状・影響／原因と確度／実施した対処／確認結果／残る問題／安全な参照先。
- 原因未特定、対処だけ成功、テストだけ成功、実運用で再確認済みを区別する。失敗した初回対処も、再発の説明に必要なら残す。
- 現在の操作手順が変わったら現行ガイドも更新する。本書から現行仕様を上書きしない。公開発表前には機密・個人情報と証拠の確度を再確認する。

```md
### I-XX: 症状を表す題名

- 日時・対象:
- 症状・影響:
- 原因・確度:
- 対処:
- 確認結果:
- 残る問題・参照:
```
