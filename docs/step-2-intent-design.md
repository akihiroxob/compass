# Step 2: Intent 初期仕様

> **状態: Step 2 の初期仕様（確定）。Task 08 で実装済み（「実装状況と検証」参照）。**
> 事前のユーザー確認は設けない。追加資料に定めのない事項は、既存設計との整合、単純さ、将来の変更容易性を基準に初期値を選んだ。完成後のフィードバックに応じて修正する。選択理由と将来の変更点は各節と「将来変更できる箇所」に記録する。

## 根拠資料と優先順位

| 区分 | 資料 | 扱い |
| --- | --- | --- |
| 主根拠 | `kit/additional-doc.md` | 構想・責務境界の根拠。「候補」「未決定」とある事項は、本書が初期値として選択した |
| 主根拠（優先） | `kit/additional-doc-2.md` | Direction Loop の Intent → Strategist → (Research) → Outcome。`additional-doc.md` の固定的な `Intent → Research → Outcome` 図と矛盾する場合はこちらを優先する |
| 補助 | `kit/docs/*` | 初期設計のデフォルト（`kit/README.md` が「過去会話の確定事項ではない」と明記）。参考にするが自動採用しない |

補助資料との差異: `kit/docs/autonomy-and-roles.md` は `IntentActivated → Researcher を起動` とするが、追加資料2は「Intent が作られたら必ず Researcher を起動する」ルールを Runtime に持たせないとしている。本書は追加資料2に従い、kit 側の該当記述は採用しない。

## 資料が定めていること・初期値として選んだこと

### 追加資料が定めていること

- Intent は Human が与える最上位の目的で、長寿命。「何を実装するか」ではない。
- Mission は「永続的な存在理由」、Intent は「Human が現在実現したい状態」（`additional-doc.md` 32.3）。
- Outcome は Intent へ近づくための観測可能な中間目標・仮説で、Intent に属する。
- Project 画面の表示項目に「Active Intent」がある（単数形。Active Outcomes は複数形）。
- Wacha は Intent の詳細を持たない（Reference のみ）。Compass は Task / Claim / Agent Run 等を持たない。
- Intent 作成後は Strategist が起点。Research は必須工程ではなく、Strategist が必要と判断したときの手段（追加資料2）。

### 追加資料が候補・未決定としており、本書が初期値を選んだこと

| 事項 | 追加資料 | 本書の初期値 |
| --- | --- | --- |
| Intent Status | `active` / `achieved` / `abandoned` は候補 | この3状態を採用。`draft` は設けない |
| 同時 Active | 未決定（32.3） | Project につき最大1件 |
| 入力項目・更新規則・遷移の権限 | 定めなし | 下記の各節のとおり |

`kit/docs/domain-model.md` の `title / desiredState / completionDefinition` は項目名の参考にした。`draft` 状態、active 後の意味変更禁止、`achieved` に Decision / Evidence を要求する規則は、Step 2 に Outcome・Decision・Evidence が存在しないため採用していない。

## Mission と Intent の違い

| 観点 | Mission | Intent |
| --- | --- | --- |
| 問い | なぜこの Project が存在するか | 今、何を実現したいか |
| 寿命 | 長期間変わりにくい | 長寿命だが、達成・放棄で終わりうる |
| 数 | Project に1つ | 0件以上。ただし Active は最大1件 |
| 保持場所 | Project aggregate 内（Step 1 実装済み） | Project に属する別 Entity |
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
| Human | Intent を与える | Web / MCP から Intent を登録・参照・編集・放棄 |
| Compass (Direction) | Intent の保存・検証・参照 | **実装対象**。Strategist を起動しない |
| Strategist | Intent を起点に、Outcome を定義できるか、Research が必要かを判断する。出力は Outcome / Research Request / Decision / Intent Completion | **未実装**。役割は文書のみ。Intent 作成が Strategist 起動を意味する表示をしない |
| Researcher | Strategist の意思決定の不確実性を減らす。Findings / Evidence / Options / Risks / Unknowns を返す。Outcome は決めない。**必須工程ではない** | **未実装**。Research Entity も作らない |
| Runtime / Orchestrator | 「Intent created」の条件成立で Strategist を起動する。Research の要否は判断しない | **未実装**。イベント配送（outbox 等）も Step 2 に含めない |
| Wacha | Execution。Intent の詳細は持たない | 連携しない |

