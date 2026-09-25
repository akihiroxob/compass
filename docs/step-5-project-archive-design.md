# Step 5: Project archive 初期設計

> **状態: Step 5 の設計（確定、Task 19）。永続化・use case・Web API・状態ガードは実装済み（Task 20）。Web UI も実装済み（Task 21）。**
> 事前のユーザー確認は設けない。追加資料に定めのない事項は、既存設計との整合、単純さ、将来の変更容易性を基準に初期値を選び、理由を「選択理由と将来変更できる箇所」に記録する。完成後のフィードバックに応じて修正する。

## 根拠資料と優先順位

| 区分 | 資料 | 扱い |
| --- | --- | --- |
| 主根拠 | `AGENTS.md`（Human は Web UI が正規入口、Agent は MCP が正規入口、Human 向け管理操作を MCP へ無条件に公開しない、CLI は保守用途に限る） | 操作主体と公開経路の根拠 |
| 主根拠 | `kit/additional-doc.md` / `kit/additional-doc-2.md` | **archive に関する記述は無い**。責務境界（Direction は Compass、Execution は Wacha）に反しない範囲で本書が初期値を選んだ |
| 補助 | `kit/docs/domain-model.md`「状態遷移 / Project」「API」、`project-model.md`、`autonomy-and-roles.md` | 「active / paused → archived。archived は初期版では復帰不可。削除 API は作らない」「archived では新しい活動を拒否」「理由を監査記録に残す」を採用する。`paused` / `resume`、`/api/v1`、`Idempotency-Key`、`expectedVersion` は採用しない（下記） |
| 既存設計 | `docs/step-1〜4` | Project / Intent / Outcome / Role Grant の現行仕様。Step 1・2 が「archive は未確定」として持ち越した事項を本書で確定する |

補助資料との差異（本書は採用しない）:

- `paused` 状態と `pause` / `resume`。追加資料に根拠がなく、要求は「active → archived」のみ。状態値の予約もしない（Project の `status` は下記の 2 値の check 制約とする。後続で追加するときは table 再作成が必要になる点を「将来変更できる箇所」に記す）。
- `/api/v1` 接頭辞、`Idempotency-Key`、`expectedVersion`。既存 API（`/api/projects/...`）の慣習と、楽観ロックが無い現状（Step 1〜3 の制約）に合わせる。
- `archive_project` を MCP tool として公開すること（`kit/docs/domain-model.md` の tool 一覧）。`AGENTS.md` と本 Task の要件が優先する。

## 責務境界と操作主体

| 主体 | archive に関する操作 | 入口 |
| --- | --- | --- |
| Human | Project を archive する。archived の Project と履歴を参照する | **Web UI → Web API → 共通 application use case**（正規入口。Human 向け機能を CLI / MCP / 直接 DB 操作だけで完結させない） |
| Agent（Strategist 等） | archive しない。archived の Project は参照できるが、変更は拒否される | MCP（読取 tool は不変。**archive / delete / restore に当たる tool を追加しない**） |
| 保守 | archive の CLI コマンドは作らない。既存の `grant` / `revoke` / `grants` は共通 use case 経由のため、archived への `grant` / `revoke` は同じ規則で拒否される | CLI（変更しない） |

- 業務規則（状態遷移・拒否規則）は application 層と Repository の同一 transaction に置く。Web / MCP / CLI の各入口へ重複させない。UI の導線の非表示だけに頼らない。
- 現行の Web API は認証しない（trusted-local、Step 1・4 と同じ）。よって「archive は Human だけ」は**認証ではなく公開経路（MCP と CLI に出さないこと）で担保**する。リモート配置（`AGENTS.md`）の前に Web API の認証が必要になる制約は既存のもので、本書は解消しない。archive の実行者（actor）と理由を記録するのは、Web に Principal が無いため理由と日時までとする。
- Wacha（Execution）には触れない。archive は Wacha の Project・Task・実行中の作業を停止・変更しない。Compass 側の Direction の凍結だけを意味する（`kit/docs/domain-model.md` の「外部実行の停止完了を意味しない」と同じ）。

## 状態と遷移

| 状態 | 意味 |
| --- | --- |
| `active` | 通常の状態。既存の全 Project（移行後を含む）と、新規作成した Project |
| `archived` | 終端。参照専用。新しい活動（変更操作）をすべて拒否する |

