# Step 4: Strategist Role と認可境界 初期設計

> **状態: Step 4 の設計（Task 13）。実装は Task 14〜17 で段階的に進める。**
>
> | 範囲 | 状態 |
> | --- | --- |
> | Grant の永続化・Command API・CLI・Web UI（本書「永続化」「入力規則」「Command API」「CLI」「Web UI」、Task 14 の受け入れ例） | **実装済み**（Task 14）。API・CLI・repository・use case は自動テスト済み。Web UI は型・build と純関数のテストまでで、実ブラウザでの操作確認は未実施 |
> | MCP の Principal 認証、Strategist 認可、`get_strategist_context`、職務分離ガード（「権限表」「認可の順序」「Strategist Context」、Task 15） | **実装済み**（Task 15）。自動テスト済み（`test/strategistMcp.test.ts`）。`get_role_instructions` は Task 16 のため tool 一覧にまだ無い |
> | Instruction 配信（Task 16） | 設計済み・**未実装**（Task 15 の受け入れ例 9 のうち `get_role_instructions` の公開は Task 16 で満たす） |
> | 統合検証（Task 17） | 未実施 |
>
> Outcome 等の現行の挙動は [step-3-outcome-design.md](step-3-outcome-design.md) を参照する。
> 事前のユーザー確認は設けない。追加資料に定めのない事項は、既存設計との整合、単純さ、将来の変更容易性を基準に初期値を選び、理由を「選択理由と将来変更できる箇所」に記録する。

## 根拠資料と優先順位

| 区分 | 資料 | 扱い |
| --- | --- | --- |
| 主根拠 | `kit/additional-doc.md`（Strategist の Goal / Input / Output、Human 介入は最初の Intent 投入のみ、Runtime は戦略判断をしない） | 責務境界の根拠 |
| 主根拠（優先） | `kit/additional-doc-2.md`（Workflow でなく Role が判断する。Research は必須工程でない） | 矛盾時はこちらを優先 |
| 参照実装 | `/Users/aokayama/git/wacha`（`project_grant`、`Authorization: Bearer <AgentName>`、`InstructionService`、`get_role_instructions`、`grant-project-role` script、`RoleGrantDrawer`） | 構成と命名を基準にするが、コードは複製せず Compass の層構成へ適合させる |
| 補助 | `kit/docs/autonomy-and-roles.md` ほか | 初期設計のデフォルト。自動採用しない |

## 設計原則

1. **機械的に完結する**: Role 発行 → Instruction 取得 → Context 取得 → Outcome 作成は、API・CLI・MCP だけで実行できる。Human の確認・承認・画面操作を前提条件・状態遷移・完了条件に入れない。
2. **Web UI は任意**: Human が後から観察し、必要なら同じ application 処理を手で使う入口。UI 固有の確認パネルは手動操作の誤操作防止であり、API / CLI には確認工程を設けない。
3. **Role Grant は Agent を起動しない**: Grant は「この Principal がこの Project で Strategist として振る舞ってよい」という認可の記録。起動条件の監視・Agent 実行・Run の所有は外部 Runtime の責務で、Compass に持ち込まない（追加資料2: Runtime は「どの Role を起動する条件が成立したか」だけを扱う）。
4. **認可は application 層**: 認可検査は共通の application service が行い、MCP の handler や Web の route に散らさない。Web / CLI / MCP は同じ use case へ委譲する。
5. **trusted-local**: Wacha と同じく Bearer の値をそのまま Principal とする。秘密の検証はなく**セキュリティ境界ではない**（Agent 名を偽称できる）。信頼できないネットワークへ公開しない。将来の認証 adapter（token / OIDC 等）は `Principal` の解決部分だけを差し替える。

## 用語

