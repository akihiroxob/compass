# Outcome・成功条件の現行仕様

OutcomeはIntentへ近づくために実現する観測可能な状態。Directionが所有する。型は [Outcome.ts](../packages/direction/src/domain/Outcome.ts)、入力規則は [outcomeSchema.ts](../packages/direction/src/application/outcomeSchema.ts)。

## 項目と固定条件

Workspace / IntentのID、title、description、任意のhypothesis、rationale、status、cancelReason、successCriteria、任意のoriginDecisionId、作成更新日時を持つ。

- title: 必須、100文字まで。
- description / rationale: 必須、各2,000文字まで。
- hypothesis: 任意、2,000文字まで。
- successCriteria: 1〜10件。各descriptionは500文字、measurementは1,000文字、任意のtargetは200文字まで。

作成後のdescription / rationale / successCriteriaは固定。active時にtitle / hypothesis / problemsだけ変更できる（Target Projectは別操作）。取消には理由が必要。Intentがactiveでない場合やWorkspaceがarchivedの場合は書込を拒否する。

OutcomeとIntentのWorkspace一致をRepositoryとDBの複合FKで強制する。成功条件は`outcome_id`で同じOutcomeへ結び付ける。

保存・application use case・公開入口はWorkspace単位。Web APIは`/api/workspaces/:workspaceId/intents/:intentId/outcomes…`（Workspace Membership）、MCP toolは`workspaceId`（Workspace Strategist Grant）を受け取り、Project IDをWorkspace IDとして受け付けない。応答は`workspaceId`を返し、`projectId`は持たない。Workspace ownerがWorkspaceをarchiveすると、書込は`CONFLICT`（`workspaceStatus: archived`）になる。Projectのarchiveでは変わらない。

## 課題・根拠・解決策の仮説

Outcomeは0〜10件の課題（Problem Statement）を持つ。独立したEntityや承認工程は無く、Outcomeの一部として保存し、`outcome_problem`（`outcome_id`・`position`順）と`outcome_problem_evidence`へ分ける。

- statement: 必須、500文字まで。
- evidenceStatus: `insufficient`（根拠不足）/ `observed`（観測済み）/ `refuted`（反証）。
- observation（観測した事実）、causeHypothesis（原因の仮説）、solutionHypothesis（解決策の仮説）: 各任意、2,000文字まで。観測と原因は別の項目で、原因を確定する状態は持たない。`observed` / `refuted`はobservationと1〜10件の根拠参照が必須。
- evidence: 同じWorkspaceのResearch Finding（`research_finding`）またはSynthesis（`research_synthesis`）をIDで参照する。本文は複製せず、読取時にrequestId・要約・`superseded`を参照先から解決する。別Workspaceの参照は`VALIDATION_ERROR`（複合FKでも強制）、後続版に置き換えられたSynthesisの新規関連付けは`CONFLICT`（既存の関連付けは`superseded`表示で残る）。
- evaluationPlan（評価計画）: 任意。question（確かめたい問い、必須、500文字まで）・method・premises（適用前提）・observationPeriod（観測期間）・decisionCriteria（判断条件、必須）・stopCriteria（中止条件）。`outcome_problem.evaluation_plan`へJSONで保存する。methodは`cognitive_walkthrough` / `quantitative_observation` / `ab_test` / `difference_in_differences` / `other`で、`ab_test`・`difference_in_differences`は適用前提が必須（前提の記載だけを検査し、統計解析・Success Metrics・必須インタビューは扱わない）。計画は内容を識別するサーバー採番の`planId`を持ち、内容が同じ更新では保たれ、追加・差替え・内容変更では新しくなる（外して再追加しても再利用しない）。Evaluationは入力の`planIds`（課題id→評価者が読んだ`planId`）を`problem_plans`へ保存する。保存時の現在の`planId`と違えば`CONFLICT`（`evaluation_plan_changed`）で拒否し、現在の計画を黙って採用しない。`planIds`は再送の同一性に含める、過去の結果は削除・書換えしない。計画は結果ではなく、現在の`planId`を対象にしたEvaluationが無い間は「未実施」と表示し、変更前の計画への評価だけがある場合は未実施と旧計画への結果を区別して示す。評価待ちを自動でHuman待ちにしない。
- 開発上の障害（Taskの停止・差戻し等）は課題に含めない。

Outcomeは更新ごとに増える`revision`を持つ。`problems`の更新は一覧全体の置換で`expectedRevision`が必須。古い版は`CONFLICT`（`currentRevision`）で拒否し、成功条件・Target Project・handoffは変更しない。`create_outcome` / `update_outcome` / `get_outcome`（MCP）とWeb UIのOutcome作成・編集・詳細が同じapplication層を使う。

## 操作と評価

HumanはWeb UIから、Agentはstrategist GrantでMCPから操作する。主要toolは`create_outcome` / `list_outcomes` / `get_outcome` / `update_outcome` / `cancel_outcome`と、Decisionを伴う`decide_next_outcome`。

`decide_next_outcome`も、Outcome・成功条件・Decision・Activity・Runtime eventを保存するtransaction内で所属Workspaceのarchiveを検査する。WorkspaceだけarchivedでProjectがactiveでも`CONFLICT`（`workspaceStatus: archived`）を返し、部分保存を残さない。

WorkのStoryはOutcomeを参照し、作成時の成功条件等をsnapshotとして持つ。WorkによるTask受入はOutcome達成を意味しない。