| 遷移 | 公開 | 規則 |
| --- | --- | --- |
| 作成 → `active` | 既存どおり | `create_project` / `POST /api/projects` は常に `active` で作る。作成入力に `status` を受け付けない |
| `active` → `archived` | **Web API のみ** | 理由必須。実行時刻を保存する。不可逆 |
| `archived` → `active`（復帰） | **作らない** | API・UI・MCP・CLI のいずれにも無い。誤って archive した場合は新しい Project を作る |
| `archived` → `archived` | 409 | 理由・日時を上書きしない。冪等な成功にはしない（Intent の `abandon` の再実行が 409 なのと同じ） |
| 物理削除 | **作らない（対象外）** | Project も子データも削除する操作・API・tool・CLI を作らない |

- archive は Project の `status` だけを変える。**子データは削除も状態変更もしない**。Intent（`active` / `achieved` / `abandoned`）、Outcome、Success Criterion、Role Grant は archive 前の内容のまま残る。
  - 特に、archive 時点で `active` の Intent は `active` のまま残る（`abandoned` に連動しない）。Intent 自身の状態は「Project が archive された時点で進行中だった」ことを正しく表し、Intent の放棄理由や Outcome の取消履歴を偽造しない。archived の間は Intent / Outcome の変更操作がすべて拒否されるため、`active` のまま動かない。利用側は「Project が archived なら、配下の状態は凍結されている」と解釈する。
  - Role Grant も自動では取り消さない。Grant が残っても、書込は拒否される（下記）。

## 項目

Project へ次を追加する（応答・保存とも）。

| 項目 | 必須 | 規則 |
| --- | --- | --- |
| status | server 管理 | `active` / `archived`。作成・更新の入力からは変更できない |
| archivedAt | server 管理 | archive した時刻（epoch ms）。`active` の間は `null` |
| archiveReason | server 管理 | archive の理由。trim 後 1〜2,000 文字（必須）。`active` の間は `null` |

- archive 時の `updatedAt` は `archivedAt` と同じ値にする（Intent の放棄・Outcome の取消が `updatedAt` を更新するのと同じ）。archived の Project は以後更新されないため、`updatedAt` の降順は archive 日時の降順と一致する。
- `status = 'archived'` と `archivedAt` / `archiveReason` が非 null であることは同値。application 層と repository の 1 箇所（archive 操作）だけがこの 3 項目を書く。
- 入力 schema は `src/shared/projectSchema.ts` に `archiveProjectSchema`（`{ reason }`、`trimmedText("reason", 2_000)` を再利用）と `parseArchiveProjectInput` を追加する。Web API と（将来の）他の入口が同じ検証を使う。
- 既存の Project 応答（Web API・MCP の `get_project` / `list_projects` / `create_project` / `update_project`）は、上記 3 項目を**追加**するだけで、既存項目の名前・型・順序は変えない。

## 操作の分類（archived の Project に対して）

application 層の use case ごとに、archived 時の扱いを次のとおり確定する。