| 用語 | 定義 |
| --- | --- |
| Principal | 呼び出し主体。MCP の `Authorization: Bearer <AgentName>` の `<AgentName>`。tool 入力・request body・MCP session ID で指定・上書きしない |
| Role | Principal が Project で担う役割。本 Step では `strategist` のみ。値は `src/constants/ProjectRole.ts`（新規）に置き、追加時に型と検証が追随する |
| Role Grant | `(projectId, principalId, role)` の永続化された許可。Project scope。1 Principal が複数 Project・将来は複数 Role を持てる |
| Operator plane | Web API / Web UI / CLI。Project・Intent・Grant を管理する trusted-local の管理面。**Principal を持たず Role 検証もしない**（Step 1〜3 と同じ）。Human・外部 Runtime・運用スクリプトのいずれもここを使う |
| Agent plane | MCP。Bearer で Principal を解決し、tool ごとに Grant を検査する |

## 権限表

`✓` 許可、`✗` 拒否（`FORBIDDEN`）、`—` 該当 tool なし。「Strategist」は対象 Project の Grant を持つ Principal。

### MCP tool

| tool | Strategist | Grant なし・別 Project・取消済み | Bearer なし | 備考 |
| --- | --- | --- | --- | --- |
| `get_role_instructions`（新規） | ✓ | ✓ | ✓ | 静的な Instruction の取得。Role も Bearer も不要（機密を含まない。Agent は起動直後に自力で取得できる） |
| `get_strategist_context`（新規） | ✓ | ✗ | ✗ `UNAUTHENTICATED` | Project・Active Intent・既存 Outcome を返す |
| `create_outcome` | ✓ | ✗ | ✗ `UNAUTHENTICATED` | Outcome + 固定 Success Criteria + rationale の登録（Strategist の Decision の登録） |
| `update_outcome` | ✓ | ✗ | ✗ `UNAUTHENTICATED` | Step 3 の規則のまま（active の title / hypothesis のみ。固定項目は 409） |
| `cancel_outcome` | ✓ | ✗ | ✗ `UNAUTHENTICATED` | 理由必須。成功条件を変える唯一の経路（取消 + 新規作成） |
| `list_outcomes` / `get_outcome` | ✓ | ✓ | ✓ | 読み取りのみ。Step 3 から不変 |
| `update_project` / `create_intent` / `update_intent` / `abandon_intent` | **✗** | ✓（Bearer なしも ✓） | ✓ | Direction の管理操作（Operator plane 相当）。**その Project の Strategist Grant を持つ Principal には拒否**（職務分離。下記） |
| `create_project` / `list_projects` / `get_project` / `list_intents` / `get_intent` | ✓ | ✓ | ✓ | 不変。書込先の Project がまだ無い（`create_project`）か、読み取りのみ |
| Grant の発行・取消・一覧 | — | — | — | **MCP tool を作らない**。Agent が自分の権限を増やせないようにする |
| Success Criterion の編集、Outcome の `achieved` 等への遷移、Task 分解、実行、Research / Evaluation | — | — | — | 対応する tool・API が存在しない（Step 3 から不変） |

- **職務分離ガード**: Strategist は Intent を変更しない。Intent / Project の書込 tool は、Bearer があり、かつその Principal が対象 Project の Strategist Grant を持つ場合に `FORBIDDEN`。検査は application service の 1 箇所（`requireNotRole`）に置く。Bearer なし・Grant なしの呼び出しは従来どおり許可される（Operator plane の互換）。**Agent 名を変えれば回避できるため、trusted-local では「構造上の保証（Strategist 用 tool に Intent 変更が無い）」が本体で、このガードは誤用防止**と位置づける。
- Outcome 書込を Bearer なしで拒否するのは MCP だけ。Web API / UI の Outcome 作成・更新・取消は従来どおり Principal なしで動く（Human の任意操作。既存の Web の挙動を変えない）。
- Outcome に作成者（Principal）を記録する項目は Step 4 では追加しない（DB 変更を最小にする。将来の変更点）。

### Web API（Operator plane）

