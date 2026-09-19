# Step 3: Outcome と成功条件 初期仕様

> **状態: Step 3 の初期仕様（確定）。実装は Task 10（未着手）。**
> 事前のユーザー確認は設けない。追加資料に定めのない事項は、既存設計との整合、単純さ、将来の変更容易性を基準に初期値を選んだ。完成後のフィードバックに応じて修正する。選択理由と将来の変更点は各節と「選択理由と将来変更できる箇所」に記録する。

## 根拠資料と優先順位

| 区分 | 資料 | 扱い |
| --- | --- | --- |
| 主根拠 | `kit/additional-doc.md` | 9 Outcome、10 Success Criterion、13 Decision、32.4 Outcome 階層。「候補」「要検討」とある事項は本書が初期値を選んだ |
| 主根拠（優先） | `kit/additional-doc-2.md` | Intent → Strategist → (Research) → Decision → Outcome。Research は必須工程ではない |
| 補助 | `kit/docs/domain-model.md` ほか | 初期設計のデフォルト。`kit/README.md` が「過去会話の確定事項ではない」と明記。参考にするが自動採用しない |

補助資料との差異（本書は追加資料を優先し、以下は採用しない）:

- `proposed` 状態と `proposed → active` の活性化操作、活性化時点での成功条件固定。追加資料は「Outcome **作成時**に成功条件を固定する」としている（本書は作成時に固定する）。
- 進行中 Outcome を Intent につき最大1件とする DB 制約。追加資料の Project 画面は「Active Outcomes」と複数形で、Intent 配下に Outcome A/B/C が並ぶ図を示している。
- `originDecisionId`、`contextVersion`、`executionMode`、楽観ロック用 version、`priorOutcomeId`。対応する Decision / Execution / Context version の実体が Step 3 に存在しない。

## 責務境界

```text
Intent (Compass, Step 2 実装済み)
   ↓  [起動は未接続]
Strategist ─ 判断 ─→ Decision ─→ Outcome (+ Success Criteria)   ← Step 3 で保存・参照する
   └─ 情報不足の場合のみ Research（任意）
```

| 主体 | 責務 | Step 3 での扱い |
| --- | --- | --- |
| Strategist | Outcome を定義できるか判断し、Decision として Outcome を決める | **Agent としては未実装**。Web / MCP の作成操作が「Strategist（または Human）の判断結果の登録」に当たる |
| Researcher | 判断の不確実性を減らす。Outcome は決めない | 未実装。**Research は Outcome 作成の前提でも入力項目でもない**。Research Entity・`researchId` 参照・`researching` 状態を作らない |
| Compass (Direction) | Outcome / Success Criterion の保存・検証・参照 | **実装対象**。Intent から Outcome を自動生成しない |
| Runtime / Orchestrator | 起動条件の成立を扱う | 未実装。Intent 作成や Outcome 作成を契機にした Agent 起動を実装しない |
| Wacha | Execution。Outcome は複製せず参照する | 連携しない。Outcome の参照・複製方式は Task 10 の範囲外 |

- **Decision との関係**: Outcome は Strategist の Decision の結果として作られる（追加資料 13）。Step 3 には Decision Entity が無いため、Outcome 作成時に必須の `rationale`（なぜこの Outcome を選んだか）を **Decision の最小記録として Outcome に同居**させる。Decision Entity を導入する際は、既存の `rationale` を初期 Decision へ移し、`originDecisionId` を追加する（既存データ互換）。存在しない Decision / Research / Evidence の参照は生成しない。
- **Research が任意であること**: 情報が十分な Intent（例:「P95 latency < 200ms」）では、Research なしで直接 Outcome を登録できる。Research を必要とする場合も、Research の実体は Outcome の項目ではなく、別の Direction Support Concept（後続）として関連付ける。
- Outcome を Intent から機械的に生成する処理（Intent 作成時の自動作成、テンプレート展開、`completionDefinition` の複製）は実装しない。Outcome は明示的な作成操作でのみ登録される。