原則: 「Workflow が判断しない。Agent Role が判断する」。Intent 作成後の状態遷移に `researching` のような固定の Research 状態を置かない。Intent 作成後に Researcher を自動で必須起動する固定フローを実装しない。

## Intent の項目

| 項目 | 必須 | 規則 |
| --- | --- | --- |
| id / projectId | server 生成 | 所属 Project を固定。作成後は変更不可 |
| title | 必須 | trim 後 1〜100 文字。一覧・詳細の見出し |
| desiredState | 必須 | trim 後 1〜2,000 文字。「Human が実現したい状態」。Human の原文を保持する |
| completionDefinition | 任意 | trim 後最大 2,000 文字。空文字は `null`。「何が示されれば Intent 全体が完了と言えるか」 |
| status | server 管理 | 下記の状態参照 |
| abandonedReason | server 管理・任意 | 放棄時のみ。任意テキスト（trim 後最大 2,000 文字、空は `null`） |
| createdAt / updatedAt | server 生成 | 更新時に updatedAt を更新 |

- Intent 用の入力 schema は `src/shared/` に置き、Web API と MCP が共通の検証を使う（Project と同じ方針）。
- `completionDefinition` を必須にすると、Human が完了条件を決められない Intent を登録できない。Outcome の成功条件は Step 3 で扱うため、Step 2 では任意にする。

## 状態と遷移

状態は `active` / `achieved` / `abandoned` の3つ。`draft` は設けない（追加資料の候補に忠実で、最小構成。保留登録が必要になれば後続で追加できる）。

| 遷移 | Step 2 | 理由 |
| --- | --- | --- |
| 作成 → `active` | 公開する | 登録＝現在の方向 |
| `active` → `abandoned` | 公開する（Human の明示操作。理由は任意） | Evidence / Decision を必要としない。誤登録の取り下げに必要 |
| `active` → `achieved` | **公開しない（後続へ送る）** | 達成の根拠となる Decision / Evaluation / Evidence が Step 2 に存在せず、根拠なしに達成扱いできる経路を作らない。状態値としては定義しておく |
| 終端（`achieved` / `abandoned`）からの復帰 | 作らない | 再開は新しい Intent とする |

汎用の「status を任意に書き換える」操作は作らず、遷移は `abandon` のような明示的な操作にする。Active があると新しい Intent は先に放棄しないと登録できない（`draft` を設けないことの帰結）。

## 同時 Active

- **Active Intent は Project につき最大1件**。
- 2件目の作成は `409 CONFLICT`（既存 Active の ID を返す）で拒否する。
- DB では `project_id` への部分一意 index（`WHERE status = 'active'`）で強制し、アプリケーション層でも検査する。UI の非活性化だけに頼らない。
- 選択理由: Project 画面の「Active Intent」単数形と整合し、Step 3 の Outcome 並行数の議論を単純にする。複数 Active は表示・Strategist の起動条件・Intent 間の優先順位調停が複雑になる。

## 更新規則

- `active` の間は title / desiredState / completionDefinition の3項目を Human が編集できる（updatedAt を更新）。
- `abandoned` / `achieved` は編集不可。
- 更新は Project の編集と同じ部分更新方式: 未指定は変更なし、`completionDefinition` は `null` / 空文字でクリア、title / desiredState は空白のみを拒否する。
- Outcome 追加後の変更規則（Intent の意味変更を許すか等）は **Step 3 で固定する**（[step-3-outcome-design.md](step-3-outcome-design.md) の「Intent との関係」: Outcome を持つ Intent は `desiredState` / `completionDefinition` の変更不可、`title` のみ可。Task 10 で実装）。Step 2 では Outcome / Decision が無く、履歴を壊す参照者がいないため、編集を許す。

## Web / MCP 操作

trusted local 前提（Step 1 と同じ。認証・Role 検証なし）で、Web と MCP の双方に作成・参照・更新・放棄を公開する。どちらも共通の application 処理と入力 schema を使う。

Web API はすべて `projectId` 配下にネストし、ID の取り違えを `404` で区別する（他 Project の Intent ID を指定しても取得・更新できない）。