| 操作 | 認証 | 備考 |
| --- | --- | --- |
| Grant の発行・一覧・取消 | なし（trusted-local） | Human・Runtime・スクリプトが同じ入口を使う。Role 検証なし。401 / 403 を返さない |
| Project / Intent / Outcome の既存 API | なし | 不変 |

## 認可の順序と拒否の仕方

MCP の tool 呼び出しは次の順で処理する。

```text
1. Authorization ヘッダー
   - 無い                         → Principal なし（anonymous）
   - "Bearer <値>" で値が空でない → Principal = <値> を trim
   - 有るが形式不正（別 scheme、値が空、制御文字を含む、101 文字以上）
                                   → HTTP 401（tool へ進まない。anonymous へ黙って降格しない）
2. tool の要求を確認
   - Strategist 要求の tool で Principal なし → UNAUTHENTICATED
3. Project scope の Grant 検査（projectId ごと。Project の存在確認・入力検証より先）
   - Grant 無し（別 Project・取消済み・未発行を区別しない） → FORBIDDEN
4. 入力検証 → Project / Intent / Outcome の存在確認 → 業務処理（Step 3 と同じ順序）
```

- Grant 検査を存在確認より先に置くので、Grant を持たない Principal には **Project が存在するかを漏らさない**（存在しない Project と権限のない Project は同じ `FORBIDDEN`）。
- 検査は tool 呼び出しごとに DB を読む。キャッシュを持たないので**取消は次の呼び出しから即時に反映**される。実行中の呼び出しは検査を通過済みのため完了する（検査と書込を同一 transaction にはしない。将来の変更点）。
- request body の `role`、tool 入力の `principalId`、MCP の session ID は認証情報として読まない。MCP は stateless（`sessionIdGenerator: undefined`）のまま。

### エラーの形

| 状況 | 表現 | 内容 |
| --- | --- | --- |
| Authorization 形式不正 | HTTP `401`、JSON-RPC error（`code: -32001`、message `Authorization: Bearer <AgentName> is malformed`） | tool へ進まない |
| Principal なしで Strategist 要求の tool | tool result `isError: true`、`{ error: { code: "UNAUTHENTICATED", message } }` | HTTP は 200（既存の tool error と同じ扱い） |
| Grant 無し | tool result `isError: true`、`{ error: { code: "FORBIDDEN", message, requiredRole: "strategist", projectId } }` | 存在しない Project でも同じ。message に Project の有無を含めない |
| 入力違反・存在しない・状態競合 | 既存の `VALIDATION_ERROR` / `NOT_FOUND` / `CONFLICT` | Step 3 から不変 |
| Web API の Grant | `400 VALIDATION_ERROR`（path 付き）、`404 NOT_FOUND`（`Project <id>`） | 下記 |

`UnauthenticatedError`（`UNAUTHENTICATED`、REST へ出るなら 401）と `ForbiddenError`（`FORBIDDEN`、403）を `application/error/` に追加し、`app.onError` と MCP の `execute` に対応を足した（実装済み。Web API の現行 route は Principal を扱わないため、REST でこの 2 つが返ることは今は無い）。

実装の配置（Task 15）: Bearer の解決は `presentation/mcp/resolvePrincipal.ts`（規則は Grant の `principalId` と共通の `principalIdSchema`）、`/mcp` の request ごとに `app.ts` が呼び、`createMcpServer(services, principal)` へ渡す。認可は `application/service/ProjectAuthorizationService`（`requireRole` / `requireNotRole`、および検査してから操作を実行する `asRole` / `unlessRole`）。`get_strategist_context` は `GetStrategistContextUseCase` が自分で Grant を検査する。MCP の handler は Principal と projectId を渡すだけで、規則を持たない。

## 永続化

Kysely / SQLite。`initializeSchema` に `create table if not exists` で追加する（既存 table・既存データは変更しない）。

```text
project_grant
  project_id   text not null  FK → project.id  on delete cascade
  principal_id text not null
  role         text not null                       -- check 制約なし（下記）
  created_at   integer not null                    -- epoch（既存 table と同じ）
  PRIMARY KEY (project_id, principal_id, role)
  INDEX (principal_id, project_id)
```

