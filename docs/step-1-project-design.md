# Projectの現行仕様

Projectは目的・原則・制約・参照先を共有する最上位コンテキスト。現在の型は [Project.ts](../src/domain/model/Project.ts)、入力規則は [projectSchema.ts](../src/shared/projectSchema.ts) を参照する。統合後の所有先はDirection。

## 項目

| 項目 | 規則 |
| --- | --- |
| name | 必須、trim後1〜100文字 |
| mission | 必須、1〜2,000文字 |
| description | 任意、最大1,000文字 |
| vision | 任意、最大2,000文字 |
| principles / constraints | 各最大20件、各500文字 |
| repositories | 最大20件、各id・name・http(s) URL |
| resources | 最大50件、各id・name・http(s) URL・任意のkind |
| status | `active` / `archived` |
| archivedAt / archiveReason | archive日時・理由。active時はnull |
| id / createdAt / updatedAt | serverが管理 |

Mission / Vision / Principles / ConstraintsはProject aggregateに保持する。RepositoryとResourceは複数件を持ち、ProjectをRepositoryと1:1に固定しない。未入力のdescription / visionはnull。

## 作成と更新

HumanはWeb UIを使う。Web APIは`POST /api/projects`、`GET /api/projects`、`GET /api/projects/:projectId`、`PATCH /api/projects/:projectId`。作成にはログイン、参照にはMembership、更新にはadministrator以上が必要。

更新は部分更新で、未指定項目を維持する。任意テキストはnull / 空文字でクリアできる。配列は全体置換で、空配列は全件削除。Repository / Resourceの既存IDを指定するとIDを維持し、未知・別ProjectのIDは新しいIDとして保存する。重複IDと更新項目なしは拒否する。

親と子要素を同じtransactionで保存し、失敗時は一部だけ更新しない。楽観ロックは提供していない。archive後は [archive規則](step-5-project-archive-design.md) を適用する。

## 保存と画面

SQLiteの`project`、`project_principle`、`project_constraint`、`project_repository_link`、`project_resource`に保存する。子要素は入力順を保持する。

画面は一覧`/`、作成`/projects/new`、詳細`/projects/:projectId`、編集`/projects/:projectId/edit`。詳細にはIntent・Outcome・Research・Decision・Execution・Member・Agent管理を表示する。未設定・空一覧・読み込み失敗を区別する。

remote modeのMCPにはProject作成・更新を公開せず、参照はAgent CredentialとProject Grantで認可する。