| use case | Web API | MCP tool | CLI | archived 時 |
| --- | --- | --- | --- | --- |
| `ArchiveProjectUseCase`（新規） | `POST /api/projects/:projectId/archive` | **なし** | **なし** | 既に archived なら 409 |
| `CreateProjectUseCase` | `POST /api/projects` | `create_project` | — | 対象外（新規は常に `active`） |
| `ListProjectsUseCase` | `GET /api/projects[?status=]` | `list_projects` | — | **参照可**（下記の絞り込み） |
| `GetProjectUseCase` | `GET /api/projects/:projectId` | `get_project` | — | **参照可**（`status` / `archivedAt` / `archiveReason` を含む） |
| `UpdateProjectUseCase` | `PATCH /api/projects/:projectId` | `update_project` | — | **拒否（409）** |
| `CreateIntentUseCase` | `POST .../intents` | `create_intent` | — | **拒否（409）** |
| `UpdateIntentUseCase` | `PATCH .../intents/:intentId` | `update_intent` | — | **拒否（409）** |
| `AbandonIntentUseCase` | `POST .../intents/:intentId/abandon` | `abandon_intent` | — | **拒否（409）** |
| `ListIntentsUseCase` / `GetIntentUseCase` | `GET .../intents[/:intentId]` | `list_intents` / `get_intent` | — | **参照可** |
| `CreateOutcomeUseCase` | `POST .../outcomes` | `create_outcome` | — | **拒否（409）** |
| `UpdateOutcomeUseCase` | `PATCH .../outcomes/:outcomeId` | `update_outcome` | — | **拒否（409）** |
| `CancelOutcomeUseCase` | `POST .../outcomes/:outcomeId/cancel` | `cancel_outcome` | — | **拒否（409）** |
| `ListOutcomesUseCase` / `GetOutcomeUseCase` | `GET .../outcomes[/:outcomeId]` | `list_outcomes` / `get_outcome` | — | **参照可** |
| `GrantProjectRoleUseCase` | `POST .../grants` | なし（既存） | `grant` | **拒否（409）** |
| `RevokeProjectRoleUseCase` | `DELETE .../grants/:role/:principalId` | なし（既存） | `revoke` | **拒否（409）** |
| `ListProjectGrantsUseCase` | `GET .../grants` | なし（既存） | `grants` | **参照可** |
| `GetStrategistContextUseCase` | — | `get_strategist_context` | — | **参照可**（Strategist Grant が必要な点は不変）。応答の `project.status` が `archived` になる |
| `InstructionService`（`get_role_instructions`） | — | `get_role_instructions` | — | Project に依存しないため対象外 |

- **原則: archived の Project に対して、`ArchiveProject` を含む「書込」は 1 つも成功しない。参照は archive 前と同じく成功する。** 将来 Project 配下に書込操作を追加する場合も、この原則に従う（追加した use case が archived を拒否することを、その Task の受け入れ条件にする）。
- **Human Membership・招待（Step 6）も同じ規則に従う**。招待の発行・取消・受諾、Membership の Role 変更・取消は同一 transaction で拒否する（詳細は `docs/step-6-human-auth-design.md` の状態遷移節）。例外は platform owner による orphan 補完（bootstrap 時と各ログイン時）だけ。
- **Role Grant の取消も拒否する**。「archived は参照専用」を 1 つの規則にし、例外（許可する書込）を作らない。archived の Project に Grant が残っても、書込は拒否され、読取だけが可能なため危険は増えない。取消が必要になった場合の扱いは「将来変更できる箇所」に記す。
- MCP は新しい tool を追加せず、既存の書込 tool が同じ use case 経由で 409 相当の `CONFLICT`（`isError`）を返す。tool の入力 schema は変えない。
- `list_projects`（MCP）は **`active` のみ**を返す。`status` 引数は追加しない。archived の Project は ID を知っていれば `get_project` 等で参照できる。Agent が「新しい作業の対象」を探す入口から archived を外すため。
- `get_strategist_context` は archived でも成功し、応答の `project.status` で archived を判別できる。Instruction 文書（`agent/strategist.md`）の変更は本 Step に含めない（Strategist が `create_outcome` を試みても 409 で拒否され、副作用はない）。

### 拒否の検査位置と優先順位

- 拒否は **書込と同一 transaction の中で `project.status` を検査**して行う。use case の事前確認（`exists` の後）だけに頼ると、確認と書込の間に archive が入った場合に書込が通るため、Repository の書込 transaction 内の検査を本体とする（現行の Intent / Outcome の `not_active` と同じ方式）。better-sqlite3 は単一接続で transaction が直列化されるため、archive と書込は「どちらが先か」で結果が定まり、一部だけ反映される状態は残らない。
- Repository の結果型には、`ProjectNotFound` とは別の「Project が archived」の結果を追加する（名前・形は Task 20 が既存の `{ kind: "..." }` の慣習に合わせて選ぶ）。use case が `ConflictError` へ変換する。
- エラーの優先順位（Step 2・3 の順序に「archived」を加える）:

  1. `401 UNAUTHENTICATED` / `403 FORBIDDEN`（MCP の Role 検査。既存）
  2. `400 VALIDATION_ERROR`（入力検証。存在確認より先）
  3. `404 NOT_FOUND`（Project が無い）
  4. **`409 CONFLICT`（Project が archived）**
  5. `404 NOT_FOUND`（Intent / Outcome が無い）、`409 CONFLICT`（固定項目、Intent / Outcome の状態、Intent の active 重複）

  つまり archived の Project では、存在しない Intent への更新や、固定項目を含む Outcome の PATCH も、Intent / Outcome の検査より先に「Project が archived」の 409 になる。