- 主キーが冪等性を担保する。`insert ... on conflict do nothing` で再発行は重複せず、既存行の `created_at` は保持される。
- `role` に DB の check 制約は置かない。Role の妥当性は application 層（`shared/projectGrantSchema.ts`）で検証する。Step 3 の `outcome.status` は check 制約のために予約値を先に入れたが、Role は追加が確実に起こり、SQLite では check の変更に table 再作成が要るため、DB を変えずに Role を増やせるほうを選ぶ。
- Repository interface は `domain/repository/ProjectGrantRepository.ts`: `grant(...)`（新規作成したかを返す）/ `revoke(...)`（削除したかを返す）/ `hasRole(projectId, principalId, role)` / `listByProject(projectId)`。認可判定は `hasRole` を使う。
- 再起動後も保持される（SQLite file）。

## 入力規則（`src/shared/projectGrantSchema.ts`）

Web API・CLI・Web UI が同じ検証を使う（`trimmedText` / `parseWith` を再利用）。

| 項目 | 規則 |
| --- | --- |
| principalId | trim 後 1〜100 文字。制御文字を含まない。大文字小文字を区別する完全一致。Bearer の値と同じ規則で正規化する |
| role | `strategist` のみ。それ以外（空、未知、大文字違い）は `VALIDATION_ERROR`（path `role`） |
| projectId | 存在する Project。無ければ `NOT_FOUND`（`Project <id> was not found`）。入力検証は存在確認より先 |

## Command API（Operator plane）

Wacha の `POST/DELETE /api/projects/:projectId/grants` に倣う。取消だけは、principalId の URL エンコードと冪等性を素直に表せるよう、本文でなく path に置く。

| 操作 | Web API | 成功応答 |
| --- | --- | --- |
| 発行 | `POST /api/projects/:projectId/grants`　本文 `{ "principalId", "role" }` | 新規 `201` / 既存 `200`。`{ "grant": { projectId, principalId, role, createdAt }, "created": true\|false }` |
| 一覧 | `GET /api/projects/:projectId/grants` | `200 { "grants": [ ... ] }`（role、principalId の昇順） |
| 取消 | `DELETE /api/projects/:projectId/grants/:role/:principalId`（principalId は `encodeURIComponent`） | `200 { "revoked": true\|false }`。存在しない Grant の取消も `200 { "revoked": false }`（冪等） |

- 発行の再実行は `200 created:false` で副作用なし。自動化が「既にあったか」を判別できる。
- 取消は別 Project の同名 Grant に影響しない（主キーに `project_id` を含む）。
- CORS の `allowMethods` に `DELETE`、`allowHeaders` に `Authorization` / `Content-Type` を追加する（現状は `GET/POST/PATCH/OPTIONS`）。
- use case: `GrantProjectRoleUseCase` / `RevokeProjectRoleUseCase` / `ListProjectGrantsUseCase`（`application/usecase/`、既存の命名に合わせる）。`container.ts` の `createApplicationServices` に追加する。

## CLI

Wacha の `grant-project-role` と同じく DB へ直接つなぎ、**サーバーを起動していなくても**動く（空 DB からの準備・再起動検証に使うため）。同じ use case と同じ `COMPASS_DB_PATH` を使う。

```bash
npm run cli -- grant  <projectId> <AgentName> strategist
npm run cli -- revoke <projectId> <AgentName> strategist
npm run cli -- grants <projectId>
```

