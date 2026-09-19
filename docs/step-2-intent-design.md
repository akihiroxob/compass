# Step 2: Intent 仕様ドラフト（未合意）

> **状態: ドラフト。ユーザーの合意前であり、実装（Task 08）へ進まない。**
> 本書の「提案」「推奨」は確定事項ではない。合意が必要な事項は末尾の「ユーザー判断が必要な質問」にまとめる。

## 根拠資料と優先順位

| 区分 | 資料 | 扱い |
| --- | --- | --- |
| 主根拠 | `kit/additional-doc.md` | 構想・責務境界の根拠。ただし「候補」「未決定」とある事項は確定扱いしない |
| 主根拠（優先） | `kit/additional-doc-2.md` | Direction Loop の Intent → Strategist → (Research) → Outcome。`additional-doc.md` の固定的な `Intent → Research → Outcome` 図と矛盾する場合はこちらを優先する |
| 補助 | `kit/docs/*` | 初期設計のデフォルト（`kit/README.md` が「過去会話の確定事項ではない」と明記）。参考にするが自動採用しない |

補助資料との差異: `kit/docs/autonomy-and-roles.md` は `IntentActivated → Researcher を起動` とするが、追加資料2は「Intent が作られたら必ず Researcher を起動する」ルールを Runtime に持たせないとしている。本書は追加資料2に従い、kit 側の該当記述は採用しない。

## 資料から確定していること・いないこと

### 確定（追加資料による）

- Intent は Human が与える最上位の目的で、長寿命。「何を実装するか」ではない。
- Mission は「永続的な存在理由」、Intent は「Human が現在実現したい状態」（`additional-doc.md` 32.3）。
- Outcome は Intent へ近づくための観測可能な中間目標・仮説で、Intent に属する。
- Project 画面の表示項目に「Active Intent」がある（単数形。Active Outcomes は複数形）。
- Wacha は Intent の詳細を持たない（Reference のみ）。Compass は Task / Claim / Agent Run 等を持たない。
- Intent 作成後は Strategist が起点。Research は必須工程ではなく、Strategist が必要と判断したときの手段（追加資料2）。

### 候補・未決定（確定扱いしない）

- Intent Status 候補: `active` / `achieved` / `abandoned`（`additional-doc.md` 8。候補と明記）。
- 複数 Intent の同時 Active をどこまで許すか（同 32.3。未決定）。
- Intent の入力項目、更新規則、状態遷移の権限。追加資料に定めがない。
- `kit/docs/domain-model.md` の `title / desiredState / completionDefinition`、`draft` 状態、Project につき active 最大1、active 後の意味変更禁止は **kit 補助資料のデフォルト**であり、未合意。

## Mission と Intent の違い

| 観点 | Mission | Intent |
| --- | --- | --- |
| 問い | なぜこの Project が存在するか | 今、何を実現したいか |
| 寿命 | 長期間変わりにくい | 長寿命だが、達成・放棄で終わりうる |
| 数 | Project に1つ | 0件以上（同時 Active 数は未決定） |
| 保持場所 | Project aggregate 内（Step 1 実装済み） | Project に属する別 Entity（提案） |
| 抽象度 | 最も高い | Mission より具体的だが、Outcome より抽象的 |
| 例 | 「協調基盤を提供する」 | 「Human が Intent を与えるだけで Agent 群がソフトウェアを改善できる状態にする」 |

Intent は Mission を言い換えたものにしない。また Task や実装手段を Intent にしない（例:「Claim を二重取得させない実装をする」は Outcome / Task 側）。

## 責務境界（Direction Loop の入口）

```text
Human → Intent 登録 (Compass)
          ↓  [Step 2 では未接続]
      Strategist ─┬─ 情報十分 → Outcome
                  └─ 情報不足 → Research Request → Researcher → Strategist → Outcome
```

