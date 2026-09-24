# Runtime Role

## Goal

外部 Runtime が、Compass の確定イベント（Runtime event）を取得し、Researcher・Strategist などの Agent を起動して、処理結果を `ack` で残す。Compass は Agent を起動せず、polling・timeout・retry の間隔・backoff・token 予算も持たない。これらは Runtime の責務である。`runtime` Role は Agent の権限ではなく、Runtime がこの入口を使ってよいという暫定の認可である（Runtime 専用 Credential の導入で置き換える予定）。

## 認証

- `Authorization: Bearer <RuntimeName>` の値が consumer になる。consumer ごとに処理結果（ack）が独立して記録される。別 consumer の ack は互いに影響しない
- 対象 Project の `runtime` Grant が必要。無ければ `FORBIDDEN`、Bearer が無ければ `UNAUTHENTICATED` になる。別 Project へ切り替えて回避しない

## イベントの取得

MCP `fetch_runtime_events({ projectId, afterCursor?, limit? })`、または Web API `GET /api/projects/:projectId/runtime-events?afterCursor=&limit=` を使う。応答は `{ events, nextCursor }`。

- `events` は cursor 昇順で、その consumer にとって未処理のもの（ack が無い、または `retryable_failure`）だけ。`processed` / `terminal_failure` は返らない
- 取得は状態を変えない。応答が失われても、同じ条件で取得し直せば同じイベントが返り、欠落しない
- 配送は at-least-once。同じイベントを複数回受け取り得るため、イベントの `id` で重複を判定し、`ack` 済みの結果と突き合わせて二重に Agent を起動しない
- `nextCursor` を次の `afterCursor` に渡すと、すでに取り出したイベントの後から続けられる。Runtime が再起動して cursor を失った場合は `afterCursor: 0` から取得する。ack 済みのものは返らないため、欠落も再起動もない
- `limit` は 1〜500（既定 100）

## イベントの種類と反応

| `type` | 意味 | Runtime の動き |
| --- | --- | --- |
| `research_requested` | Research Request が確定した | `researchRequestId` を渡して Researcher を起動する |
| `research_completed` | Request が `completed` / `insufficient` / `not_needed` で確定した（`conclusion`） | `projectId`・`intentId` を渡して Strategist を起動する |

各イベントは `id`・`version`・`type`・`projectId`・`intentId`（`project_watch` では `null`）・`researchRequestId`・`correlationId`・`conclusion`・`occurredAt`・`cursor` を持つ。再試行中のイベントには `retryCount`（`retryable_failure` を記録した回数）と `lastFailureReason` が付く。`version` が未知の値のイベントは処理せず、`terminal_failure` で理由を残す。

## 処理結果の記録

MCP `ack_runtime_event({ projectId, eventId, outcome, reason? })`、または Web API `POST /api/projects/:projectId/runtime-events/:eventId/ack`（本文 `{ outcome, reason? }`）を使う。

| `outcome` | 意味 | `reason` | 以後の取得 |
| --- | --- | --- | --- |
| `processed` | 起動条件を満たして処理を引き受けた | 受け付けない | 返らない |
| `retryable_failure` | 今回は処理できなかったが、再試行してよい | 必須 | 返り続ける（`retryCount` が増える） |
| `terminal_failure` | 再試行しても成功しない | 必須 | 返らない（理由は残る） |

- 応答が失われたら同じ `ack` を再送してよい。同じ結果なら状態を変えず、応答の `recorded` が `false` になる
- `processed` / `terminal_failure` 済みのイベントに別の結果を送ると `CONFLICT`。`retryable_failure` からはどの結果へも進める
- 別 Project のイベントは `NOT_FOUND`。`retryable_failure` を送り続けても上限は Compass にない。再試行の上限と間隔は Runtime が決め、超えたら `terminal_failure` で理由を残す

## やらないこと

- Agent の起動状況・Run の生存を Compass に登録すること（Compass は Run を持たない）
- Outcome・Direction Decision・Research の内容を決めること
- 自分の権限（Grant）を増やすこと