- 標準出力は API と同じ形の JSON（`grant` → `{ grant, created }`、`revoke` → `{ revoked }`、`grants` → `{ grants }`）。エラーは標準エラーへ `{ "error": { "code", "message", "issues"? } }`。
- 終了コード: 成功 `0`、検証・存在・その他の失敗 `1`、引数の不足・未知のサブコマンド `2`。`revoke` で Grant が無い場合も `0`（`revoked:false`）。
- 実装場所は `src/presentation/cli/`。`package.json` に `"cli": "tsx src/presentation/cli/main.ts"` を追加する。
- 実行中のサーバーと同じ DB file を書いても、認可は毎回 DB を読むため取消・発行は即時に反映される。
- 実装上の注意: `container.ts` は import 時に DB を開く。CLI は `createApplicationServices(createDatabase())` を使い、singleton を import しない。factory だけを `src/createApplicationServices.ts` へ移し、`container.ts` は再 export を残した（既存 test の import を変えない最小変更）。CLI の本体は `src/presentation/cli/runCli.ts`（テスト可能な関数）と、DB を開く `main.ts`。

## Web UI（任意）

- **Project 詳細**に「Strategist」section を追加する。`src/frontend/features/grant/`（`index.ts` が公開 API。API client は `api.ts` に追加）。
- 表示: 発行済み Agent 名と発行日時の一覧（0 件なら「Strategist は未割当です」）。発行フォーム（Agent 名の 1 項目）。取消ボタンと確認パネル（既存の確認パネルを再利用）。
- 補足文: 「Agent 名は MCP の `Authorization: Bearer <AgentName>` に設定する名前です。Strategist の割当は Agent を起動しません。」
- 入力エラー（400）・通信障害・存在しない Project は既存フォームと同じ基準で区別して表示し、保存失敗時は入力を保持する。表示しないもの: Agent の稼働状況、Run、Runtime の状態、自動起動の設定。
- UI は API と同じ use case を通るだけで、UI にだけある規則を作らない。
- 実装: 取消の確認パネルは既存の `ReasonPanel` を再利用した。Grant の取消に理由は不要なため、`label` を省略すると理由欄を出さない任意指定を追加した（既存の放棄・取消パネルの挙動は不変）。

## Strategist Context（`get_strategist_context`）

入力 `{ projectId }`。Principal は Bearer から得る。応答:

```json
{
  "principalId": "strategist-agent",
  "role": "strategist",
  "project": { "id": "...", "name": "...", "mission": "...", "vision": null,
               "principles": ["..."], "constraints": ["..."], "repositories": [], "resources": [] },
  "activeIntent": { "id": "...", "title": "...", "desiredState": "...", "completionDefinition": null, "status": "active" },
  "outcomes": [ { "id": "...", "status": "active", "title": "...", "rationale": "...", "successCriteria": [ ... ] } ],
  "unavailable": ["research", "evaluation", "evidence"]
}
```

- `project` は Step 1 の Project 全体（Mission / Vision / Principles / Constraints / Repositories / Resources）。
- `activeIntent` は Project の active Intent（最大 1 件）。無ければ `null`（エラーにしない。Strategist が「今決めることが無い」と判断できる）。`outcomes` は空配列。
- `outcomes` は **Active Intent 配下の全状態の Outcome**（新しい順、成功条件は position 順）。`cancelled` を含め、`cancelReason` も返す。過去に何を試して取り消したかを重複提案の回避に使えるようにする。
- `unavailable` は未実装で、Agent が存在を仮定してはならない入力の静的な一覧。Research Entity・Evaluation・Evidence は Step 4 に無く、Instruction の「Evidence の捏造禁止」と対応する。実装された時点で該当要素を外す。
- application は `GetStrategistContextUseCase`。Grant 検査 → Project 取得 → Intent 一覧から active を選択 → Outcome 取得の順で、既存 Repository を使う（新しい Repository は作らない）。

## Instruction 配信

