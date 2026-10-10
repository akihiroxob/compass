# Outcome・成功条件の現行仕様

OutcomeはIntentへ近づくために実現する観測可能な状態。Directionが所有する。型は [Outcome.ts](../packages/direction/src/domain/Outcome.ts)、入力規則は [outcomeSchema.ts](../packages/direction/src/application/outcomeSchema.ts)。

## 項目と固定条件

Workspace / IntentのID、title、description、任意のhypothesis、rationale、status、cancelReason、successCriteria、任意のoriginDecisionId、作成更新日時を持つ。

- title: 必須、100文字まで。
- description / rationale: 必須、各2,000文字まで。
- hypothesis: 任意、2,000文字まで。
- successCriteria: 1〜10件。各descriptionは500文字、measurementは1,000文字、任意のtargetは200文字まで。

作成後のdescription / rationale / successCriteriaは固定。active時にtitle / hypothesisだけ変更できる。取消には理由が必要。Intentがactiveでない場合やWorkspaceがarchivedの場合は書込を拒否する。

OutcomeとIntentのWorkspace一致をRepositoryとDBの複合FKで強制する。成功条件は`outcome_id`で同じOutcomeへ結び付ける。

保存・application use case・公開入口はWorkspace単位。Web APIは`/api/workspaces/:workspaceId/intents/:intentId/outcomes…`（Workspace Membership）、MCP toolは`workspaceId`（Workspace Strategist Grant）を受け取り、Project IDをWorkspace IDとして受け付けない。応答は`workspaceId`を返し、`projectId`は持たない。Workspace ownerがWorkspaceをarchiveすると、書込は`CONFLICT`（`workspaceStatus: archived`）になる。Projectのarchiveでは変わらない。

## 操作と評価

HumanはWeb UIから、Agentはstrategist GrantでMCPから操作する。主要toolは`create_outcome` / `list_outcomes` / `get_outcome` / `update_outcome` / `cancel_outcome`と、Decisionを伴う`decide_next_outcome`。

`decide_next_outcome`も、Outcome・成功条件・Decision・Activity・Runtime eventを保存するtransaction内で所属Workspaceのarchiveを検査する。WorkspaceだけarchivedでProjectがactiveでも`CONFLICT`（`workspaceStatus: archived`）を返し、部分保存を残さない。

WorkのStoryはOutcomeを参照し、作成時の成功条件等をsnapshotとして持つ。WorkによるTask受入はOutcome達成を意味しない。

現在のEvaluationはevaluator Grantを持つAgentが全Criterionを`met` / `not_met` / `insufficient_evidence`で判定する。評価できるのは全Target ProjectからSummaryが還流し`incomplete`が無いOutcomeだけで、`met` / `not_met`にはいずれかのTargetが還流したEvidence参照が必要。総合結果は全件metならachieved、not_metがあればfailed、それ以外はinsufficient_evidenceとして導出する。

Evaluation保存はOutcomeのstatusを変更しない。StrategistはEvaluationを根拠に次Outcome・追加調査・Intent完了等を判断する。実Agentによる自律運転は未検証。