## エラーの形

- archived による拒否は `409 CONFLICT`。`error.projectStatus` に `archived` を含める（既存の `status` は Intent / Outcome の状態を表すため、Project の状態は別名にして区別する）。
- メッセージの先頭は `Project <projectId> is archived`（既存の `Project <id> was not found` と同じ形式）。archive の再実行は `Project <projectId> is already archived`。どちらも `projectStatus: "archived"` を持つ。
- Web API の応答: `{ "error": { "code": "CONFLICT", "message": "...", "projectStatus": "archived" } }`。MCP の `isError` 応答と CLI の標準エラー（`{ error: { code, message } }`）も同じ `code` を返す。既存の `ConflictError` の `details` を使うため、エラーの型・HTTP の対応表は変えない。
- 理由なし・空白のみの archive は `400 VALIDATION_ERROR`（`issues` の path が `reason`）。本文なしの要求も理由なしとして同じエラーにする（Outcome の cancel と同じ）。

## Web API

| 操作 | Web API | 成功 | 備考 |
| --- | --- | --- | --- |
| archive | `POST /api/projects/:projectId/archive`、本文 `{ "reason": "..." }` | `200 { project }` | `status: "archived"`、`archivedAt`、`archiveReason` を含む Project を返す |
| 一覧 | `GET /api/projects` | `200 { projects }` | **`active` のみ**（既定） |
| アーカイブ一覧 | `GET /api/projects?status=archived` | `200 { projects }` | `archived` のみ。新しく archive した順（`updatedAt` 降順） |
| 詳細 | `GET /api/projects/:projectId` | 不変 | archived でも 200。3 項目を含む |

- `status` の値は `active` / `archived` のみ。それ以外は `400 VALIDATION_ERROR`（path `status`）。全件を返す指定（`all`）は設けない（UI が必要としない。必要になれば追加する）。
- `DELETE /api/projects/:projectId`、復帰用の API、`PATCH` による `status` 変更は**作らない**。`PATCH /api/projects/:projectId` の入力に `status` / `archivedAt` / `archiveReason` が含まれても、他の未知の項目と同じく無視する（現行の `updateProjectSchema` は未知の項目を捨てる。`status` だけの PATCH は「更新項目が 1 件以上必要」の `400` になる）。
- 既存の Intent / Outcome / Grant の URL と入出力の形は変えない。
- MCP には新しい tool を追加しない（`tools/list` に archive・delete・restore・unarchive を意味する名前が無いことを検査する）。CLI の `cliUsage` も変えない。

## 永続化

Kysely / SQLite。`project` table へ 3 列を追加する。**DB schema の変更は Task 20 の明示的な実装範囲**であり、Task 19 では行わない。

```text
project（追加）
  status          text    not null default 'active'  check (status in ('active', 'archived'))
  archived_at     integer null
  archive_reason  text    null
```

- **既存データの移行**: `initializeSchema` は `create table if not exists` のため、既存の DB では `project` table が再作成されない。`initializeSchema` の中で、`project` に `status` 列が無い場合だけ `alter table project add column` で 3 列を追加する（idempotent。2 回目以降は何もしない）。`default 'active'` により既存の全行が `active` になる。新規 DB は `createTable` の定義に 3 列を含める。移行は列の追加だけで、既存行・子 table（`intent` / `outcome` / `success_criterion` / `project_grant` ほか）の行を書き換えない・削除しない。
- `status` の check は 2 値。`archived_at` と `archive_reason` の整合（archived なら両方 non-null）は SQLite の `ALTER TABLE ... ADD COLUMN` では table 制約を足せないため、application 層 / Repository の archive 操作が保証する（テストで検証する）。
- 時刻は既存 table と同じ epoch の integer。archive は `status` / `archived_at` / `archive_reason` / `updated_at` を 1 つの transaction で更新する。archive 対象が既に archived なら何も書かない。
- Kysely の型（`ProjectTable`）、`Project` model（3 項目）、`ProjectRepository`（archive 操作と `findAll` の状態指定）を更新する。`findAll` の絞り込みは Repository に持たせる（use case で全件取得後に絞らない。件数が小さくても、責務を Repository の問い合わせに置く）。
- 子データを削除する `on delete cascade` は Project の物理削除でしか発火しない。本書は物理削除を作らないため、archive で子データが消える経路は無い。