## Outcome の項目

| 項目 | 必須 | 規則 |
| --- | --- | --- |
| id / projectId / intentId | server 生成 | 所属 Intent と Project を固定。作成後は変更不可。intent が project 配下であることを作成時に検証する |
| title | 必須 | trim 後 1〜100 文字。一覧・詳細の見出し |
| description | 必須 | trim 後 1〜2,000 文字。「Intent へ近づくために達成すべき、観測可能な状態」。作成後は変更不可 |
| hypothesis | 任意 | trim 後最大 2,000 文字。空文字は `null`。「これを達成すると Intent へ近づく」と考える理由。追加資料 9 の「仮説でもある」に対応 |
| rationale | 必須 | trim 後 1〜2,000 文字。Decision の最小記録（なぜこの Outcome を、今、選んだか）。作成後は変更不可 |
| successCriteria | 必須（1〜10件） | 下記の Success Criterion。作成時に固定 |
| status | server 管理 | 下記の状態参照 |
| cancelReason | server 管理 | 取消時のみ。trim 後 1〜2,000 文字（必須） |
| createdAt / updatedAt | server 生成 | 更新・取消時に updatedAt を更新 |

- 入力 schema は `src/shared/outcomeSchema.ts`（新規）に置き、Web API と MCP が同じ検証を使う（Project / Intent と同じ方針。`trimmedText` / `optionalText` / `parseWith` を再利用する）。
- `constraints` / `priority` / `parentOutcomeId` は追加資料 9 の属性候補だが Step 3 では作らない（理由と将来の変更点は末尾の表）。

## Success Criterion（成功条件）

| 項目 | 必須 | 規則 |
| --- | --- | --- |
| id | server 生成 | 安定した不透明 ID（UUID）。Evaluation や外部参照のために独立して参照できる |
| outcomeId | server 生成 | 所属 Outcome。変更不可 |
| position | server 生成 | 入力配列の順序（0 始まり）。表示順を保つ |
| description | 必須 | trim 後 1〜500 文字。何を満たせば成功か（例: `duplicate_claim_count = 0`） |
| measurement | 必須 | trim 後 1〜1,000 文字。どう観測し、どの証拠があれば成立と言えるか。空文字は禁止（Agent の「できた」という主張だけでは成立にできないため） |
| target | 任意 | trim 後最大 200 文字。空文字は `null`。目標値・期待状態（例: `= 0`, `100%`） |

- 条件はすべて必須。optional 条件や重み付き達成率は作らない。
- `kind`（quantitative / qualitative）、operator、単位、観測 window、最小標本数などの構造化は Step 3 に含めない。Evaluation が存在せず、構造化しても検証に使われないため、自由記述の3項目で保存する。Evaluation 導入時に構造化項目を追加し、既存の自由記述は `measurement` として残す。
- 1 Outcome に 1〜10 件。0 件の Outcome は登録できない（空条件は成功にしない）。

## 固定ルールと許可する変更

**成功条件の固定時点は、Outcome の作成時**。Outcome と全 Success Criterion は 1 回の作成操作で同一トランザクションに保存し、途中状態（Outcome だけ、条件が一部だけ）を残さない。

| 対象 | Outcome が `active` の間 | `cancelled` 後 |
| --- | --- | --- |
| successCriteria（追加・修正・削除・並べ替え） | **不可** | 不可 |
| description / rationale | **不可** | 不可 |
| title | 可 | 不可 |
| hypothesis | 可（`null` / 空文字でクリア） | 不可 |
| 状態 | `cancel` のみ公開 | 終端 |

- 成功条件を変えたい場合は、元 Outcome を取り消し（`cancel`）、新しい Outcome を作る。履歴を書き換えない（追加資料 10「Evaluation 時に後付けで変更しない」）。
- 更新（PATCH）の入力に `description` / `rationale` / `successCriteria` が含まれる場合は、**黙って無視せず 409 `CONFLICT` で拒否**する（変更できたと誤認させないため）。`status` など未知の項目は Step 2 と同様に無視する。
- 成功条件の追加・更新・削除の公開操作（API / MCP / UI / Repository の更新系メソッド）は作らない。固定はサーバーのアプリケーション層で担保し、UI の非活性化だけに頼らない。Repository には Criterion の作成と参照のみを持たせる。
- 部分更新方式は Project / Intent と同じ: 未指定は変更なし、title は空白のみを拒否する。1 件以上の更新項目を必要とする。

