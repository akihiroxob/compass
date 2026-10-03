# Project画面の情報設計と視覚方針

Story「CompassのUIを整理し、進行状況とAgentの担当が分かる体験にする」の後続Task（02〜05）が画面判断に使う案。実装済みの仕様ではない。実装したTaskで現行文書へ反映し、この文書から該当箇所を除く。

## 前提

- 技術構成（Hono / React・Vite / 既存CSS）とWeb APIを変えない。DB・公開APIの追加を前提にしない。
- 導線の表示判定は既存の`canOperate`（`humanProjectPermissions`）と`useProjectOperation`を使い、拒否は常にServerが行う。
- Activityをworkflow checkpointやAgent heartbeatとして使わない。

## 現行画面の棚卸し

Project詳細（`ProjectDetailPage`）は次の順に1ページへ並ぶ。各sectionが個別にAPIを呼ぶ。

| 順 | Section | 情報源 | 表示・操作の権限 |
| --- | --- | --- | --- |
| 1 | Hero（名前・説明・更新日時・自分のRole・編集・アーカイブ） | `GET /api/projects/:id` | 編集: administrator、アーカイブ: owner |
| 2 | Mission・Vision | 同上 | viewer |
| 3 | Intent（Active Intent・Active Outcome・過去のIntent） | `intents`、`intents/:id/outcomes` | 登録・編集: editor |
| 4 | Execution（Story・Task・Claim・最近の変更） | `execution`、`changes` | 起票: editor。介入はTask詳細でeditor |
| 5 | Activity | `activities` | viewer |
| 6〜11 | Strategist・Researcher・Manager・Worker・Reviewer・EvaluatorのRole割当（各section） | `grants`（Roleごとに同じAPIを呼ぶ） | 割当・取消: administrator |
| 12 | Agent・Runtime Credential | `credentials` | administratorのみ表示 |
| 13 | Member・招待 | `members` | 管理: owner |
| 14 | Research | `research-requests` | viewer（参照専用） |
| 15 | ADR参照 | `adr-references` | viewer |
| 16 | Principles・Constraints・Repositories・Resources | `GET /api/projects/:id` | viewer |

Outcomeの評価段階（`outcomeLoopStage`: 未接続・Execution中・未評価・評価済み）はOutcome詳細だけにあり、Project詳細では見えない。

課題:

- 最初に見たい現在地・次の行動・担当中のAgentが、Intent・Execution・Role割当・Credentialへ散在する。
- 管理設定（6つのRole割当、Credential、Member）が日常閲覧の間に挟まり、スマートフォンで約9,300pxになる。
- Role割当、Credential、Claim保持の違いが画面上で区別しにくい。

## 利用者と場面

| 利用者 | 主な場面 | 必要な情報 |
| --- | --- | --- |
| viewer | 状況の確認 | 現在地、担当中のTask、履歴 |
| editor | 方向の更新、受入・差戻し | 上記に加え、Intent・Outcomeの不足、受入待ちのTask |
| administrator | Agentの準備 | 上記に加え、Role未割当、Credential未発行 |
| owner | Memberとライフサイクルの管理 | 上記に加え、Member・招待・アーカイブ |

Desktopは作業中の常時確認と管理設定、スマートフォンは外出先での状況確認と受入判断を想定する。スマートフォンでも概要は1画面程度で読み終え、管理設定へ2操作以内で到達できるようにする。

## 情報の優先順位

1. **現在地**: Direction（Intent・Outcome）→ Work（Story・Task）→ 評価のどこにいるか。
2. **次の行動**: 自分の権限で今できること。できない場合は誰に依頼するか。
3. **担当中のAgent**: 期限内のClaimを持つAgentとTask。
4. **日常閲覧**: 方向の詳細、Story・Task一覧、最近の変更、Activity、Research。
5. **管理設定**: Role割当、Credential、Member、Projectの編集・アーカイブ。

## 画面構成

Project詳細を次のviewに分ける。viewはURLのquery（`?view=`）で表し、再読込・共有・ブラウザの戻るで同じviewへ戻れる。指定が無い・不正な値は「概要」にする。表示中のviewのsectionだけをmountし、不要なAPI呼出しを減らす。

| view | `?view=` | 内容 |
| --- | --- | --- |
| 概要（既定） | `overview` | 現在地、次の行動、担当中のAgent、Mission（1行） |
| 方向 | `direction` | Mission・Vision、Intent（Active Outcome・過去のIntent）、Principles・Constraints |
| 実行 | `work` | Story・Task一覧、起票の導線、最近の変更 |
| 記録 | `records` | Activity、Research、ADR参照、Repositories・Resources |
| 設定 | `settings` | Agent（Role割当6種）、Credential（administratorのみ）、Member・招待 |

