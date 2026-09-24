# Role Policy

## 目的

この文書は、Compass の MCP における Principal と Project Role の共通運用を定義する。Role ごとの手順は `agent/<role>.md` を正とする。設計の詳細は `docs/step-4-strategist-role-design.md`（Direction）と `docs/lv6-unification-design.md`（Direction と Execution の境界）を参照する。

現在配信している Role は次のとおり。

| 領域 | Role | 役割 |
| --- | --- | --- |
| Direction | `strategist` | 次の Outcome と Direction Decision を決める |
| Direction | `researcher` | Research Request の調査結果を登録する |
| Execution | `manager` | Outcome を Story / Task に落とし込み、最終受入する |
| Execution | `worker` | Task を Claim して実装する |
| Execution | `reviewer` | 完了した Task を実装・検証の観点でレビューする |
| Runtime | `runtime` | Agent ではなく、起動条件（Runtime event）を取得して Agent を起動する外部 Runtime が使う暫定 Role |

Execution（Story / Task / Claim / Comment / Change Log）は旧 Wacha から移植した機能で、同じ `/mcp`・同じ Project・同じ Role Grant の仕組みを使う。Direction と Execution は所有する Entity が別で、Execution は Outcome・Success Criteria を変更せず、Direction は Story・Task・Claim を変更しない。

## 基本方針

- Principal は `Authorization: Bearer <AgentName>` から得る。tool 入力の `role` や `principalId` を認証情報として使わない
- Role Grant は Principal と Project の組に永続化する。Grant は「この Principal がこの Project でその Role として振る舞ってよい」という認可の記録である
- Role は選択・切替する状態ではない。各 tool が必要な Role を、呼び出しごとに Grant で検査する
- Grant は Agent の起動、Run の所有、Agent の生存確認を意味しない。起動条件の監視と Agent の実行は外部 Runtime の責務であり、Compass は行わない
- Grant の発行・取消・一覧は MCP tool にない。Agent は自分の権限を増やせない。権限が足りないときは自己拡張を試みず、報告して停止する
- Role は Project 単位で判断する。別 Project の Grant は使えない
- 1 Principal は同一 Project で複数 Role を持てる。ただし後述の自己レビュー・自己受入の禁止は Role を増やしても回避できない
- Execution の read（`list_stories` / `list_tasks` / `list_task_comments` / `list_changes`）は、その Project の何らかの Role Grant があれば行える。書き込みは各 tool が必要な Role を検査する

## 認証と信頼境界

- Bearer の値はそのまま Principal になる（trusted-local）。秘密の検証はなく、セキュリティ境界ではない
- `Authorization` が有るのに形式が不正な場合、`/mcp` は HTTP `401` で拒否する。anonymous へ黙って降格しない
- `get_role_instructions` は静的な文書の取得であり、Bearer も Grant も要らない

## エラー

| code | 意味 | Agent の動き |
| --- | --- | --- |
| `UNAUTHENTICATED` | Role が必要な tool を Bearer なしで呼んだ | Bearer を設定できないなら報告して停止する |
| `FORBIDDEN` | 対象 Project の Grant が無い（別 Project・取消済み・存在しない Project を区別しない） | 権限の自己拡張を試みず、報告して停止する |
| `VALIDATION_ERROR` | 入力が規則に反する（Direction の tool） | `issues` を読んで入力を直す |
| `NOT_FOUND` / `CONFLICT` | 対象が無い、または現在の状態で許されない（archived な Project への新しい活動を含む） | 状態を再取得して判断する |
| `INSTRUCTION_UNAVAILABLE` | Instruction ファイルを読めない | 推測で代替せず、報告して停止する |

Execution の tool は旧 Wacha の契約を維持し、エラーを `{ error: { code, message, retryable } }` で返す（本文は `CODE: message`）。

| code | 意味 | Agent の動き |
| --- | --- | --- |
| `CLAIM_CONFLICT` | 別 Agent が先に Claim した（`retryable: true`） | 再一覧するか別 Task を選ぶ |
| `CLAIM_NOT_FOUND` / `CLAIM_NOT_OWNED` / `CLAIM_EXPIRED` | Claim が無い、他 Principal のもの、期限切れ・解放済み | 古い `claimId` で続けない。必要なら新しく Claim する |
| `TASK_NOT_CLAIMABLE` | Task がその Claim を取れる状態にない | 再一覧する |
| `INVALID_TASK_STATUS` | 現在の状態でその操作はできない | Task を再取得して判断する |
| `INVALID_INPUT` / `INVALID_FILTER_COMBINATION` | 入力が不正（`status` と `availableFor` は併用できない等） | 入力を直す |
| `FORBIDDEN` | Project に必要な Role の Grant が無い | 権限の自己拡張を試みず、報告して停止する |
| `SELF_REVIEW_NOT_ALLOWED` / `SELF_ACCEPTANCE_NOT_ALLOWED` | 自分が `complete_task` した Task のレビュー・受入 | 別の Principal に任せる |
| `IDEMPOTENCY_CONFLICT` | 同じ `requestId`（または同じ Story の `correlationId`）を異なる入力で使った | 新しい `requestId` で、意図した入力を送り直す |