- `agent/role-policy.md`（共通 Policy）と `agent/strategist.md`（Role 文書）を repo 直下の `agent/` に置く（Wacha と同じ配置）。`InstructionService`（`application/service/`）が `import.meta.url` 基準で読む。
- MCP tool `get_role_instructions({ role: "strategist", includeShared?: boolean })`。応答は Wacha と同形: `{ role, includeShared, files: [{ path, kind: "shared" | "role", content }] }`（`includeShared: true` で `agent/role-policy.md` を先頭に含める）。`role` の enum は `["strategist"]`。
- ファイルが無い・読めない場合は `InstructionUnavailableError`（`INSTRUCTION_UNAVAILABLE`、対象 path を message に含める）を tool error（`isError: true`）で返す。空の応答や黙った代替を返さない。
- Instruction に書く tool 名・権限・エラーコードは、本書の権限表と実装に一致させる（Task 16 で tool 名の一致を test する）。

### `agent/strategist.md` の必須構成（Task 16）

| 節 | 内容 |
| --- | --- |
| Goal | Intent（または将来の Evaluation）を受け、次に追う Outcome を決める |
| Input | `get_strategist_context` の内容: Project の Mission / Vision / Principles / Constraints、Active Intent、既存 Outcome。Evidence 相当は `unavailable` に無いものだけ |
| 判断権限 | 情報が十分なら Outcome を作る。不足なら、Research が必要な問いと不足情報を**作業報告・出力として明示**する（Research の Entity・起動は未実装。Research を必須工程にしない。必要性は Strategist が判断する） |
| Output | Outcome（title / description / hypothesis / rationale）と 1 件以上 10 件以下の観測可能な Success Criterion（description / measurement / target） |
| Allowed | `get_role_instructions` / `get_strategist_context` / `list_outcomes` / `get_outcome` / `create_outcome` / `update_outcome`（title・hypothesis）/ `cancel_outcome` |
| Forbidden | Project・Intent の変更（`update_project` / `create_intent` / `update_intent` / `abandon_intent`）、Task 分解、実行、Evidence の捏造、Outcome の自己評価・達成判定、Success Criterion の作成後の変更（変えるなら cancel + 新規作成）、Grant の操作 |
| 固定ルール | Success Criterion は作成時に固定。`measurement` は「どの証拠があれば成立か」を書く。Agent の「できた」だけを条件にしない |
| Role の意味 | Grant は Project scope の認可で、Agent の起動や Run の所有権ではない |
| 通常フロー | Human の確認・承認・すり合わせを求めない |
| エラー | `UNAUTHENTICATED` / `FORBIDDEN` を受けたら権限の自己拡張を試みず、報告して停止する |

`agent/role-policy.md` は Wacha の内容を踏まえ、Principal / Role Grant / Project scope / trusted-local の注意 / 通常フローに Human 承認を置かないこと / Change の扱いを Compass 向けに短く書く。Manager・Reviewer・Worker・Claim・Story・Task に関する記述は持ち込まない。

## 取消時の挙動

- 取消後の次の tool 呼び出しから `FORBIDDEN`（Grant を毎回 DB から読む）。一覧から消える。
- 過去にその Principal が作成した Outcome・成功条件は変更されず残る（Outcome は Grant に従属しない）。取消は Outcome の連動取消を起こさない。
- 再発行は新しい `createdAt` の Grant を作る（履歴は持たない。将来の変更点）。
- 別 Project の同名 Principal の Grant、別 Role には影響しない。
- Project は削除操作が無いが、削除された場合は外部キーにより Grant も消える。

## 本 Step に含めないもの

Runtime による Agent の自動起動・監視、Research / Researcher Entity・Role、Evaluation・Evidence、Wacha 連携、秘密を検証する認証（token / OIDC）、Strategist 以外の Role、Grant の監査ログ・Change Log、Outcome への作成者（actor）記録、Grant の期限・Claim 相当の排他制御、Human の承認・確認を要する状態遷移。

## 選択理由と将来変更できる箇所