- Hero（名前・状態・自分のRole）は全viewで共通に表示する。Projectの編集・アーカイブは「設定」へ移す。archivedの通知はHero直下に全viewで出す。
- view切替は`nav`（`aria-label="Projectの表示"`、選択中に`aria-current="page"`）。Desktopは見出し下に横並び、スマートフォンは横スクロール可能な1行にし、どちらも上端へstickyにする。
- 「最近の変更」から同じ画面のStory cardへのanchor（`#execution-story-…`）は「実行」view内で完結させる。他viewから辿る場合は`?view=work#…`のURLにする。
- 「設定」のAgentは、6 Roleを1つの一覧にまとめる。行ごとにRole名・割当済みAgent名・（administratorには）Credentialの有無を出し、割当フォームは行を展開したときだけ表示する。Roleごとの説明文は1行に短縮する。

### 概要

**現在地**は4段の横並び（スマートフォンは縦並び）で示す。

| 段 | 表示 | 情報源 |
| --- | --- | --- |
| Intent | Active Intentの題名、または未登録 | `intents` |
| Outcome | Active Outcomeの件数と題名 | `intents/:id/outcomes` |
| Work | ProjectのTaskを状態別に件数表示（未着手・作業中・再取得待ち・レビュー待ち・受入待ち・差戻し）。0件の状態は省く | `execution` |
| 評価 | Active Outcomeごとの`outcomeLoopStage`のラベル | `execution?outcomeId=`、`execution-summary`、`evaluations` |

評価段はActive Outcomeの件数分だけAPIを呼ぶ。件数が多い場合は先頭数件に限り、残りはOutcome詳細へ誘導する。各段から根拠の詳細（Intent詳細、Outcome詳細、「実行」view）へリンクする。Executionの受入をOutcomeの達成として表示しない。

Workの件数は次の区分で数え、各Taskをどれか1つに入れる。状態名は`taskStatusLabels`を使い、`in_review`（レビュー待ち）と`wait_accept`（受入待ち）をまとめない。

| 区分 | 条件（`execution`のTask） | 次に動く担当 |
| --- | --- | --- |
| 未着手 | `todo` | Worker |
| 差戻し | `rejected` | Worker（再着手） |
| 再取得待ち | `doing`かつ`reclaimable` | Worker（再取得） |
| 作業中 | `doing`かつ`activeClaim`あり | Claim保持中のWorker |
| レビュー待ち | `in_review` | Reviewer。`activeClaim`が無ければHumanも受入・差戻しできる |
| 受入待ち | `wait_accept` | Manager。`activeClaim`が無ければHumanも受入・差戻しできる |

**次の行動**は「あなたの操作」と「Agentの担当待ち」の2つに分けて出す。archivedではどちらも出さない。

「あなたの操作」は、条件を上から評価して最大3件を出す。自分の権限で実行できるものはボタン、できないものは依頼先の文言にする。

| 条件 | 表示 | 実行に必要な権限 | 権限が無い場合 |
| --- | --- | --- | --- |
| Active Intentが無い | Intentを登録 | `direction.write` | Editor以上へ依頼 |
| Active Outcomeが無い | Outcomeを登録 | `direction.write` | Editor以上へ依頼 |
| 期限内Claimの無い`wait_accept`のTaskがある | 受入待ちのTaskを確認（件数） | `execution.intervene` | 表示しない（「Agentの担当待ち」に出る） |
| Story起票待ちのOutcomeがあり、Managerが未割当 | Managerを割り当てる | `grant.manage` | Administrator以上へ依頼 |
| 未着手・差戻し・再取得待ちのTaskがあり、Workerが未割当 | Workerを割り当てる | `grant.manage` | Administrator以上へ依頼 |
| レビュー待ちのTaskがあり、Reviewerが未割当 | Reviewerを割り当てる | `grant.manage` | Administrator以上へ依頼 |
| 割当済みAgentにCredentialが無い | Credentialを発行 | `credential.manage` | 表示しない（Credentialはadministratorしか参照できない） |
| 評価待ちのOutcomeがあり、Evaluatorが未割当 | Evaluatorを割り当てる | `grant.manage` | Administrator以上へ依頼 |

「受入待ちのTaskを確認」は「実行」viewの受入待ちTaskへ移動する。レビュー待ちのTaskはReviewerの担当とし、Humanの介入（受入・差戻し）はTask詳細の既存操作に任せて、概要では勧めない。