## 状態と遷移

状態値は `active` / `cancelled` の2つを Step 3 で使う。追加資料が候補とする `evaluating` / `achieved` / `not_achieved` は状態値として予約するが、Evaluation・Execution が存在しないため **Step 3 では遷移を公開しない**。`proposed` は設けない。

| 遷移 | Step 3 | 理由 |
| --- | --- | --- |
| 作成 → `active` | 公開する | 作成が Strategist の Decision の結果登録であり、作成時に成功条件を固定するため、下書き段階が不要。`proposed` の活性化操作と、条件を編集できる期間を作らない（固定時点を 1 つに保つ） |
| `active` → `cancelled` | 公開する（理由必須） | 誤登録・方針転換の取下げ。成功条件を変える唯一の経路（取消 + 新規作成） |
| `active` → `evaluating` / `achieved` / `not_achieved` | **公開しない（後続へ送る）** | 達成・非達成は Evaluation と Evidence に基づく。Execution の完了だけ、または人手の状態書換えで達成扱いにする経路を作らない |
| 終端からの復帰 | 作らない | 再開は新しい Outcome とする |

- 汎用の「status を任意に書き換える」操作は作らない。遷移は `cancel` のような明示的操作にする。
- `not_achieved` は将来、異常ではなく正常な学習結果として扱う（追加資料 9）。

## 並行数と階層

- **並行数**: Intent 配下の `active` Outcome は複数件を許可し、件数上限や部分一意制約は設けない。追加資料の「Active Outcomes」（複数形）と、Intent 配下に複数 Outcome が並ぶ構図に従う。一方 Active Intent は最大 1 件のままなので、Project 全体の active Outcome も 1 つの Active Intent 配下に限られる。
- **階層**: 初期はフラット（`parentOutcomeId` を作らない）。追加資料 32.4 の「階層化しすぎると複雑になる」に従う。Outcome 間の優先順位・先行関係（`priority` / `priorOutcomeId`）も持たず、一覧は作成日時の降順とする。
- **Intent との関係**:
  - Outcome は **`active` の Intent 配下にだけ作成できる**。`abandoned` / `achieved` の Intent への作成は 409 `CONFLICT`（`status` を含む）。
  - **Intent を `abandon` すると、その Intent の `active` Outcome を同一トランザクションで `cancelled` にする**（`cancelReason` は `Intent abandoned` 固定文言 + 放棄理由があれば併記）。Task 08 の `abandon_intent` use case への追加で、Web API / MCP の入出力の形は変えない。放棄された Intent に active Outcome を残さないための最小規則。
  - **Step 2 で持ち越した「Outcome 追加後の Intent 変更規則」の確定**: Intent に 1 件でも Outcome（状態を問わず）が存在する場合、`desiredState` と `completionDefinition` の変更を 409 `CONFLICT` で拒否する。`title` は変更可。Outcome は Intent の意味に対する仮説であり、意味を後から変えると Outcome と rationale が根拠を失うため。意味を変えたい場合は Intent を放棄し、新しい Intent を作る（追加資料・kit/docs の「active 後の意味変更は放棄 + 新 Intent」に沿う）。

## Web / MCP 操作

trusted local 前提（Step 1・2 と同じ。認証・Role 検証なし）で、Web と MCP の双方に作成・参照・更新・取消を公開する。どちらも共通の application 処理と入力 schema を使う。

Web API は `projectId` → `intentId` 配下にネストし、ID の取り違えを 404 で区別する（他 Project の Intent、他 Intent の Outcome は取得・更新できない）。