| 操作 | Web API | MCP tool |
| --- | --- | --- |
| 作成 | `POST /api/projects/:projectId/intents` → 201 | `create_intent` |
| 一覧 | `GET /api/projects/:projectId/intents` | `list_intents` |
| 詳細 | `GET /api/projects/:projectId/intents/:intentId` | `get_intent` |
| 更新 | `PATCH /api/projects/:projectId/intents/:intentId` | `update_intent` |
| 放棄 | `POST /api/projects/:projectId/intents/:intentId/abandon` | `abandon_intent` |

- 既存の Project 用 API / MCP tool の入出力は変えない。Project 応答へ Intent を埋め込まず、Project 画面は Intent 一覧 API を別に呼ぶ。
- エラー: 入力違反 `400 VALIDATION_ERROR`（項目 path 付き）、Project / Intent なし `404 NOT_FOUND`（どちらが無いかを区別）、Active 重複と非 Active への更新・放棄 `409 CONFLICT`。予期しない失敗は `500`。
- MCP は認証なしのため principal を持たず、「Agent が Human の Intent の意味を書き換えない」規則は Step 2 では強制できない。この制約を受け入れて公開する。actor / role の記録と書込権限の分離は Step 2 に含めず、将来の変更点とする。

## 永続化

Kysely / SQLite。`intent` table を追加する。DB schema 変更は Task 08 の明示的な実装範囲に含まれる。

```text
intent
  id, project_id (FK → project.id, on delete cascade),
  title, desired_state, completion_definition,
  status, abandoned_reason (nullable),
  created_at, updated_at
  UNIQUE INDEX (project_id) WHERE status = 'active'
```

- 親 Project と別 Entity にするため、Project aggregate（`Project` 型・既存 API 応答）は変更しない。
- 既存の idempotent な `initializeSchema` に追加する。既存 DB への影響は `create table if not exists` / `create unique index if not exists` のみ。

## Web UI

- Project 詳細に「Intent」section を追加する。Active Intent があれば title / desiredState / completionDefinition を表示し、無ければ「Intent は未登録です」と明示する。過去（achieved / abandoned）の一覧は折りたたみ表示。
- ルーティング: `/projects/:projectId/intents/new`（作成）、`/projects/:projectId/intents/:intentId`（詳細）、`.../edit`（編集）。放棄は詳細画面から確認を挟んで実行する。
- Active 重複時は 409 を入力エラーと区別し、既存 Active Intent への導線を示す。
- **表示しないもの**: Strategist の稼働状況、Research の進行、Outcome、Execution Summary。未実装の機能を「待機中」などと架空表示しない。
- 項目別エラー・通信障害の区別・キーボード操作・狭い画面は Step 1 のフォームと同じ基準。

## 受け入れ例（Task 08 の確認対象）

1. Given Project に Intent が無い / When title と desiredState で Intent を作成 / Then `active` で保存され、Project 詳細に表示される。再起動後も同じ ID・内容で取得できる。
2. Given Project に Active Intent がある / When 別の Intent を作成 / Then `409` となり、既存 Intent は変わらない。
3. Given 別々の Project A と B / When A の Intent ID を B の URL で参照・更新・放棄 / Then `404` で、A の内容は露出せず変更もされない。
4. Given 存在しない projectId / When Intent を作成 / Then Project の `NOT_FOUND`。存在しない intentId は Intent の `NOT_FOUND` と区別できる。
5. Given 空白のみの title / desiredState、上限超過 / When 作成・更新 / Then Web API と MCP が同じ規則で `VALIDATION_ERROR` を返し、データは変わらない。
6. Given Active Intent / When `completionDefinition` を空文字で更新 / Then `null` になり、他項目は変わらない。
7. Given Active Intent / When Web で編集し、MCP `get_intent` で参照 / Then 同じ内容が見え、MCP `update_intent` の変更も Web に反映される。
8. Given Active Intent / When `abandon`（理由あり・なし） / Then `abandoned` になり編集不可。その後は新しい Intent を作成できる。`achieved` へ遷移する公開操作は存在しない。
9. Given Intent を作成した / When Project 画面・API を確認 / Then Strategist・Research・Outcome の状態は表示・保存されず、Researcher の自動起動フローも存在しない。
10. Given 既存の Project 操作 / When Intent 機能を追加 / Then 既存 Project の API・MCP・UI の応答は変わらない。

## Step 2 に含めないもの

