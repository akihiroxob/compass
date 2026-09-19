# Step 1: Project 設計

## 目的と範囲

Step 1 では、Compass の Direction context に Project を作成し、SQLite に保存して、Web と MCP の双方から一覧・詳細を参照できる状態までを実装する。

Project は単なる実行 Task の入れ物ではなく、人が「この現場は何で、何を目指し、どの原則と制約のもとで進めるか」を把握するための最上位コンテキストとする。この段階では Intent、Outcome、Wacha の Story / Task、Runtime、評価・改善ループを Project に取り込まない。

## 採用する構成

既存 Wacha の構成を基準に、単一の Node.js アプリケーションとして始める。

```text
src/
├── domain/                 Project と値オブジェクト、Repository interface
├── application/            作成・一覧・詳細の use case
├── infrastructure/         SQLite / Kysely の実装
├── presentation/
│   └── mcp/                Streamable HTTP MCP adapter
├── shared/                 Web API と MCP が共有する入力 schema
├── frontend/               React / Vite SPA
├── app.ts                  Web API route、/mcp、静的 Web UI の結合
└── server.ts               同一ポートの起動口
```

`npm start` の `prestart` で Web UI を build し、その後 Hono server を起動する。Hono は同じポートで `/api`、`/mcp`、build 済み SPA を提供する。Web API と MCP adapter は Repository を直接操作せず、同じ application use case を呼ぶ。

Direction / Execution / Runtime / Improvement は責務として分離するが、この段階で別サービスや別パッケージには分割しない。境界を必要とする機能が増えた時点で package 分割を検討する。

## Project の初期モデル

追加資料が Project の最低限の構成として挙げる全項目を Step 1 の保存・表示対象にする。Mission / Vision / Principles / Constraints は初期実装では Project aggregate 内に保持する。Repository と Resource は複数件で個別の識別子を持つ子要素とする。

```ts
type Project = {
  id: string;
  name: string;
  description: string | null;
  mission: string;
  vision: string | null;
  principles: string[];
  constraints: string[];
  repositories: ProjectRepository[];
  resources: ProjectResource[];
  createdAt: number;
  updatedAt: number;
};

type ProjectRepositoryLink = {
  id: string;
  name: string;
  url: string;
};

type ProjectResource = {
  id: string;
  name: string;
  url: string;
  kind: string | null;
};
```

`repositories` の子 Entity は、domain の永続化 interface と紛らわしいため `ProjectRepositoryLink` と命名する。`ProjectRepository` は aggregate の永続化 interface に使う。

### 入力規則

以下の必須/任意、文字数・件数の上限、Step 1 の公開操作範囲は、追加資料に定めがないため設計上の提案であり、ユーザーの Step 1 確認で合意を取るまで確定事項として扱わない。

| 項目 | 初回作成 | 規則 |
| --- | --- | --- |
| name | 必須 | 前後空白を除去し、1〜100文字 |
| description | 任意 | 前後空白を除去。空文字は `null`。最大1,000文字 |
| mission | 必須 | 前後空白を除去し、1〜2,000文字 |
| vision | 任意 | 前後空白を除去。空文字は `null`。最大2,000文字 |
| principles | 任意 | 各項目を trim し、空項目を拒否。各500文字、最大20件 |
| constraints | 任意 | 各項目を trim し、空項目を拒否。各500文字、最大20件 |
| repositories | 任意 | name（1〜100文字）と絶対 URL を必須とし、最大20件 |
| resources | 任意 | name（1〜100文字）と絶対 URL を必須、kind は任意（空文字は `null`、最大100文字）。最大50件 |

`id`、`createdAt`、`updatedAt` は server が生成する。URL は `http:` または `https:` に限定する。入力違反は入口によらず application boundary の共通 schema で拒否する。

初回画面は全項目を作成フォームで入力できるようにする。Step 1 の公開操作は作成・一覧・詳細に限定し、編集・削除は後続の合意対象とする。Project status は追加資料の画面案に現れる一方、状態と遷移が定義されていないため Step 1 では持たせない。

## 永続化

