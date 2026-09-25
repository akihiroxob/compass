# API / Persistence

## APIの基本

HTTP JSON、/api/v1。以下は新規compass向け契約。実装時にOpenAPIまたは同等の機械可読スキーマを出力する。CommandはIdempotency-Key必須、既存集約変更はexpectedVersion必須。UIも同じapplication use caseを利用する。

| 操作 | エンドポイント | 権限 |
|---|---|---|
| Project作成・一覧・取得 | POST /projects、GET /projects、GET /projects/:id | Human、read許可主体 |
| Context更新 | PATCH /projects/:id/context | Human |
| 停止・再開・アーカイブ | POST /projects/:id/pause, /resume, /archive | Human、方針による内部停止 |
| Home取得 | GET /projects/:id/home | read |
| Intent作成・活性化 | POST /projects/:id/intents、POST /intents/:id/activate | Human |
| Intent放棄 | POST /intents/:id/abandon | Human / Strategist |
| Research / Evidence登録 | POST /intents/:id/research、POST /intents/:id/evidence | Researcher / Evaluator（Evidenceのみ） |
| Research確定 | POST /research/:id/complete | Researcher |
| Outcome提案・草稿編集 | POST /intents/:id/outcomes、PATCH /outcomes/:id | Strategist |
| Outcome活性化・取消 | POST /outcomes/:id/activate、/cancel | Strategist |
| 外部実行記録登録 | POST /outcomes/:id/external-execution-records | standaloneの認可された報告主体 |
| 評価確定 | POST /outcomes/:id/evaluations | Evaluator |
| 追加調査・観測要求 | POST /outcomes/:id/research-requests、/observation-requests | Strategist / Evaluator |
| 次方向確定 | POST /intents/:id/next-direction | Strategist |
| 詳細・履歴取得 | GET /intents/:id、/outcomes/:id、/research/:id、/decisions/:id、/evaluations/:id、/evidence/:id | read |
| Project内履歴一覧 | GET /projects/:id/decisions, /learnings, /activity | read |
| Context取得 | GET /outcomes/:id/context、GET /intents/:id/context | role scopeつきread |
| Wacha入力 | POST /integrations/wacha/events | Wacha連携主体 |
| 配送要求取得・確認 | GET /integration-events、POST /integration-events/:id/ack | 配送主体 |
| 待機一覧 | GET /observation-requests?dueBefore=... | Runtime連携主体 |

Outcome活性化CommandはDecision、固定snapshot、OutcomeActivated outboxを一括作成する。固定したexecutionMode=wachaの場合のみExecutionRequestと配送用outboxも作成する。standaloneではWachaへdispatchしない。propose Commandにも初期仮説Decisionを含めて同時保存する。next-directionは参照Evaluation、rationale、alternativesとaction=create_outcome / complete_intent / abandon_intentを受け、Decisionと対象変更を一括保存する。汎用「statusを好きに書き換える」APIは設けない。

Evaluation提出はactiveからevaluatingへの移行と確定を同じCommandで行ってよい。証拠不足時はevaluatingのまま、後日新規Evaluationを追記する。

## エラー

400: 構文・スキーマ不正、401: 未認証、403: 権限不足、404: 認可範囲内に対象なし、409: version / 状態 / 冪等キー衝突、422: 条件不足・不変条件違反、429: 制限。error={code,message,details,correlationId}。秘密や他Projectの情報をdetailsに含めない。

同一キー・同一正規化payloadは初回の応答を再返却。同一キー・異なるpayloadは409。キーのscopeはprincipal + project + operation。DBにrequest hash・結果を保存して再起動後も有効にする。

## テーブルの最小構成

projects、project_context_versions、project_repositories、project_resources、intents、outcomes、success_criteria、research、evidence、decisions、evaluations、evaluation_criterion_results、external_execution_records、execution_links、execution_snapshots、observation_requests、activity、outbox、inbox、idempotency_records。

中心概念と配送用の補助表を混同しない。Research / Decisionの構造化配列はJSONでもよいが、参照IDの存在・所属をapplicationで検証する。コア親子関係にはprojectId込みの外部キーを張る。Evaluation結果は(evaluationId,criterionId)一意。

- active IntentはprojectIdに部分一意制約。
- active / evaluating OutcomeはintentIdに部分一意制約。
- ExecutionLinkはrequestId一意、(outcomeId,outcomeVersion)一意。
- inboxは(sourceSystem,eventId)一意。
- NextDirectionは(sourceEvaluationId, purpose=next_direction)一意とし同じ評価から二重に次Outcomeを生成しない。
- Project Contextの版は(projectId,contextVersion)一意。
- 履歴は通常APIから削除・上書きしない。論理的な訂正を追記する。

## 競合と一貫性

同時活性化・評価・停止は集約versionとトランザクションで直列化する。UPDATE ... WHERE version=expectedVersionで0件なら409。停止とdispatch競合ではProjectを同じトランザクション内で再検証する。送信済み通信は取り消せないので外部停止確認を別途追跡する。

HomeにはasOf、各外部sectionのobservedAtとfreshnessを返す。大量の外部API呼び出しをHome描画時に行わず、保存済み投影を読む。

outbox一覧はconsumerごとのcursorでページングし、ackはconsumer単位に保存する。複数consumerが互いの未配送イベントを消さない。初期版はpollingで十分。未ackイベントは再配送され得るため、受信側冪等性が必須。

## 補助レコードの最小項目

observation_requestsはid、projectId、outcomeId、sourceEvaluationId?、reason、dueAt、status（pending / fulfilled / exhausted）、fulfilledByEvaluationId?を持つ。同じ原因による観測要求は冪等に登録し、独立した新しい要求だけ予算を消費する。fulfilledは新Evidenceに基づく再評価時に設定する。Researchの追加要求はDecision（request_research）とoutboxに保存し、Runtimeが起動を担当する。

execution_linksには固定request payloadとwachaOutcomeId、最終sequence、取消要求時刻・確認時刻を保存する。outboxにはeventId、type、aggregateId、aggregateVersion、payload、occurredAt、correlationId、causationIdを持たせる。Activityのactor / runRefは同じCommandから引き継ぐ。

## 開発と公開の境界

初期開発はlocalhost、単一利用者、fake資格情報でよい。dev認証は明示フラグでのみ有効とし、productionモードでは起動を拒否する。サービスroleはtokenから解決し、リクエスト本文のroleでは権限を付与しない。外部公開・実接続の前に認証、Project scope、CSRF対策（cookie利用時）、秘密情報の管理を接続試験に含める。