| 主体 | 責務 | Step 2 での扱い |
| --- | --- | --- |
| Human | Intent を与える | Web / MCP から Intent を登録・参照・編集 |
| Compass (Direction) | Intent の保存・検証・参照 | **実装対象**。Strategist を起動しない |
| Strategist | Intent / Evaluation を受け、Outcome を定義できるか、Research が必要かを判断する。出力は Outcome / Research Request / Decision / Intent Completion | **未実装**。役割は文書のみ。Intent 作成が Strategist 起動を意味する表示をしない |
| Researcher | Strategist の意思決定の不確実性を減らす。Findings / Evidence / Options / Risks / Unknowns を返す。Outcome は決めない | **未実装**。Research Entity も作らない |
| Runtime / Orchestrator | 「Intent created」の条件成立で Strategist を起動する。Research の要否は判断しない | **未実装**。イベント配送（outbox 等）も Step 2 に含めない |
| Wacha | Execution。Intent の詳細は持たない | 連携しない |

原則: 「Workflow が判断しない。Agent Role が判断する」。Intent 作成後の状態遷移に `researching` のような固定の Research 状態を置かない。

## Intent の項目（提案）

以下は設計上の提案で、合意までは確定事項ではない。項目名は kit の `domain-model.md` に合わせた。

| 項目 | 必須 | 規則（提案） |
| --- | --- | --- |
| id / projectId | server 生成 | 所属 Project を固定。作成後は変更不可 |
| title | 必須 | trim 後 1〜100 文字。一覧・詳細の見出し |
| desiredState | 必須 | trim 後 1〜2,000 文字。「Human が実現したい状態」。Human の原文を保持する |
| completionDefinition | 任意 | trim 後最大 2,000 文字。空文字は `null`。「何が示されれば Intent 全体が完了と言えるか」 |
| status | server 管理 | 下記の状態参照 |
| createdAt / updatedAt | server 生成 | 更新時に updatedAt を更新 |

- Intent 用の入力 schema は `src/shared/` に置き、Web API と MCP が共通の検証を使う（Project と同じ方針）。
- `completionDefinition` を必須にすると、Human が完了条件を決められない Intent を登録できない。一方 Outcome の成功条件は Step 3 で扱うため、Step 2 では任意を推奨する（Q3）。

## 状態と遷移

### 選択肢

| 案 | 状態 | 長所 | 短所 |
| --- | --- | --- | --- |
| A（推奨） | `active` / `achieved` / `abandoned`（追加資料の候補どおり） | 資料に忠実。最小 | 既に active があると新しい Intent を保留登録できない |
| B | `draft` を加えた4状態（kit 案） | 保留登録・下書き編集ができる | 追加資料にない状態を増やす。活性化 Command が必要 |

### Step 2 で許す遷移の案

| 遷移 | 案 | 理由 |
| --- | --- | --- |
| 作成 → `active` | 実装する | 登録＝現在の方向 |
| `active` → `abandoned` | 実装する（Human の明示操作。理由は任意テキスト） | Evidence / Decision を必要としない。誤登録の取り下げに必要 |
| `active` → `achieved` | **Step 2 では公開しない** | kit は「Decision と根拠となる Evaluation / Evidence」を要求する。これらの Entity は Step 2 に存在せず、Human が根拠なしに達成扱いできる経路を作らない |
| 終端からの復帰 | 作らない | 再開は新しい Intent とする |

汎用の「status を任意に書き換える」操作は作らず、遷移は `abandon` のような明示的な操作にする。

## 同時 Active

| 案 | 内容 | 影響 |
| --- | --- | --- |
| 1（推奨） | Project につき Active は最大1。2件目は `409 CONFLICT`（既存 Active の ID を返す）。DB では `project_id` への部分一意 index で強制 | Project 画面の「Active Intent」単数形と整合。Step 3 の Outcome 並行数の議論を単純にする。案 A（draft なし）では、2件目を登録するには先に 1件目を放棄する必要がある |
| 2 | 複数 Active を許可 | 表示・Strategist の起動条件が複雑になる。Outcome の優先順位を Intent 間で調停する規則が別途必要 |
| 3 | 上限 N 件 | N の根拠となる資料がない |

