# Runtime Role

## Goal

外部 Runtime が、Compass の確定イベント（Runtime event）を取得し、Researcher・Strategist・Manager などの Agent を起動して、処理結果を `ack` で残す。Compass は Agent を起動せず、polling・timeout・retry の間隔・backoff・token 予算も持たない。これらは Runtime の責務である。`runtime` Role は Agent の権限ではなく、Runtime がこの入口を使ってよいという暫定の認可である（Runtime 専用 Credential の導入で置き換える予定）。

## 認証

- `Authorization: Bearer <RuntimeName>` の値が consumer になる。consumer ごとに処理結果（ack）が独立して記録される。別 consumer の ack は互いに影響しない
- 対象 Project の `runtime` Grant が必要。無ければ `FORBIDDEN`、Bearer が無ければ `UNAUTHENTICATED` になる。別 Project へ切り替えて回避しない

## イベントの取得

MCP `fetch_runtime_events({ projectId, afterCursor?, limit? })`、または Web API `GET /api/projects/:projectId/runtime-events?afterCursor=&limit=` を使う。応答は `{ events, nextCursor, resumeCursor }`。

- `events` は cursor 昇順で、その consumer にとって未処理のもの（ack が無い、または `retryable_failure`）だけ。`processed` / `terminal_failure` は返らない
- 取得は状態を変えない。応答が失われても、同じ条件で取得し直せば同じイベントが返り、欠落しない
- 配送は at-least-once。同じイベントを複数回受け取り得るため、イベントの `id` で重複を判定し、`ack` 済みの結果と突き合わせて二重に Agent を起動しない
- `nextCursor` は同じ取得周回で次のページへ進むためだけに `afterCursor` へ渡す。未 ack・`retryable_failure` のイベントを追い越すため、永続化しない
- 再起動後の再開位置として永続化するのは `resumeCursor` だけ。その consumer にとって、それ以下のイベントがすべて `processed` / `terminal_failure` である最大の cursor で、未確定のイベントを追い越さない。再起動後は `afterCursor: resumeCursor` から取得すれば欠落しない。cursor を失った場合は `afterCursor: 0` から取得し直してよい（確定済みは返らない）
- `limit` は 1〜500（既定 100）

## イベントの種類と反応

| `type` | 意味 | Runtime の動き |
| --- | --- | --- |
| `research_requested` | Research Request が確定した | `researchRequestId` を渡して Researcher を起動する |
| `research_completed` | Request が `completed` / `insufficient` / `not_needed` で確定した（`conclusion`） | `projectId`・`intentId` を渡して Strategist を起動する |
| `outcome_confirmed` | Outcome（固定の Success Criteria を含む）が確定した（`create_outcome` / `decide_next_outcome`） | `projectId`・`intentId`・`outcomeId`・`correlationId` を渡して Manager を起動する。Manager が `issue_story` で Outcome を参照する Story を作る（`agent/manager.md`） |
| `outcome_evaluated` | Outcome Evaluation が確定した（`record_outcome_evaluation`。結果によらず 1 Evaluation につき 1 件） | `projectId`・`intentId`・`outcomeId`・`evaluationId` を渡して Strategist を起動する。Strategist が Evaluation を根拠に再計画（次の Outcome・追加 Research）か Intent 完了を判断する（`agent/strategist.md`） |

各イベントは `id`・`version`・`type`・`projectId`・`intentId`（`project_watch` では `null`）・`researchRequestId`・`outcomeId`・`correlationId`・`conclusion`・`occurredAt`・`cursor` を持つ。`researchRequestId` は research 系のイベントだけ、`outcomeId` は `outcome_confirmed` / `outcome_evaluated` だけ、`evaluationId` は `outcome_evaluated` だけが値を持ち、他は `null`。`outcome_confirmed` / `outcome_evaluated` の `correlationId` は `outcome:<outcomeId>` で、Manager の `issue_story` が使う既定の相関 ID と同じ。再試行中のイベントには `retryCount`（`retryable_failure` を記録した回数）と `lastFailureReason` が付く。`version` が未知の値のイベントは処理せず、`terminal_failure` で理由を残す。

## 処理結果の記録

MCP `ack_runtime_event({ projectId, eventId, attemptId, outcome, reason? })`、または Web API `POST /api/projects/:projectId/runtime-events/:eventId/ack`（本文 `{ attemptId, outcome, reason? }`）を使う。`attemptId` はそのイベントを処理する 1 回の試行ごとに Runtime が生成する値（UUID など）。

| `outcome` | 意味 | `reason` | 以後の取得 |
| --- | --- | --- | --- |
| `processed` | 起動条件を満たして処理を引き受けた | 受け付けない | 返らない |
| `retryable_failure` | 今回は処理できなかったが、再試行してよい | 必須 | 返り続ける（`retryCount` が増える） |
| `terminal_failure` | 再試行しても成功しない | 必須 | 返らない（理由は残る） |