| 操作 | Web API | MCP tool |
| --- | --- | --- |
| 作成 | `POST /api/projects/:projectId/intents/:intentId/outcomes` → 201 | `create_outcome` |
| 一覧 | `GET /api/projects/:projectId/intents/:intentId/outcomes` | `list_outcomes` |
| 詳細 | `GET /api/projects/:projectId/intents/:intentId/outcomes/:outcomeId` | `get_outcome` |
| 更新 | `PATCH /api/projects/:projectId/intents/:intentId/outcomes/:outcomeId` | `update_outcome` |
| 取消 | `POST /api/projects/:projectId/intents/:intentId/outcomes/:outcomeId/cancel` | `cancel_outcome` |

- 作成入力: `{ title, description, hypothesis?, rationale, successCriteria: [{ description, measurement, target? }] }`。MCP tool は `projectId` / `intentId` を追加で受け取る。
- 応答: `{ outcome }` / `{ outcomes }`。Outcome は `successCriteria`（position 順）を含めて返す（一覧も同様。件数が小さいため別取得にしない）。
- 既存の Project / Intent の API・MCP tool の入出力の形は変えない。Intent 応答へ Outcome を埋め込まず、画面は Outcome 一覧 API を別に呼ぶ。
- エラー:
  - `400 VALIDATION_ERROR`: 入力違反（項目 path 付き。`successCriteria.0.measurement` のように配列位置を含む）。Web と MCP で同じ規則。
  - `404 NOT_FOUND`: Project / Intent / Outcome のどれが無いかをメッセージ先頭（`Project <id>` / `Intent <id>` / `Outcome <id>`）で区別。他 Project・他 Intent 配下の ID も 404。
  - `409 CONFLICT`: 非 active の Intent への作成、非 active の Outcome への更新・取消、固定項目（`description` / `rationale` / `successCriteria`）の変更、Outcome を持つ Intent の意味変更。理由を判別できるフィールド（`status` または `fixedFields`）を含める。
  - 予期しない失敗は `500`。
  - 入力検証は Step 2 と同じ順序（無効な入力は存在確認より先に `VALIDATION_ERROR`）。
- MCP は認証なしで principal を持たない。Step 2 と同様、「Strategist だけが作成する」規則は Step 3 でも強制できず、この制約を受け入れて公開する。actor / role の記録は将来の変更点。

## 永続化

Kysely / SQLite。`outcome` と `success_criterion` を追加する。DB schema 変更は Task 10 の明示的な実装範囲に含まれる。

```text
outcome
  id, project_id (FK → project.id), intent_id (FK → intent.id, on delete cascade),
  title, description, hypothesis (nullable), rationale,
  status ('active' | 'cancelled'), cancel_reason (nullable),
  created_at, updated_at
  INDEX (intent_id, created_at)

success_criterion
  id, outcome_id (FK → outcome.id, on delete cascade),
  position, description, measurement, target (nullable),
  created_at
  UNIQUE INDEX (outcome_id, position)
```

- Outcome と Criterion の作成は 1 トランザクション。Intent 放棄時の Outcome 取消（`active` → `cancelled`）も Intent 状態更新と同一トランザクション。
- `outcome.status` は Step 2 の `intent.status` と同じく check 制約を置くが、予約済みの状態値をすべて含める（`active` / `evaluating` / `achieved` / `not_achieved` / `cancelled`）。SQLite は check 制約の変更に table 再作成が必要なため、後続の状態公開で DB 変更を不要にする。Step 3 のアプリケーション層は `active` / `cancelled` のみを書き込む。
- 時刻は既存 table と同じ epoch の integer で保存する。
- 既存の idempotent な `initializeSchema` に `create table if not exists` / `create index if not exists` で追加する。既存 table・既存 API 応答は変更しない。
- Repository は `OutcomeRepository`（domain 層の interface）に置き、Criterion は Outcome の一部として作成・取得する。Criterion の update / delete メソッドは作らない。
- 再起動後も同じ ID・内容で取得できる。

## Web UI