Outcome / SuccessCriterion、Research / Evidence / Decision / Evaluation Entity、Strategist・Researcher の起動と Runtime 連携、イベント配送（outbox）、Wacha 連携、Intent の `achieved` 遷移、認証・Role 検証、Project の状態（paused / archived）。

## 選択理由と将来変更できる箇所

| 選択 | 理由 | 将来の変更点 |
| --- | --- | --- |
| Active 最大1件 | 「Active Intent」単数形との整合、Step 3 の単純化 | 複数 Active を許す場合は部分一意 index を外し、Outcome 優先順位の規則を追加する |
| `draft` なし | 追加資料の候補に忠実、最小構成 | 保留登録が必要になれば状態と活性化操作を追加する（既存データは互換） |
| `achieved` は未公開 | 達成の根拠 Entity が未実装 | Decision / Evidence 実装後に、根拠付きの `achieve` 操作を追加する |
| active 中は3項目を編集可 | Outcome / Decision が無く履歴を壊さない | Step 3 で Outcome 追加後の変更規則（意味変更の禁止、放棄＋新規への誘導等）を固定する |
| MCP でも書込を公開 | Step 1 と同じ trusted local 前提。Human と Agent の同一入口を保つ | 認証・actor 記録の導入時に、Agent による書込の制限を検討する |
| ネストした API、応答の非埋め込み | Project の既存契約を変えず、ID 取り違えを 404 で区別する | 必要になれば Project 応答へ Active Intent の要約を追加する |

## 実装状況と検証

実装済み（Task 08）: `intent` table（部分一意 index）、`Intent` / `IntentRepository`、5つの use case、`shared/intentSchema.ts`、Web API、MCP tool 5件、Project 詳細の Intent section と作成・詳細・編集・放棄画面。

| 区分 | 実装 |
| --- | --- |
| Web API | `POST/GET /api/projects/:projectId/intents`、`GET/PATCH .../intents/:intentId`、`POST .../intents/:intentId/abandon`（本文なしは理由なし）。応答は `{ intent }` / `{ intents }` |
| MCP | `create_intent` / `list_intents` / `get_intent` / `update_intent` / `abandon_intent`。応答は Intent 本体（一覧は `{ intents }`）。Project tool の入出力は不変 |
| エラー | `VALIDATION_ERROR`（400、`Intent input is invalid`）、`NOT_FOUND`（404。メッセージ先頭が `Project <id>` か `Intent <id>` かで区別）、`CONFLICT`（409。Active 重複は `activeIntentId`、非 Active への更新・放棄は `status` を含む） |
| UI | `/projects/:projectId/intents/new`、`.../intents/:intentId`、`.../intents/:intentId/edit` |

仕様との差異・補足:

- 入力検証は作成・更新・放棄とも use case 内で行う。無効な入力は Project の存在確認より先に `VALIDATION_ERROR` になる（Project 更新と同じ順序）。
- 更新入力に `status` など未知の項目が含まれても無視され、状態は変わらない。
- MCP の tool 入力 schema は型だけを宣言し、文字数上限などは共通 schema（Web API と同一）で検証する。

検証（自動）: `npm test`（Intent の永続化・再起動後保持・部分一意 index・別 Project 混同・409・validation・Web と MCP の相互参照・既存 Project tool 不変）、`npm run typecheck`、`npm run lint`、`npm run build`。単独起動で作成 → 409 → 再起動 → `GET`・MCP `list_intents` で保持を確認した。

画面確認手順（手動）: `npm start` 後、Project 詳細で「Intentを登録」→ 詳細で編集・放棄（確認パネル）→ 過去の Intent が折りたたみに表示されることを確認する。Active がある状態で `/projects/<id>/intents/new` から登録すると、競合エラーと Active Intent への導線が表示される。

## 未実施・制約

- 実ブラウザでの Intent 画面の目視・keyboard 操作・狭い画面の確認は未実施（この実行環境から実ブラウザを操作していない）。型検査・build・API smoke のみ。
- 同時編集の検出（楽観ロック）はなく、後から保存した内容が反映される。
- Biome は本リポジトリに未導入のため、`lint` は型検査のみ。
- Step 1 の実ブラウザでの目視・keyboard・responsive 確認は未完了のまま（`docs/step-1-verification.md` 参照）。これは別の検証事項として残り、Step 2 の着手を止めない。確認結果が得られたら Step 1 の検証記録へ追記する。