## Web UI（Task 21 が実装する契約）

| 画面 | archived | active |
| --- | --- | --- |
| Project 一覧（既定） | 表示しない | 表示する |
| Project 一覧（アーカイブ済み） | 一覧へ切り替えて表示する。`archiveReason` の要約と archive 日時を表示 | — |
| Project 詳細 | 「アーカイブ済み」の状態表示、`archiveReason`、`archivedAt` を明示する。Project 編集・Intent 登録/編集/放棄・Outcome 登録/編集/取消・Role Grant の発行/取消の導線を**出さない**。Intent / Outcome / Grant の一覧と Outcome 詳細は閲覧できる | 「アーカイブ」操作を出す |

- アーカイブ操作は確認パネルを挟み、**理由を必須入力**にする（400 の項目別エラーを表示する）。確認パネルは誤操作防止であり、開発の完了に手動確認を要求しない（`AGENTS.md`）。
- archive 後は、その Project の詳細（archived 表示）を表示する。409（既に archived、他の変更が拒否された場合）は、入力エラーと区別して「アーカイブ済みのため変更できません」と表示し、Project 詳細への導線を出す。
- archived の Project の編集・登録 URL（`/projects/:projectId/edit`、`.../intents/new`、`.../outcomes/new` ほか）へ直接アクセスした場合も、409 を上記と同じ表示にし、保存済みの内容を変えない。
- 表示しないもの: 「復帰」「削除」の導線、archive を取り消せるかのような文言。
- UI の純関数（一覧の切替クエリ、archive の入力検証と表示用の整形）と API adapter を、既存の `test/projectAdapters.test.ts` / `projectForm.test.ts` と同じ方針で自動テストする。

## 受け入れ条件（Task 20・21 の確認対象）

「層」は主に検証する場所。Task 20 は AC-1〜AC-19、Task 21 は AC-20〜AC-22 を満たす。