| 選択 | 理由 | 将来の変更点 |
| --- | --- | --- |
| Bearer は Wacha と同じく Agent 名をそのまま Principal | 参照実装と同じ trusted-local。認証 adapter を後から差し替えられる | token / OIDC 検証に置き換える（`Principal` の解決部のみ） |
| Bearer なしを MCP 全体で拒否せず、Strategist 要求の tool でのみ拒否 | 既存の Project / Intent / 読み取りの MCP 利用（Step 1〜3）を壊さない。Task の受け入れ条件は Strategist tool の拒否 | 認証を導入する時に全 tool へ広げる |
| 形式不正の Authorization は 401 | 誤設定を anonymous として黙って通さない | — |
| Web API / CLI は Principal なし・Role 検証なし | 管理面は trusted-local。Human・Runtime・スクリプトが同じ入口を使う（Human 専用にしない） | 管理面の認証を導入する時に Operator Role を追加する |
| 職務分離ガード（Strategist は Intent / Project を書けない） | 権限表の「Strategist は Intent を変更しない」を application 層で表現する。安価に 1 箇所へ置ける | 認証導入後は、管理操作を専用 Role に限定する形へ置き換える |
| Outcome 書込 tool のみ Strategist 必須、読み取りは不変 | 既存の読み取り利用を維持。書込だけが Decision の登録に当たる | 読み取りにも Project scope を課す |
| Grant 検査を存在確認より先に置く | 権限のない Principal に Project の存在を漏らさない | — |
| MCP に Grant 管理 tool を作らない | Agent の権限自己拡張を構造的に防ぐ（Wacha と同じ） | Runtime 向けの管理 API に認証を付けて公開する |
| `role` に DB check を置かない | Role 追加で table 再作成を要さない。検証は application 層 | — |
| 取消は path、発行は本文 | 冪等な取消（`revoked:false`）と URL エンコードを素直に表す | — |
| CLI は DB へ直接つなぐ | サーバー停止中でも準備・検証できる（Wacha と同じ）。認可は毎回 DB を読むので稼働中サーバーへ即時反映 | HTTP client 方式への切替（別ホストの管理） |
| Context に `unavailable` を含める | 未実装の Research / Evaluation / Evidence を Agent が仮定・捏造しない | 実装時に要素を外し、実データを追加する |
| Context の Outcome は全状態 | 取り消した過去の試行を重複提案の回避に使う | 件数が増えたら期間・件数で絞る |

## 後続 Task の受け入れ例

### Task 14: Grant の永続化・Command API・CLI・管理画面

1. Given Project `P` / When `POST /api/projects/P/grants` に `{"principalId":"strat-1","role":"strategist"}` / Then `201`、`created:true`。`GET .../grants` に 1 件。再度同じ本文で `200`、`created:false`、一覧は 1 件のまま、`createdAt` は不変。
2. Given Grant がある / When `DELETE /api/projects/P/grants/strategist/strat-1` / Then `200 {"revoked":true}`、一覧から消える。再実行は `200 {"revoked":false}`。
3. Given Project `P` と `Q` に同じ `strat-1` / When `P` の Grant を取消 / Then `Q` の Grant は残る。
4. Given 存在しない Project / When 発行・一覧・取消 / Then `404`（`Project <id> ...`）。`principalId` が空白のみ・101 文字・制御文字を含む、`role` が空・`worker`・`Strategist` / Then `400 VALIDATION_ERROR`（path `principalId` / `role`）。
5. Given Grant 発行後 / When DB を閉じて同じ file で再起動 / Then 一覧に同じ Grant が残る。
6. Given 空 DB と Project / When `npm run cli -- grant P strat-1 strategist` / Then 標準出力に `{"grant":{...},"created":true}`、終了コード `0`。`grants P` で同じ Grant。`revoke` 後に `grants P` が空。引数不足は終了コード `2`、未知の Project は標準エラーに `NOT_FOUND`、終了コード `1`。
7. Given Web の Project 詳細 / When Agent 名を入力して発行、取消（確認パネル） / Then API と同じ結果が表示され、CLI / API で作った Grant も一覧に出る。
8. 既存の Project / Intent / Outcome の API・MCP・UI の test が変更なしで通る（Task 15 で変える MCP の Outcome 書込を除く）。