推奨案 1 は状態強制をアプリケーション層と DB 制約の両方で行う。UI の非活性化だけに頼らない。

## 更新規則

| 案 | 内容 | 影響 |
| --- | --- | --- |
| 1（推奨） | `active` の間は title / desiredState / completionDefinition を Human が編集できる（updatedAt 更新）。`abandoned` / `achieved` は編集不可 | Step 2 には Outcome / Decision が無く、履歴を壊す参照者がいない。ただし Step 3 で Outcome が付いた後の編集可否は Step 3 で再合意する |
| 2 | active 後の意味変更を禁止し、変更は abandon + 新規 Intent（kit 案） | 履歴が保たれる。誤字修正もできない |
| 3 | 誤字などの軽微な修正のみ許し意味変更を禁止 | 「軽微」を機械判定できない |

更新は Project の編集と同じ部分更新方式（未指定は変更なし、`completionDefinition` は `null` / 空文字でクリア、title / desiredState は空白のみを拒否）を提案する。

## Web / MCP 操作（提案）

Web API はすべて `projectId` 配下にし、ID の取り違えを `404` で区別する（他 Project の Intent ID を指定しても取得・更新できない）。

| 操作 | Web API | MCP tool |
| --- | --- | --- |
| 作成 | `POST /api/projects/:projectId/intents` → 201 | `create_intent` |
| 一覧 | `GET /api/projects/:projectId/intents` | `list_intents` |
| 詳細 | `GET /api/projects/:projectId/intents/:intentId` | `get_intent` |
| 更新 | `PATCH /api/projects/:projectId/intents/:intentId` | `update_intent` |
| 放棄 | `POST /api/projects/:projectId/intents/:intentId/abandon` | `abandon_intent` |

- 既存の Project 用 API / MCP tool の入出力は変えない（Project 詳細への Intent 埋め込みもしない）。Project 画面は Intent 一覧 API を別に呼ぶ。
- エラー: 入力違反 `400 VALIDATION_ERROR`（項目 path 付き）、Project / Intent なし `404 NOT_FOUND`（どちらが無いかを区別）、Active 重複 `409`。予期しない失敗は `500`。
- MCP はローカル・認証なしの前提（Step 1 と同じ）。principal を持たないため、「Agent が Human の Intent の意味を書き換えない」規則は **Step 2 では強制できない**（Q6）。actor / role の記録は Step 2 に含めない。

## 永続化（提案）

Kysely / SQLite。`intent` table を追加する。実装時に DB schema 変更が発生するため、Task 08 で明示的な許可範囲として扱う。

```text
intent
  id, project_id (FK → project.id, on delete cascade),
  title, desired_state, completion_definition,
  status, abandoned_reason (nullable),
  created_at, updated_at
  UNIQUE INDEX (project_id) WHERE status = 'active'
```

- 親 Project と別 Entity にするため、Project aggregate（`Project` 型・既存 API 応答）は変更しない。
- 既存の idempotent な `initializeSchema` に追加する。既存 DB への影響は `create table if not exists` のみ。

## Web UI（提案）

- Project 詳細に「Intent」section を追加する。Active Intent があれば title / desiredState / completionDefinition を表示し、無ければ「Intent は未登録です」と明示する。過去（achieved / abandoned）の一覧は折りたたみ表示。
- ルーティング案: `/projects/:projectId/intents/new`（作成）、`/projects/:projectId/intents/:intentId`（詳細）、`.../edit`（編集）。
- Active 重複時は 409 を入力エラーと区別し、既存 Active Intent への導線を示す。
- **表示しないもの**: Strategist の稼働状況、Research の進行、Outcome、Execution Summary。未実装の機能を「待機中」などと架空表示しない。
- 項目別エラー・通信障害の区別・キーボード操作・狭い画面は Step 1 のフォームと同じ基準。

