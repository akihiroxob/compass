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
- 開発上の障害（Taskの停止・差戻し等）は課題に含めない。

Outcomeは更新ごとに増える`revision`を持つ。`problems`の更新は一覧全体の置換で`expectedRevision`が必須。古い版は`CONFLICT`（`currentRevision`）で拒否し、成功条件・Target Project・handoffは変更しない。`create_outcome` / `update_outcome` / `get_outcome`（MCP）とWeb UIのOutcome作成・編集・詳細が同じapplication層を使う。

## 操作と評価

HumanはWeb UIから、Agentはstrategist GrantでMCPから操作する。主要toolは`create_outcome` / `list_outcomes` / `get_outcome` / `update_outcome` / `cancel_outcome`と、Decisionを伴う`decide_next_outcome`。

`decide_next_outcome`も、Outcome・成功条件・Decision・Activity・Runtime eventを保存するtransaction内で所属Workspaceのarchiveを検査する。WorkspaceだけarchivedでProjectがactiveでも`CONFLICT`（`workspaceStatus: archived`）を返し、部分保存を残さない。

WorkのStoryはOutcomeを参照し、作成時の成功条件等をsnapshotとして持つ。WorkによるTask受入はOutcome達成を意味しない。

現在のEvaluationはevaluator Grantを持つAgentが全Criterionを`met` / `not_met` / `insufficient_evidence`で判定する。評価できるのは全Target ProjectからSummaryが還流し`incomplete`が無いOutcomeだけで、`met` / `not_met`にはいずれかのTargetが還流したEvidence参照が必要。総合結果は全件metならachieved、not_metがあればfailed、それ以外はinsufficient_evidenceとして導出する。

Evaluation保存はOutcomeのstatusを変更しない。StrategistはEvaluationを根拠に次Outcome・追加調査・Intent完了等を判断する。実Agentによる自律運転は未検証。