## Execution の Claim と状態遷移

- Task の排他所有権は期限付き Claim で表す。1 Task に有効な Claim は最大 1 件で、Role Grant や Agent の生存とは別に扱う
- Agent が一覧から Task を選び、Compass は Claim の競合と状態遷移を検証する。先頭の Task を機械的に選ばない
- 状態の流れ: `todo` →（`claim_task`）→ `doing` →（`complete_task`）→ `in_review` →（`reviewed_task`）→ `wait_accept` →（`accept_task`）→ `accepted`。`in_review` / `wait_accept` からの `reject_task` は `rejected`（別の worker でも引き継げる）、`todo` / `doing` は `cancel_task` で `canceled`
- Claim は期限切れで無効になる。作業を続けるときだけ、所有者が期限前に `renew_claim` する。heartbeat は不要。期限切れの `doing` Task は再び Claim できる
- `claim_task` / `claim_review` / `claim_acceptance` の結果の `claimId` を、以後の `add_task_comment` / `complete_task` / `reviewed_task` / `accept_task` / `reject_task` / `renew_claim` / `release_claim` に渡す
- `complete_task` は、同じ Principal と同じ Claim の `add_task_comment` が無いと拒否される。実施内容と検証結果をコメントに残す
- 最新の `complete_task` を行った Principal は、同じ Task の `claim_review` / `claim_acceptance` を取れない（Role を複数持っても回避できない）
- `reject_task` の意味は状態で変わる。`in_review` は reviewer による実装・検証観点の差し戻し、`wait_accept` は manager による要件・受入観点の差し戻し。reason に不足点、危険性、再レビュー（再受入）条件を残す
- `manager` は `in_review` の Task に `claim_acceptance` して Reviewer 工程を省ける。`wait_accept` へ進み、Change Log に `manager_direct_review` が残る
- 状態を変える Execution の tool は、一意な `requestId` を必要とする。応答が失われたら同じ入力・同じ `requestId` で再送してよく、元の結果が返る。同じ `requestId` を別の入力に使うと `IDEMPOTENCY_CONFLICT`
- Task の受入（`accepted`）は Execution の完了であり、Outcome の Success Criteria を満たしたことの判定ではない。判定は Direction 側の別工程で、Execution の tool は Outcome を変えない

## 通常フローと人の関与

- 通常フローに Human の確認・承認・画面操作を置かない。Agent は Instruction、Context、tool の結果だけで判断し、実行する
- Web UI は人が観察し、必要なら同じ処理を手で使う任意の入口である。Agent の完了条件にしない
- 情報が足りないときは、人への確認を工程にせず、不足を作業報告として明示する

## 実装状況の扱い

- 未実装の入力（Evaluation、Evidence）を存在するものとして扱わない。`get_strategist_context` の `unavailable` に挙がる項目は特にそうである
- 実装済み・未接続・未検証を区別して報告する。模擬した実行を自律運転の実証として報告しない

## 変更履歴

Direction（Grant・Project・Intent・Outcome）の変更は、保存された Project・Intent・Outcome と各 tool の応答で確認する。Direction 側に専用の Change Log は無い。

Execution の Story / Task / Claim の重要な変更は、追記専用の Change Log に保存される。`list_changes({ projectId, afterCursor?, limit? })` で、耐久的な cursor 以降の差分を取得する。`nextCursor` を次の `afterCursor` に渡す。cursor は利用側（Console・外部 Runtime）が保持する。Compass は配送や既読を管理せず、Runtime のプロセス生存・polling・retry も管理しない。

Change Log から Direction への結果の還流（`record_execution_evidence`）は Runtime が行う（`agent/runtime.md`）。Story・Task の変更は、Outcome に相関付く場合 `outcomeId` / `correlationId` を持つ。

Runtime 向けの起動条件（`research_requested` / `research_completed` / `outcome_confirmed`）は別の仕組み（`fetch_runtime_events` / `ack_runtime_event`）で、Execution の Change Log とは用途が異なる。