「Agentの担当待ち」は、Agentが次に動く必要のあるOutcomeとTaskを区分ごとに件数で出す。Outcomeは現在地の評価段と同じ`outcomeLoopStage`で判定し、Taskは期限内Claimの無いものを数える。Outcome handoffのStory起票（Manager）、Evaluationの記録（Evaluator）、AgentのClaimはHumanが代行できないため、ボタンにせず、状況と必要な担当Roleを文で示し、根拠の詳細（OutcomeはOutcome詳細、Taskは「実行」viewの該当Task）へリンクする。

| 区分 | 条件 | 表示例 |
| --- | --- | --- |
| Story起票待ち | Active Outcomeの`outcomeLoopStage`が`not_connected` | Story起票待ち N件 — Managerの起票待ち |
| 評価待ち | Active Outcomeの`outcomeLoopStage`が`not_evaluated` | 評価待ち N件 — Evaluatorの評価待ち |
| 還流待ち | Active Outcomeの`outcomeLoopStage`が`not_reflected`で、そのOutcomeのTaskに未着手・差戻し・作業中・再取得待ち・レビュー待ち・受入待ちが無い | 還流待ち N件 — Runtimeの結果還流待ち |
| 未着手 | `todo` | 未着手 N件 — Workerの着手待ち |
| 差戻し | `rejected` | 差戻し N件 — Workerの再着手待ち |
| 再取得待ち | `doing`かつ`reclaimable` | 再取得待ち N件 — Claimの期限が切れ、Workerの再取得待ち |
| レビュー待ち | `in_review`かつ`activeClaim`無し | レビュー待ち N件 — Reviewerの担当待ち |
| 受入待ち | `wait_accept`かつ`activeClaim`無し | 受入待ち N件 — Managerの担当待ち（Editor以上はHumanとしても受入できる） |

- 担当Roleが未割当なら、その行に「Managerが未割当」のように併記する（割当の操作は「あなたの操作」に出る）。Role割当済みでも、Agentが動いていることは示さない。Story起票待ち・評価待ちはClaimを持たないため、Role割当済みでも「担当中」とは言わない。
- Story起票待ちはOutcome handoffのStoryを対象にする。Editor以上の手動起票（`execution.plan`）はOutcome handoffを代行しないため、起票ボタンとして勧めない。
- 評価段が先頭数件に限られる場合も、Story起票待ち・評価待ち・還流待ちの件数は全Active Outcomeで数える。取得に失敗したOutcomeは件数に含めず「一部のOutcomeを確認できません」と再読込の手段を出し、空メッセージにしない。
- `not_reflected`（Execution中で結果は未還流）のOutcomeは、未完了のTaskが残る間はTask区分で表し、Outcomeとしては数えない。Taskが残らない場合だけ還流待ちとして出す。
- 期限内Claimを持つTaskは「Agentの担当待ち」に含めず、「Claim保持中」に出す。

「あなたの操作」も「Agentの担当待ち」も無く、Outcomeの取得失敗も無いときだけ「今すぐ必要な操作はありません」と出す。「あなたの操作」が無く担当待ちだけがある場合は「あなたの操作はありません」と出し、担当待ちを並べる。Credentialの有無はadministrator以外に推測させない。

**担当中のAgent**はTask 02で実装する。

- `execution`の`activeClaim`（期限内）を持つTaskを、Task状態（作業中・レビュー待ち・受入待ち）ごとにまとめる。行はAgent名、Task名、状態、期限（相対表示と絶対時刻）、Task詳細へのリンク。
- `reclaimable`（期限切れ）は担当中に含めず、「再取得待ち N件」として別に出す。
- 見出しは「Claim保持中」とし、「稼働中」「作業中のAgent」と言わない。注記で「Claimは作業権の期限付き保持で、Agentプロセスの稼働を示しません」と示す。
- Strategist・Researcher・Evaluator（Claimを持たないRole）は「Claimで観測できません」と明示し、状態を推測しない。
- 取得時刻と再読込ボタンを出す。読込中・取得失敗・Claim無しを別の表示にする。

## Role・稼働状態の区別

| 状態 | 情報源 | 表示語 | 表示してはいけない意味 |
| --- | --- | --- | --- |
| Role割当 | `grants` | 割当済み | Agentが起動している |
| Credential | `credentials` | 発行済み・取消済み | Agentが接続している |
| Claim保持 | `execution`の`activeClaim` | Claim保持中（期限 …） | プロセスが動作中 |
| 期限切れClaim | `reclaimable` | 再取得待ち | 担当中 |
| プロセス稼働 | 現在Web UIに信頼できる情報源が無い | 表示しない | — |