### Task 15: MCP の Principal 認証と Strategist 認可 Context

1. Given `strat-1` に Project `P` の Grant / When Bearer `strat-1` で `get_strategist_context({projectId:"P"})` / Then `principalId`、`role`、`project`（Constraints・Principles を含む）、`activeIntent`、`outcomes`、`unavailable` が返る。Active Intent が無い Project では `activeIntent:null`、`outcomes:[]`。
2. Given 同上 / When `create_outcome`（成功条件 2 件、rationale あり）/ Then Outcome が `active` で保存され、Web `GET .../outcomes/:id` で同じ内容と固定成功条件が見える。
3. Given Bearer なし / When `get_strategist_context` / `create_outcome` / `update_outcome` / `cancel_outcome` / Then `UNAUTHENTICATED`（`isError:true`）で、Outcome は作られない。
4. Given Grant なし、または `Q` にだけ Grant がある Principal / When `P` を対象に同じ tool / Then `FORBIDDEN`。存在しない Project ID でも同じ `FORBIDDEN`（存在有無を漏らさない）。
5. Given Grant を取消した直後 / When 同じ Bearer で `create_outcome` / Then `FORBIDDEN`（サーバー再起動不要）。
6. Given Authorization が `Basic x`、`Bearer `（値なし）/ When `/mcp` へ / Then HTTP `401`。
7. Given request 本文や tool 入力に `role:"strategist"` / `principalId:"strat-1"` を含めるが Grant がない / When 呼び出し / Then `FORBIDDEN`（それらは認証情報として使われない）。
8. Given `strat-1` が `P` の Strategist / When `update_intent` / `create_intent` / `abandon_intent` / `update_project` を `P` に対して呼ぶ / Then `FORBIDDEN`。Bearer なしの同 tool は従来どおり成功する。
9. `tools/list` に `get_strategist_context` と `get_role_instructions` を含み、Grant 管理 tool を含まない。`initialize` / `tools/list` は Bearer なしで成功する。
10. 認可検査は `application/service/ProjectAuthorizationService`（`requireRole` / `requireNotRole`）に置き、MCP handler は Principal を渡すだけ。Web API の Outcome 操作は Principal なしで従来どおり動く。

### Task 16: Instruction 配信

1. When `get_role_instructions({role:"strategist", includeShared:true})` / Then `files` が `[{path:"agent/role-policy.md",kind:"shared",content},{path:"agent/strategist.md",kind:"role",content}]`（Bearer なしでも成功）。`includeShared` 省略・`false` では Role 文書のみ。
2. `role:"worker"` など enum 外は入力検証エラー。
3. Given `agent/strategist.md` を一時的に読めない場所へ差し替えた `InstructionService` / When 取得 / Then `INSTRUCTION_UNAVAILABLE`（path 入り、`isError:true`）。
4. Instruction に「Goal / Input / 判断権限 / Output / Allowed / Forbidden / Research / Success Criterion 固定 / 自己評価禁止 / Human 確認なし」が含まれ、記載した tool 名がすべて `tools/list` に存在する（test で照合）。

### Task 17: 自動統合検証

1. Given 空 DB / When test が API で Project・Active Intent を作り、CLI で Grant を発行し、MCP（Bearer）で Instruction → Context → `create_outcome` を実行 / Then Human 操作なしに完了し、Web `GET` で Outcome・rationale・固定成功条件が参照できる。
2. Given Grant を取消 / When 同じ Agent が `create_outcome` / Then `FORBIDDEN`。別 Project の Agent も `FORBIDDEN`。
3. Given サーバーを再起動（同じ DB） / Then Grant が保持され、同じ port で `/`、`/api`、`/mcp` が使える。
4. README・`.env.example`・本書・API / MCP / CLI 文書の記述が実装と一致し、`npm test` / `typecheck` / `lint` / `build` / `git diff --check` の結果が記録される。実ブラウザ確認は任意の追加確認で、完了条件にしない。