- 応答が失われたら、同じ `attemptId` で同じ `ack` を再送する。初回の結果が返り、状態は変わらない（`recorded: false`。`retryCount` も増えない）。同じ `attemptId` で別の結果・理由を送ると `CONFLICT`
- 次の試行（再試行）では新しい `attemptId` を使う。`retryCount` は `attemptId` の異なる `retryable_failure` だけを数える
- 確定済み（`processed` / `terminal_failure`）のイベントに同じ結果を送り直しても状態は変わらない（`recorded: false`）
- `processed` / `terminal_failure` 済みのイベントに別の結果を送ると `CONFLICT`。`retryable_failure` からはどの結果へも進める
- 別 Project のイベントは `NOT_FOUND`。`retryable_failure` を送り続けても上限は Compass にない。再試行の上限と間隔は Runtime が決め、超えたら `terminal_failure` で理由を残す

## Manager 起動後の扱い（`outcome_confirmed`）

- Compass は Story も Manager も自動では作らない。Runtime が Manager を起動し、Manager が MCP の `issue_story` で Story を作る
- Manager の起動が timeout したり応答が失われたりしたら、同じ `outcomeId` で Manager を再起動してよい。同じ `correlationId` の Story は Project 内で 1 件に収束するため、二重に作られない
- Manager が `NOT_FOUND`（Outcome が Project に無い）・`CONFLICT`（Outcome が取消済み、または Project が archived）を報告した場合、再試行しても成功しない。`terminal_failure` で理由を残す。`UNAUTHENTICATED` / `FORBIDDEN` は Grant を直してから再試行する（`retryable_failure`）
- Execution の進行（Story / Task / Claim の変化）は、Runtime が MCP `list_changes` の `nextCursor` を保持して増分取得する。これは Runtime event の ack とは別の仕組みで、Compass は Change の配送を記録しない

## Execution の結果の還流（Evidence）

Execution の進行を Direction（Outcome）へ還流するのは Runtime の責務。Compass は還流を起動しない。

1. `list_changes({ projectId, afterCursor })` で Change を増分取得し、`nextCursor` を保持する。Story・Task の変更は、Outcome に相関付く場合 `outcomeId` / `correlationId` を持つ
2. 変更のあった `outcomeId` ごとに `record_execution_evidence({ projectId, outcomeId, changeCursor, evidence? })`（Web API: `POST /api/projects/:projectId/outcomes/:outcomeId/execution-evidence`）を呼ぶ。`changeCursor` は読んだところまでの `nextCursor`
3. `evidence` は参照だけ。`{ kind: commit | pull_request | repository_file | ci | issue | url, uri, versionHash?, observedAt }`。`uri` は認証情報を含まない http(s)、`versionHash` は完全な 40 桁の commit SHA（`commit` は必須）、`observedAt` は未来でない epoch ミリ秒。Evidence 本文は渡さない・保存されない。実在しない参照を作らない

- 応答の `summary.state` は Compass が Execution の現在の状態から導出した `accepted` / `rejected` / `canceled` / `incomplete`。Runtime が状態を指定することはできない。`accepted` は Success Criterion を満たしたことを意味しない（判定は Evaluation）
- 同じ通知・同じ Evidence の再送は重複しない（`recorded.evidenceAdded: 0`）。応答が失われたら同じ内容を再送してよい。古い `changeCursor`（順序逆転）は状態を巻き戻さず、現在の状態が返る（`recorded.staleInput: true`）。Runtime 再起動後は保持した cursor（失った場合は 0）から再取得して再送してよい
- `NOT_FOUND`（別 Project・存在しない Outcome）、`CONFLICT`（Story 未着手 `reason: no_correlated_story`・取消済み Outcome・archived Project・Evidence 上限 200 件）、`VALIDATION_ERROR`（不正な URI / SHA / 時刻、Change Log より先の `changeCursor`）。未着手の `CONFLICT` は Manager の `issue_story` 後に再試行できる。それ以外は再試行しても成功しないため、理由を残して打ち切る
- 還流済みの内容は `get_outcome_execution_summary({ projectId, outcomeId })` で確認できる（未還流は `record: null`）
- どちらも `runtime` Grant が必要

## やらないこと

- Agent の起動状況・Run の生存を Compass に登録すること（Compass は Run を持たない）
- Outcome・Direction Decision・Research の内容を決めること
- 自分の権限（Grant）を増やすこと

## Evaluation 後の扱い（`outcome_evaluated`）

- Compass は Strategist を起動せず、次の Outcome も Intent の完了も自動では決めない。Runtime が Strategist を起動し、Strategist が `evaluationId` を根拠に `decide_next_outcome` / `create_direction_decision` で判断する
- Strategist の起動が timeout したり応答が失われたりしたら、同じ `evaluationId` で再起動してよい。1 つの Evaluation を根拠にできる Decision は 1 件だけなので、再計画や Intent 完了は二重にならない（2 件目は `CONFLICT`）
- 同じ Outcome の再評価はイベントを追加する。古い Evaluation を根拠にした判断は `CONFLICT`（`evaluation_not_latest`）になるため、古いイベントは Strategist が何もせず終えてよい（`processed`）
- Intent が達成済み・中止済みなら、Evaluation 自体が保存されず（`CONFLICT`）イベントも作られない