- **Project 詳細**: Intent section の Active Intent 内に、その Intent の active Outcome の title（Outcome 詳細へのリンク）を表示する。無ければ「Outcome は未登録です」と明示する。追加資料の Project 画面の「Active Outcomes + Success Criteria」の初期表示に当たり、成功条件は Outcome 詳細で見る。
- **Intent 詳細**: 「Outcome」section を追加する。active Outcome を一覧し、cancelled は折りたたみ表示。「Outcome を登録」導線を置く。Intent が active でない場合は登録導線を出さない。
- **ルーティング**: `/projects/:projectId/intents/:intentId/outcomes/new`（作成）、`.../outcomes/:outcomeId`（詳細。成功条件を position 順に表示）、`.../outcomes/:outcomeId/edit`（title / hypothesis のみ編集）。取消は詳細画面から確認パネルを挟んで実行する。
- **作成フォーム**: title / description / hypothesis / rationale と、成功条件の行（description / measurement / target）を追加・削除できる。1 件以上必須、10 件まで。**作成後は成功条件の編集 UI を出さず**、「成功条件は作成時に固定され、変更する場合は取り消して新しい Outcome を作成します」と明示する。rationale の欄には「Strategist の判断理由」であることを示すラベル・補足を付ける。
- 409（Intent が active でない等）は入力エラーと区別して表示し、Intent への導線を示す。項目別エラー（成功条件の行ごとを含む）・通信障害の区別・保存失敗時の入力保持・キーボード操作・狭い画面は Step 1・2 のフォームと同じ基準。
- **表示しないもの**: Evaluation 結果、Execution の進捗、Decision 一覧、Research の進行、Strategist の稼働状況、達成率。未実装の機能を「評価待ち」などと架空表示しない。

## 受け入れ例（Task 10 の確認対象）

1. Given Active Intent がある / When title・description・rationale と成功条件2件で Outcome を作成 / Then `active` で保存され、Intent 詳細・Project 詳細から辿れ、成功条件が入力順で表示される。再起動後も同じ ID・内容で取得できる。
2. Given Active Intent / When 成功条件が 0 件、または 11 件で作成 / Then `VALIDATION_ERROR` で、Outcome も Criterion も保存されない。
3. Given Active Intent / When 2 件目の条件の `measurement` が空白のみで作成 / Then `VALIDATION_ERROR`（path に配列位置）。Outcome は保存されない（部分保存なし）。
4. Given Active Intent に active Outcome がある / When 別の Outcome を作成 / Then 成功し、複数の active Outcome が並ぶ（件数上限・409 なし）。
5. Given active Outcome / When PATCH に `successCriteria`、`description`、`rationale` のいずれかを含める / Then `409 CONFLICT`（`fixedFields`）で、Outcome と Criterion は変わらない。
6. Given active Outcome / When title と hypothesis を更新（hypothesis は空文字でクリアも）/ Then 反映され `updatedAt` が更新される。成功条件・他項目は変わらない。
7. Given active Outcome / When 理由なしで cancel / Then `VALIDATION_ERROR`。理由付きで cancel すると `cancelled` になり、以降の更新・再 cancel は `409`。成功条件は取消後も保持され参照できる。
8. Given 別々の Project A・B、または別々の Intent / When 他の配下の ID で Outcome を参照・更新・取消 / Then `404` で、内容は露出せず変更もされない。存在しない projectId / intentId / outcomeId が区別できる。
9. Given Intent が `abandoned` / When Outcome を作成 / Then `409`（`status`）。
10. Given active Outcome を持つ Active Intent / When Intent を `abandon` / Then Intent が `abandoned`、Outcome が同時に `cancelled`（Intent の放棄を示す理由付き）になる。どちらか一方だけが更新された状態を残さない。
11. Given Outcome を持つ Active Intent / When `desiredState` または `completionDefinition` を更新 / Then `409`。`title` の更新は成功する。Outcome を持たない Intent は従来どおり 3 項目を編集できる。
12. Given Web で作成した Outcome / When MCP `get_outcome` で参照 / Then 同じ内容と成功条件が見える。MCP `create_outcome` / `update_outcome` / `cancel_outcome` の結果も Web に反映される。同じ入力は同じ検証結果になる。
13. Given Intent を作成した / When Outcome を作成せずに Project 画面・API を確認 / Then Outcome は自動生成されず、Research / Strategist の状態も保存・表示されない。Research 無しで Outcome を作成できる。
14. Given 既存の Project・Intent 操作 / When Outcome 機能を追加 / Then 既存 API・MCP・UI の応答の形は変わらない（Intent 放棄時の Outcome 取消と、Outcome を持つ Intent の意味変更拒否を除く）。

