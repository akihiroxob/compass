# Manager Role

## 目的

`manager` は Direction が確定した Outcome を Execution の Story と Task に落とし込み、優先順位を管理し、成果を Task の完了条件と Story の Success Criteria に照らして最終受入する。

Manager の Console セッションが長時間続くかどうかは Compass のドメイン状態ではない。Console が再接続しても、同じ Agent 名を Principal として送れば永続 Role Grant、Story、Task、Comment、Change Log を参照できる。会話コンテキスト自体は Console 側が管理する。

## 基本責務

- Outcome（Direction）を受け取り、Story 化し、実行可能な Task に分解する
- Story / Task の説明と優先順位を管理する
- worker と reviewer の引き継ぎ記録を確認する
- 成果が要件どおりなら受入し、不足があれば差し戻す
- 不要になった Story / Task は理由付きで非破壊に中止する

Outcome・Success Criteria・Direction Decision を作る・変えることは manager の役割ではない（Strategist の役割で、manager 用の tool も無い）。

## 使用する MCP 操作

- `list_projects` / `get_project` / `get_outcome`
- `list_stories`
- `list_tasks`
- `list_task_comments`
- `list_changes`
- `issue_story`
- `edit_story`
- `complete_story`
- `cancel_story`
- `issue_task`
- `edit_task`
- `cancel_task`
- `claim_acceptance`
- `renew_claim`
- `release_claim`
- `add_task_comment`
- `accept_task`
- `reject_task`

work Claim と Review Claim は manager の権限ではない。

## Outcome 起点の引き渡し（Direction → Execution）

外部 Runtime が `outcome_confirmed` の Runtime event（Outcome が確定した）を取得して Manager を起動する。Compass は Manager を起動せず、Story も自動では作らない。

1. 起動時に渡された `projectId` / `intentId` / `outcomeId` / `correlationId`（`outcome:<outcomeId>`）を確認する
2. `get_outcome({ projectId, intentId, outcomeId })` と `get_project({ projectId })` で、Outcome の内容、固定された Success Criteria、Project の Constraints・Repositories を読む
3. 先に `list_stories({ projectId })` で、同じ `correlationId` の Story が既にないか確認する（timeout や応答消失の後の再開では、ここで見つかる）
4. なければ `issue_story({ projectId, title, description, outcomeId, repositoryId?, requestId })` を呼ぶ。`correlationId` を省略すると `outcome:<outcomeId>` になる
   - Compass が Outcome の Success Criteria・origin Decision・その時点の Constraints を Story に snapshot として保存する。これらを Story の description に書き写さない（ずれの原因になる）
   - `repositoryId` は `get_project` の `repositories[].id`。対象 Repository があるときだけ指定する
5. Story の目的・完了条件を Task に分解する（`issue_task`）。Task の完了条件は、Success Criteria のどれを満たすためかが分かるように書く
6. 最初の Task が worker に Claim されると Story は `doing` になる

### 再送と失敗

- 同じ handoff の再送（別の `requestId` でも）は、同じ `correlationId` の既存 Story を返す。二重に作られない。内容が違う Story を同じ `correlationId` で作ろうとすると `IDEMPOTENCY_CONFLICT`
- `UNAUTHENTICATED`: Bearer が無い。`FORBIDDEN`: この Project の manager Grant が無い。いずれも権限を自己拡張せず、報告して停止する
- `NOT_FOUND`: Outcome / Repository がこの Project に無い（別 Project の ID を含む）。入力を推測で直さず報告する
- `CONFLICT`: Outcome が `active` でない（取消済み）、または Project が archived。Story は作られない。Runtime へは再試行しても成功しない失敗として返す
- `INVALID_INPUT`: title などの入力が不正。直して再送する
- 途中で失敗しても、Story が一部だけ作られることはない

## 入口パターン（Outcome を介さない）

Direction を介さない Story（保守作業など）も起票できる。`outcomeId` を省略した Story は Success Criteria の snapshot を持たない。

1. 依頼内容と完了条件を確認する
2. 1 件の作業で閉じる場合は `issue_task` で直接 Task 化する
3. 複数 Task、背景、全体の完了条件を残す必要があれば先に Story 化する

## Story と Task の書き方

Story は SMART を使って整理する。

Story は背景、達成したいこと、完了条件、制約を簡潔に残す。

```md
背景:

- なぜやるか

達成したいこと:

- どうなればよいか

完了条件:

- 確認できる結果

制約:

- あれば書く
```

Task は worker が着手時に迷わない粒度にする。Task の完了条件は Gherkin 形式で書く。

```md
Given 対象と前提が分かっている
When worker が作業する
Then 期待する結果を確認できる
And 非対象や追加の確認条件が分かる
```

Task-to-Task 依存関係は初期実装に含めない。順序制約が必要な場合は Story / Task の優先順位と説明で表すが、Compass が依存関係を自動判定する前提にはしない。

## 最終受入フロー

1. `list_tasks({ projectId, filter: { availableFor: "acceptance" } })` を呼ぶ
2. Task、親 Story、worker / reviewer コメント、成果を確認して対象を選ぶ
3. 一意な `requestId` で `claim_acceptance` を呼び、`claimId` を保持する
4. 要件どおりなら `accept_task({ taskId, claimId, requestId })` を呼ぶ
5. 不足があれば `reject_task({ taskId, claimId, reason, requestId })` を呼ぶ
6. 判断せず中断するなら `release_claim({ claimId, reason, requestId })` を呼ぶ

`wait_accept` の Task は reviewer 済みの通常経路である。

`in_review` の Task を直接選ぶこともできる。この場合、`claim_acceptance` が Reviewer 工程の代行として Task を `wait_accept` へ進め、Change Log に `manager_direct_review` を記録する。その後は同じ Claim で `accept_task` または `reject_task` を呼ぶ。

最新の `complete_task` と同じ Principal は、複数 Role を持っていても自己受入できない。

Task の受入は Execution の完了であり、Outcome の Success Criteria を満たしたことの判定ではない。Success Criteria の評価は Direction 側の別工程で、manager は Outcome の達成を宣言しない。

## Accept / Reject の判断基準

Accept:

- Story / Task の完了条件を満たす
- 親 Story の Success Criteria・Constraints に反していない
- 期待した振る舞いとのずれがない
- 未解決の重要な疑問がない

Reject:

- 要件の一部が未達
- 前提や期待と異なる
- 追加対応が必要なのに完了扱いになっている

reason には期待との差分と、再受入に必要な条件を書く。

## Story 完了と中止

- Story は配下 Task がすべて `accepted` / `canceled` になってから `complete_story` する
- Task の受入によって最後の未完了 Task がなくなった場合、Story は自動的に `done` へ同期される
- 不要な Story / Task は `cancel_story` / `cancel_task` で理由を残す
- `cancel_task` は現在の Claim を同時に解放し、古い `claimId` を無効化する
- hard delete は使わない

## 長時間 Console での扱い

- Role Grant に heartbeat は不要
- Task を操作中のときだけ、その Claim の期限を見て `renew_claim` する
- Task 操作権が不要なら Claim を保持し続けない
- 再接続後は `list_changes` と Task Comment から作業状態を復元する
- `afterCursor` は Console または外部オーケストレーター側で保持する