SQLite と Kysely を用いる。起動時の idempotent な schema 初期化により、空 DB から以下を作成する。

```text
project
project_principle
project_constraint
project_repository_link
project_resource
```

子要素は `project_id` の外部キーと `sort_order` を持ち、入力順を維持する。Project 作成は親と全子要素を一つの transaction で保存する。一覧・詳細は同じ aggregate 形状を返す。DB ファイルの既定値は `compass.db`、`COMPASS_DB_PATH` で変更できるようにする。

明示的な migration framework は Step 1 では導入せず、Wacha と同様の初期化関数で schema を管理する。ただし table 作成処理を application 起動から分離し、将来の migration へ置き換え可能にする。

## 公開操作

### Web API

| Method | Path | 結果 |
| --- | --- | --- |
| `POST` | `/api/projects` | Project を作成し `201` と作成結果を返す |
| `GET` | `/api/projects` | Project の一覧を更新日時降順で返す |
| `GET` | `/api/projects/:projectId` | Project 詳細、存在しなければ `404` |
| `GET` | `/health` | server の生存確認 |

入力違反（不正JSON・空bodyを含む）は `400` と機械判定可能な error code、予期しない失敗は `500` を返す。

### MCP

Streamable HTTP endpoint を `/mcp` に置き、次を公開する。

- `create_project`
- `list_projects`
- `get_project`

Step 1 の Compass MCP はローカル利用を前提にし、Project 作成の Role Grant や Claim は導入しない。Wacha の実行権限モデルを Direction の Project 作成へ転用しない。Web API で作成した Project を MCP で参照でき、その逆も成立する。

## Web UI

- 一覧: 件数、name、description、mission、最終更新日時を表示する。0件、読込中、読込失敗を区別する。
- 作成: 全入力に label を付ける。Principle、Constraint、Repository、Resource は追加・削除可能な反復入力にする。送信中と項目別エラーを表示する。
- 詳細: Project Identity、Mission、Vision、Principles、Constraints、Repositories、Resources を表示する。未入力の任意 section は「未設定」と明示する。
- ルーティング: `/` を一覧、`/projects/new` を作成、`/projects/:projectId` を詳細とする。
- キーボードだけで作成でき、狭い画面では1カラムに折り返す。

Intent、Outcome、Execution Summary、Activity は未実装のため、空データや仮データを表示しない。

## 受け入れ例

1. 空の DB で `npm start` を実行すると、一つの port から `/health`、Web UI、`/api/projects`、`/mcp` が応答する。
2. Web フォームに name、mission と任意項目を入力すると Project が作成され、一覧と詳細に同じ内容・並び順で表示される。
3. server を停止して同じ `COMPASS_DB_PATH` で再起動しても、作成した Project の ID と内容が保持される。
4. Web API で作成した Project を `list_projects` / `get_project` で取得でき、MCP で作成した Project を Web で確認できる。
5. 空白だけの name / mission、不正 URL、上限超過を Web API と MCP の双方が同じ規則で拒否する。
6. 存在しない ID は Web API で `404`、MCP で not-found error として識別できる。

## 検証方針

- domain / validation: 必須、trim、nullable 化、件数・長さ・URL 上限
- repository integration: aggregate 全体の保存、順序、transaction、再生成した repository instance からの再読込
- application: 作成・一覧順・詳細・not found
- API: 正常系、validation error、not found
- MCP: initialize、tools/list、3 tool の呼出し、API との相互参照
- frontend build と TypeScript type check
- production 起動後の HTTP smoke test と、server 再起動を含む永続化確認

## この段階で確定しない事項

- Project の編集・削除・archive 状態と遷移
- Mission / Vision / Principles / Constraints を独立 aggregate にする時期
- Repository / Resource の認証情報、疎通確認、provider 固有 metadata
- Intent の状態、同時 active 数、更新規則
- Outcome、SuccessCriterion、Wacha 連携、Runtime、評価・改善ループ
- 最終的な workspace / package 分割

これらは未実装であり、Step 1 の動作から暗黙に確定したものとして扱わない。