## Step 3 に含めないもの

Evaluation / Evidence / Research / Decision Entity、Outcome の `evaluating` / `achieved` / `not_achieved` 遷移、成功条件の構造化（kind / operator / 単位 / 観測 window）、Outcome の階層・優先順位・`constraints`、Outcome の Wacha への参照・複製・Execution 連携、Strategist・Researcher の起動と Runtime 連携、認証・Role 検証、楽観ロック。

## 選択理由と将来変更できる箇所

| 選択 | 理由 | 将来の変更点 |
| --- | --- | --- |
| 作成時に成功条件を固定、`proposed` なし | 追加資料 10「作成時に固定」に忠実。固定時点を 1 つにし、下書き中の編集規則と活性化操作を省く | 下書きが必要になれば `proposed` と活性化操作を追加する（既存の `active` データは互換） |
| 変更は cancel + 新規作成 | 履歴を書き換えず、Evaluation 導入後も条件の一貫性を保てる | 版管理が必要なら Outcome の version / `priorOutcomeId` を追加する |
| `rationale` を Outcome に必須で同居 | Outcome が Decision の結果であることを最小コストで残す。Decision Entity が無い | Decision 導入時に `rationale` を初期 Decision へ移し、`originDecisionId` を追加する |
| Research 参照を持たない | Research は任意で、Entity も未実装。固定的な中間工程にしない | Research 導入時に `subjectType` / `subjectId` で Outcome に紐づける（Outcome 側の項目追加は不要） |
| 成功条件は自由記述 3 項目 | Evaluation が無く、構造化しても使われない | Evaluation 導入時に kind / operator / 単位 / window を追加し、自由記述は `measurement` に残す |
| active Outcome の複数並行、上限なし | 追加資料の「Active Outcomes」複数形と整合。制限は後から掛けるほうが、緩和より移行が容易 | 1 件に絞る場合は Outcome 作成時の検査と部分一意 index を追加する（既存に複数 active がある場合は先に整理が必要） |
| フラット、priority なし | 追加資料 32.4 が階層化に慎重。順序付けは Strategist の優先判断の実装と一緒に決めるべき | `parentOutcomeId` / `priority` を nullable で追加する |
| Intent 放棄で active Outcome を連動 cancel | 放棄された Intent に active Outcome を残さない最小規則 | Evaluation / Execution 導入後は、進行中 Execution の停止要求を併せて扱う |
| Outcome を持つ Intent は意味変更不可（title のみ可） | Outcome と rationale の根拠を保つ。kit/docs の「active 後の意味変更は放棄 + 新 Intent」に沿う | 意味変更を許す場合は、Decision による訂正の追記を前提にする |
| MCP でも書込を公開 | Step 1・2 と同じ trusted local 前提。Human と Agent の同一入口を保つ | 認証・actor 記録の導入時に、Strategist 以外の書込制限を検討する |
| ネストした API、応答の非埋め込み | Project / Intent の既存契約を変えず、ID の取り違えを 404 で区別する | 必要になれば Intent 応答へ Active Outcome の要約を追加する |

## 実装状況

Task 09 時点で **未実装**（仕様のみ）。Task 10 で実装し、実装状況と検証結果を本書の末尾に追記する。この仕様で Task 10 は着手可能であり、ユーザー確認待ちは設けない。