## 受け入れ例（合意後の Task 08 の確認対象）

1. Given Project に Intent が無い / When title と desiredState で Intent を作成 / Then `active` で保存され、Project 詳細に表示される。再起動後も同じ ID・内容で取得できる。
2. Given Project に Active Intent がある / When 別の Intent を作成 / Then `409` となり、既存 Intent は変わらない（推奨案 1・案 A の場合）。
3. Given 別々の Project A と B / When A の Intent ID を B の URL で参照・更新 / Then `404` で、A の内容は露出せず変更もされない。
4. Given 存在しない projectId / When Intent を作成 / Then Project の `NOT_FOUND`。存在しない intentId は Intent の `NOT_FOUND` と区別できる。
5. Given 空白のみの title / desiredState、上限超過 / When 作成・更新 / Then Web API と MCP が同じ規則で `VALIDATION_ERROR` を返し、データは変わらない。
6. Given Active Intent / When `completionDefinition` を空文字で更新 / Then `null` になり、他項目は変わらない。
7. Given Active Intent / When Web で編集し、MCP `get_intent` で参照 / Then 同じ内容が見え、MCP `update_intent` の変更も Web に反映される。
8. Given Active Intent / When `abandon` / Then `abandoned` になり編集不可。その後は新しい Intent を作成できる。`achieved` へ遷移する公開操作は存在しない。
9. Given Intent を作成した / When Project 画面・API を確認 / Then Strategist・Research・Outcome の状態は表示・保存されない。
10. Given 既存の Project 操作 / When Intent 機能を追加 / Then 既存 Project の API・MCP・UI の応答は変わらない。

## Step 2 に含めないもの

Outcome / SuccessCriterion、Research / Evidence / Decision / Evaluation Entity、Strategist・Researcher の起動と Runtime 連携、イベント配送（outbox）、Wacha 連携、Intent の `achieved` 遷移、認証・Role 検証、Project の状態（paused / archived）。

## ユーザー判断が必要な質問

各質問に推奨案を添える。回答が来るまで Task 08 は詳細化・実装しない。

1. **同時 Active（Q1）**: Project につき Active Intent を最大1件にしてよいか（推奨）。それとも複数許可か。
2. **draft（Q2）**: 追加資料の候補どおり `active / achieved / abandoned` の3状態で始めるか（推奨）。それとも保留登録用に `draft` を加えるか。3状態の場合、Active があると新しい Intent は先に放棄しないと登録できない。
3. **項目（Q3）**: title・desiredState を必須、completionDefinition を任意でよいか（推奨）。completionDefinition を必須にするか。文字数上限（100 / 2,000 / 2,000）はこれでよいか。
4. **更新規則（Q4）**: Active の間は Human が意味を含めて編集できることでよいか（推奨）。それとも kit 案の「Active 後は変更禁止、変更は放棄＋新規」か。
5. **状態遷移（Q5）**: Step 2 では Human による `abandon` のみ公開し、`achieved` は Decision / Evidence が揃う後続 Step まで公開しないことでよいか（推奨）。放棄理由は任意でよいか。
6. **MCP の公開範囲（Q6）**: Step 2 で Intent の作成・更新・放棄を MCP に公開してよいか。認証がないため、Agent が Human の Intent を書き換えられる。Step 1 と同じ trusted local 前提として許容するか、Step 2 は MCP を参照系（`list_intents` / `get_intent`）に限るか（後者も選択肢。書込は Web のみ）。
7. **URL・応答（Q7）**: API を `projectId` 配下のネストにし、既存 Project 応答へ Intent を埋め込まない方針でよいか（推奨）。

## 未実施・制約

- 本書は資料の整理であり、実装・テストの追加は行っていない。
- Step 1 の実ブラウザでの目視・keyboard・responsive 確認は未完了のまま（`docs/step-1-verification.md` 参照）。本 Task の作業は止めない条件とされている。確認結果が得られたら Step 1 の検証記録へ追記する。