プロセス稼働を表示する場合は、Orchestrator等の運用情報の契約を別Taskで設計してからにする。Activity・Change Logの最終時刻を稼働の代わりにしない。

## 空・読込・失敗の状態

- 読込中・失敗・未登録を必ず区別する。失敗には再読込の手段を付ける。
- 未登録には、権限に応じた次の行動を1つだけ添える。実行できない利用者には依頼先を示し、押せないボタンを出さない。
- 未定義のURLには404画面を出し、Project一覧と直前の画面へ戻れるようにする（Task 05）。
- 内部ID・相関IDは`code`で表示し、折り返せるようにする。本文の主情報にはしない。

## 用語

- Entity名（Project・Intent・Outcome・Story・Task・Claim・Activity）は英語のまま使う。状態・操作・viewの名前は日本語にする。
- 状態ラベルは既存の`taskStatusLabels`・`storyStatusLabels`・`outcomeLoopStage`を正とし、画面ごとに言い換えない。
- Agent名は`principalId`をそのまま表示し、Humanは`describePrincipal`で表示名にする。
- 「稼働」「起動」「接続」は、それを直接観測できる情報があるときだけ使う。

## 視覚方針

### 状態色

既存の配色（背景`#f4f1eb`、文字`#24221f`、アクセント`#a2462d`）を基調に、意味ごとのCSS変数を定義して各画面で共有する。

| 意味 | 用途 | 方針 |
| --- | --- | --- |
| 要対応 | 受入待ち、差戻し、あなたの操作 | アクセント（`#a2462d`）の塗りbadge |
| 待機 | 未着手、Agentの担当待ち | 塗りの無い枠線badge |
| 進行中 | 作業中、レビュー待ち、Claim保持中 | 落ち着いた青系の塗りbadge |
| 完了 | 受入済み、評価で達成 | 緑系の淡い背景 |
| 終了・控えめ | 取消、過去のIntent | 既存の`muted` |
| 警告・失敗 | 読込失敗、再取得待ち（期限切れ）、危険な操作 | 既存の`error`・`danger` |

色だけに頼らず、必ずラベル文字を併記する。文字と背景はWCAG AAのコントラスト比を満たす。

### タイポグラフィ・余白

- 見出しはGeorgia、本文はsystem sansを維持する。Project詳細のh1は現行（最大5.6rem）より小さくし、概要がファーストビューに入るようにする。
- 件数・時刻は`font-variant-numeric: tabular-nums`、IDは等幅にする。
- section間の余白とcardの角丸は既存の値を基準に統一し、新しいcard種別を増やさない。

### 動き

- view切替、行の展開、状態badgeの変化に150〜200ms程度のfade・高さ変化を使う。理解を助けない装飾的な動きは入れない。
- Agentの稼働を連想させる点滅・脈動・回転を、Claim保持やRole割当の表示に使わない。期限のカウントダウンもしない。
- `prefers-reduced-motion: reduce`ではtransition・transformを無効にする。
- keyboard focusは既存の`outline`を全操作要素で見えるようにし、view切替でfocusを失わない。

## 後続Taskの受入観点

- **02**: 期限内Claimだけを担当中とし、期限切れは再取得待ちとして別表示する。状態3種を区別し、Task詳細へ移動できる。読込中・失敗・Claim無しが区別され、再読込できる。Claim非保持のRoleを推測表示しない。Desktop・スマートフォン、期限切れ、取得競合後の再読込を確認する。
- **03**: viewとURLが対応し、戻る・再読込で同じviewに戻る。概要の現在地・次の行動が上記の区分と条件表どおりに出る。Story起票待ち（`not_connected`）・評価待ち（`not_evaluated`）・還流待ちのOutcome、または未着手・差戻し・再取得待ち・期限内Claimの無いレビュー待ち・受入待ちのTaskのいずれかが残るProjectで「今すぐ必要な操作はありません」と出さない。Manager・Evaluatorが割当済みでも、Story起票待ち・評価待ちを担当待ちとして出す。レビュー待ちと受入待ちを別の表示にする。AgentのClaimを要する作業をHumanの操作ボタンにしない。viewer・editor・administrator・owner・archivedで実行できない操作を勧めない。スマートフォンで概要が短く、設定へ2操作以内で到達できる。
- **04**: 状態色・タイポグラフィ・動きが上記の方針に沿い、`prefers-reduced-motion`・keyboard focus・コントラストを確認する。
- **05**: 空・読込・失敗・404が上記の方針に沿い、権限と接続状況に応じた案内を出す。