| # | 層 | Given / When / Then |
| --- | --- | --- |
| AC-1 | repository / API | Given active の Project（Intent・Outcome・Grant あり）/ When `POST .../archive` に理由 / Then 200、`status: "archived"`、`archiveReason`、`archivedAt`、`updatedAt = archivedAt`。再起動後の再取得でも同じ |
| AC-2 | API | Given active の Project / When 理由なし・空白のみ・本文なしで archive / Then 400（path `reason`）、Project は `active` のまま |
| AC-3 | API | Given archived / When 再度 archive / Then 409（`projectStatus: "archived"`）、`archivedAt` / `archiveReason` は変わらない |
| AC-4 | API | Given 存在しない ID / When archive / Then 404。入力の検証は存在確認より先（無効な理由なら 400）。Task 42 以降の Web API では Membership 認可が先に働き、存在しない ID は入力に関わらず 404（Step 6） |
| AC-5 | repository / API | Given archived / When `PATCH /api/projects/:id` / Then 409（`projectStatus`）、Project は変わらない。`status` だけの PATCH は 400、name と一緒に `status: "active"` を送っても復帰せず name の更新も 409 になる |
| AC-6 | API | Given archived / When Intent の作成・更新・放棄 / Then すべて 409（`projectStatus`）。存在しない `intentId` でも、Intent の 404 ではなく 409 |
| AC-7 | API | Given archived / When Outcome の作成・更新・取消（固定項目を含む PATCH を含む）/ Then すべて 409（`projectStatus`）。Outcome・Success Criterion は変わらない |
| AC-8 | API / CLI | Given archived / When Grant の発行・取消（Web API と CLI の `grant` / `revoke`）/ Then 409。Grant は増減しない。`grants`（一覧）は成功する |
| AC-9 | API | Given archived / When Project 詳細・Intent 一覧/詳細・Outcome 一覧/詳細・Grant 一覧を GET / Then すべて 200 で、archive 前と同じ内容 |
| AC-10 | API | Given active と archived の Project / When `GET /api/projects` / Then active のみ。`?status=archived` で archived のみ（archive の新しい順）。`?status=all` などは 400（path `status`） |
| AC-11 | repository | Given archived / When use case を経由せず Repository の書込（Project 更新、Intent・Outcome の書込、Grant の発行・取消）を直接呼ぶ / Then 各 Repository が「archived」を返し、何も書かない（use case の事前確認に依存しない。同一 transaction の検査） |
| AC-12 | repository | Given archive 済み Project の子データ / When archive 後に全子 table を数える / Then Intent・Outcome・Success Criterion・Grant の件数と内容は archive 前と同じ。`active` の Intent は `active` のまま、Outcome も取消されない |
| AC-13 | migration | Given archive 導入前の schema で作った DB（Project・Intent・Outcome・Grant 入り）/ When `initializeSchema` を 2 回実行 / Then 2 回ともエラーなし。既存 Project は `active`、`archived_at` / `archive_reason` は null、子 table の行は不変。移行後に archive できる |
| AC-14 | MCP | Given archived / When `get_project` / `list_intents` / `list_outcomes` / `get_outcome` / `get_strategist_context`（Strategist Grant あり）/ Then 成功し、Project の `status` が `archived` |
| AC-15 | MCP | Given archived / When `update_project` / `create_intent` / `update_intent` / `abandon_intent` / `create_outcome`（Strategist）/ `update_outcome` / `cancel_outcome` / Then すべて `isError` の `CONFLICT`（`projectStatus: "archived"`）。認証・Role の拒否（401 / 403）は archived でも先に返る |
| AC-16 | MCP | When `tools/list` / Then archive・delete・restore・unarchive を意味する名前の tool が無い（既存の tool 名と、Grant 管理 tool を公開しないことも維持）。`list_projects` は `active` のみを返し、`status` 引数を持たない |
| AC-17 | CLI | When `cliUsage` / コマンド一覧を確認 / Then archive・delete のコマンドが無く、`cliUsage` は変わらない |
| AC-18 | API | When Project 一覧・詳細・作成・更新の応答 / Then 既存項目の形は変わらず、`status`（新規は `active`）、`archivedAt`、`archiveReason` が追加されるだけ |
| AC-19 | API | When `DELETE /api/projects/:projectId`、復帰用の path を呼ぶ / Then 既存の未定義 API と同じ `404`（`NOT_FOUND`）で、Project は変わらない |
| AC-20 | UI helper / adapter | archive の入力検証（理由必須）、一覧切替のクエリ生成、409 / 400 の表示用整形を自動テストする。Web API adapter が `POST .../archive` と `?status=archived` を呼ぶ |
| AC-21 | UI（自動 + 可能ならブラウザ） | archived の詳細に、状態・理由・日時が表示され、変更・登録・Grant 操作の導線が無い。active の詳細にだけ「アーカイブ」がある。確認パネルで理由が必須 |
| AC-22 | UI（自動 + 可能ならブラウザ） | 通常一覧に archived が出ず、アーカイブ済み一覧に出る。archived の編集・登録 URL へ直接アクセスして保存しても 409 が区別して表示され、内容は変わらない |

## 本 Step に含めないもの

- `paused` / `resume` と、一時停止による書込拒否
- archived からの復帰（unarchive）、Project・子データの物理削除、削除 API
- archive 時の Intent の連動放棄、Outcome の連動取消、Role Grant の連動取消
- MCP の archive / delete / restore tool、CLI の archive コマンド
- archive の実行者（actor）の記録、監査ログ・Change Log の table、archive の通知
- Wacha の Project・Task・実行の停止や連携、Runtime による Agent の停止
- Web API の認証・Role 検証、楽観ロック、`Idempotency-Key`
- Project 一覧の全件表示（`status=all`）、archive 日時の範囲検索、archive 済み一覧の検索・ページング

## 選択理由と将来変更できる箇所