現在のEvaluationはevaluator Grantを持つAgentが全Criterionを`met` / `not_met` / `insufficient_evidence`で判定する。評価できるのは全Target ProjectからSummaryが還流し`incomplete`が無いOutcomeだけで、`met` / `not_met`にはいずれかのTargetが還流したEvidence参照が必要。総合結果は全件metならachieved、not_metがあればfailed、それ以外はinsufficient_evidenceとして導出する。Evaluationは`method`・`targetVersion`（評価した対象の版）・`limitations`（限界）を必須で保存し、評価対象の課題（`problemIds`、このOutcomeの課題だけ）を任意で持つ。`cognitive_walkthrough`は設計の点検で実ユーザーの証拠ではないため、Criterionを`met`とは判定できない（`VALIDATION_ERROR`）。根拠が不足する場合は`insufficient_evidence`（判断不能）で保存し、Taskの受入・公開を効果達成として扱わない。

Evaluation保存はOutcomeのstatusを変更しない。StrategistはEvaluationを根拠に次Outcome・追加調査・Intent完了等を判断する。実Agentによる自律運転は未検証。

## Task進捗と問題の集計（Outcome一覧・詳細）

Workspaceの固定メニュー「Outcome」の一覧（`GET /api/workspaces/:workspaceId/outcomes`）と詳細（`GET .../outcomes/:outcomeId/overview`）は、Directionの`ListWorkspaceOutcomesUseCase` / `GetWorkspaceOutcomeOverviewUseCase`が同じ組み立てで返す。Workspace Membership（viewer以上）で認可し、Story・Task本文はDirectionへ複製しない。

**Task進捗の集計規則**（`packages/direction/src/domain/OutcomeProgress.ts`）:

- 対象はOutcomeのTarget Projectのうち、Outcomeへ相関付いた（`outcome_ref`）StoryのTask。Outcome未設定のStory・Task、Target外のProjectのStoryは数えない。複数ProjectのTaskは合算し、Project別の内訳も返す。
- 分子は受入済み（`accepted`）、分母は取消（`canceled`）を除いたTask数。取消は分母に含めず`canceled`として別に返し、総数（`total`）は分母＋取消。未完了（todo・doing・in_review・wait_accept・rejected）は分母に含まれる。
- 分母が0なら割合（`ratio`）は`null`で、0%や完了にしない。`kind`で区別する: `no_target`（Target未設定）、`not_planned`（Targetはあるが相関付いたStoryが無い＝未起票）、`no_countable_tasks`（StoryはあるがTaskが0件、または全て取消）、`counted`（分母1件以上）。集約では、未起票のProjectは分母に寄与せず`unplannedProjectCount`で示す。
- 検索・ビジネス目標・問題の有無・ページングは表示するOutcomeを選ぶだけで、集計の分母を変えない。
- 割合はTask進捗であり、Outcomeの達成度・効果ではない。提供状況（公開）と効果の確認（Evaluation）は別の事実として扱う。

**提供状況と効果の確認状況**（`delivery` / `effect`）: Task進捗とは別の項目として、一覧・詳細が同じ集計で返す。提供状況（公開）はWorkの公開記録（[ADR 0009](adr/0009-publication-confirmation.md)・Project `releases`と同じ判定）から、Target ProjectのうちOutcomeに相関付いたStoryの変更（PR登録または受入成果物のあるTask）ごとに数える。`tracked`は変更数と公開済み・未公開・確認できずの件数（入力元の未設定は確認できずの内数`notConfigured`）、`no_changes`は公開確認の対象になる変更が無いこと、`unknown`はいずれかのTarget Projectの公開確認を取得できなかったこと（記録なし・変更なしとは別）を表す。Outcome全体が提供済みかは判断せず、起票前の作業や記録の不存在を断定しない。Task受入・還流・PRマージ・効果を公開として扱わない。効果は最新のOutcome Evaluationの結果だけから決め、`not_evaluated`（評価なし）、`evaluated`（`achieved` / `failed` / `insufficient_evidence`と評価日時）、`unknown`（評価を取得できない）を区別する。Task進捗や還流から効果を推測しない。

**問題**: 開発を止めているのは、Human待ち（`waiting_human`）とAgentが対処する（`waiting_agent`）相談。Outcomeとの関連は構造化された参照だけで決める — Target ProjectのOutcome相関Storyに属するTaskが待つ相談（`task_consultation_wait`）、そのStory・Taskを参照するProject相談、Outcomeを参照するWorkspace相談。題名・理由の文章一致は使わない。同じ相談は複数のProject・Taskに関わっても相談IDで1件に数える。代表は、Human待ちを優先し、待ちの長い（更新の古い）ものとする。残りは`otherCount`（ほかN件）で示し、詳細は`items`で全件を返す。問題の情報を取得できないときは`unknown`（未取得）とし、`none`（確認できた問題なし）と区別する。`problem=none`の絞り込みは未取得を含めない。

**一覧の問い合わせ**: `q`（Outcome名・説明・貢献仮説・目標名の部分一致）、`intentId`、`problem`（`present` / `none` / `unknown`）、`limit`（1〜100、既定20）、`offset`。新しい順。Web UIは条件をURLのqueryに保持し、詳細から戻るとき同じ条件・ページで開く。MCPの専用toolは追加していない（Agentは既存の`list_outcomes`・`list_outcome_target_work`を使う）。