| 選択 | 理由 | 将来の変更点 |
| --- | --- | --- |
| 状態は `active` / `archived` の 2 値、`paused` を予約しない | 要求は「active → archived」のみ。追加資料に `paused` の根拠が無く、公開しない状態値を予約すると未使用の仕様が残る | `paused` が必要になれば check 制約の変更（SQLite の table 再作成）と遷移・拒否規則を追加する。既存の `active` / `archived` のデータは互換 |
| 不可逆（復帰なし）、再 archive は 409 | `kit/docs/domain-model.md` の「archived は初期版では復帰不可」に合わせ、履歴（理由・日時）を書き換えない | 復帰が必要なら `unarchive` を Web API と UI へ追加し、`archivedAt` / `archiveReason` の履歴の持ち方（上書き / 履歴 table）を決める |
| 理由は必須（1〜2,000 文字） | `kit/docs/project-model.md`「理由を監査記録に残す」。Outcome の取消理由（必須）と同じ扱い | 任意にする場合は schema を `optionalText` へ変え、UI を任意入力にする |
| 子データを変更しない（Intent は `active` のまま） | 「子データを削除しない」の要件。連動放棄は Intent の履歴を偽造し、Outcome の取消理由も上書きするため | Evaluation / Execution 導入後、進行中の作業を止める必要があれば、archive に連動する停止要求を別に設計する |
| 書込は 1 つの規則で全拒否（Grant の取消も拒否） | 「archived は参照専用」を例外なしで検査・テストできる。Grant が残っても書込は拒否され、読取が増えるだけ | Agent のアクセスを archive 後に断つ必要があれば、archive と同一 transaction で Grant を取り消す、または取消だけを許可する |
| 拒否は Repository の同一 transaction で検査し、優先順位を固定 | use case の事前確認だけでは archive と書込の競合を防げない。Intent / Outcome の既存方式（transaction 内の状態確認）と揃える | 楽観ロックを導入するときに、version の検査と併せて整理する |
| 409 に `projectStatus` を持たせる | 既存の `status`（Intent / Outcome の状態）と区別できる。既存の `ConflictError` の `details` をそのまま使え、エラー型・HTTP の対応を変えない | Project 状態が増えたら値が増えるだけ |
| MCP の `list_projects` は active のみ、引数を足さない | Agent が新しい作業の対象を探す入口から archived を外す。公開 tool の入力を変えない。archived の読取は ID 指定の tool で可能 | Agent が archived の一覧を必要とするなら、`status` 引数を追加する |
| archive を Web API のみに公開 | `AGENTS.md`: Human の管理操作は Web UI が正規入口で、MCP へ無条件に公開しない。CLI は保守用途に限る | Web API の認証・Role 導入時に、archive を Human / manager 相当の Role に限定する |
| 既存 API の `GET /api/projects` の既定を active のみに変更 | Task 21 の「通常一覧は active のみ」。Project 応答の既存項目は不変で、絞り込みだけが変わる。呼び出し側は現状 UI と MCP のみ | archived を含む取得が必要な呼び出しが出たら `status` の値を追加する |
| 物理削除・復帰を作らない | 要件と `kit/docs/domain-model.md`「削除 API は作らない」 | 削除が必要になれば、子データ・Grant・Wacha 側の参照を含め別 Step で設計する |
| migration を `initializeSchema` 内の idempotent な `alter table` にする | 既存の `initializeSchema`（`create ... if not exists`）と `compass.db` の再起動運用に合わせ、別の migration 機構を導入しない | 列の追加が増える場合は、schema version を持つ migration 機構を導入する |

## 実装状況と検証

### 実装済み（Task 20）

| 項目 | 実装 | 検証 |
| --- | --- | --- |
| 永続化・移行 | `project` へ `status` / `archived_at` / `archive_reason` を追加。`initializeSchema` が列の無い既存 DB にだけ `alter table` で追加し（idempotent）、既存行は `active` になる | `test/projectArchive.test.ts` AC-1 / AC-13、status の check 制約 |
| Repository | `ProjectRepository.archive` / `findAll(status = "active")`。`update` / Intent / Outcome / Grant の書込は、同一 transaction で `isProjectArchived` を検査し `{ kind: "project_archived" }` を返す（`src/infrastructure/repository/isProjectArchived.ts`） | AC-11、AC-12 |
| use case | `ArchiveProjectUseCase`（入力検証 → 404 → 409 の順）。archived 拒否は `ProjectArchivedError`（`ConflictError` の派生、`projectStatus: "archived"`）。`UpdateOutcomeUseCase` だけは固定項目の拒否がある Repository 呼び出し前のため、archived を先に検査する | AC-2〜AC-8 |
| Web API | `POST /api/projects/:projectId/archive`、`GET /api/projects[?status=archived]`（`status` は `active` / `archived` のみ、他は 400） | AC-1〜AC-10、AC-18、AC-19 |
| MCP / CLI | tool・コマンドを追加していない。既存の書込 tool・`grant` / `revoke` が同じ use case 経由で `CONFLICT` を返す。MCP の `list_projects` は active のみ | AC-14〜AC-17 |

- 「Repository の同一 transaction での検査」は、better-sqlite3 の単一接続で書込が直列化されることに依存する。archive と書込の同時実行の競合は、use case を経由しない Repository 直接呼び出しのテスト（AC-11）で「archived なら何も書かない」ことを確認したもので、並列プロセスでの負荷試験は行っていない。
- 検証（Task 20）: `npm test`（135 件パス）、`npm run lint`（tsc 2 project）、`npm run build`。ブラウザでの確認は Web UI を変更していないため対象外。

### 実装済み（Task 21: Web UI）

| 項目 | 実装 | 検証 |
| --- | --- | --- |
| 純関数・adapter | `src/frontend/projectArchive.ts`（一覧切替の query / path、理由の検証・要約、archive の request、400 / 409 / 404 の表示整形）。`api.ts` は 409 の `projectStatus: "archived"` を `project_archived`（Intent 等の `conflict` と別の kind）へ分類 | `test/projectArchiveUi.test.ts`（AC-20、および実 Web API へ向けた adapter の archive・一覧・409 分類） |
| Project 一覧 | 「Active / アーカイブ済み」の切替（`/?status=archived`）。archived のカードに理由の要約と archive 日時を表示 | AC-22（一覧の取得は自動テスト。画面は未検証、下記） |
| Project 詳細 | active だけに「アーカイブ」と理由必須の確認パネルを出す。archived は状態・理由・日時を表示し、Project 編集・Intent 登録・Grant の割当と取消の導線を出さない。archive 済みの検出（409）時は詳細を再取得して archived 表示へ揃える | AC-21（画面は未検証、下記） |
| Intent / Outcome 詳細 | `useProjectOperation`（Step 6 で `useProjectArchived` を置換し、archived と `myRole` の `direction.write` を判定）で、編集・放棄・取消・登録の導線を出さない（判定できない間も出さない）。作成・編集画面をURLで直接開いた場合も `ProjectOperationGate` がフォームを描画せず、アーカイブ済みであることを表示する。一覧と詳細の閲覧は可能 | 同上 |
| 編集・登録 URL への直接アクセス | 保存時の 409 を `FormErrorSummary` が「アーカイブ済みのため変更できません」とし、Project 詳細への導線を出す。入力エラー（400）・他の競合（409）とは別の表示 | adapter の分類を自動テスト。画面は未検証 |

- **未検証**: ブラウザでの表示確認（AC-21・AC-22 の画面部分）。この実行環境にブラウザ操作の手段が無く、React コンポーネントの描画テストも既存の方針（純関数と adapter のテスト）に無いため、コンポーネントの表示・導線の出し分けは型検査とビルド成功までの確認である。
- 検証（Task 21）: `npm test`（142 件パス）、`npm run lint`、`npm run build`。

## Task 19 時点の設計の前提

Task 19 で確認した設計時点（実装前）の実装の事実:

- `project` table に状態の列は無く、`ProjectRepository.findAll` は全件を返す。Project の書込は `exists` の確認後に Repository の transaction で行い、Intent / Outcome の書込は Repository の transaction 内で Intent / Outcome の状態を検査している（Project の状態の検査は無い）。
- `initializeSchema` は `create table if not exists` のみで、列の追加（`alter table`）の前例は無い。
- `updateProjectSchema` は未知の項目を捨てる（`status` は PATCH で変更できない）。
- MCP には Project の archive / delete tool が無く、CLI は `grant` / `revoke` / `grants` のみ。Web API に DELETE は Grant の取消だけがある。
- `docs/step-1-project-design.md`・`step-2-intent-design.md` が「Project の archive」を未確定として持ち越していた。本書で確定した。

検証（Task 19）: 設計文書のみのため、コード・テストの変更は無く、`npm test` 等は実行対象の変更が無い。
