# Projectの現行仕様

ProjectはOrganization（`packages/organization`）が所有する実行境界で、1つのWorkspaceに所属する（[ADR 0001](adr/0001-workspace-project-boundary.md)）。型は [Project.ts](../packages/organization/src/domain/Project.ts)、入力規則は [projectSchema.ts](../packages/organization/src/application/projectSchema.ts) を参照する。Mission / Vision / Principles / Constraintsの正本は所属Workspaceで、Projectの入出力（`ProjectDetail`）は互換のため所属Workspaceの値を合成して同じ項目で読み書きする。Projectの参照（Web API・MCP・Role Context）は所属`workspaceId`を返す。Workspaceの公開入口はHuman向けの参照Web API（一覧・詳細・所属Project一覧）まで接続済みで、Workspace管理操作・Workspace MCP・Web UIは未接続。

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
| workspaceId | 所属Workspace ID。serverが管理し、Projectの応答に含める |
| archivedAt / archiveReason | archive日時・理由。active時はnull |
| id / createdAt / updatedAt | serverが管理 |

Mission / Vision / Principles / Constraintsは所属Workspaceに保持し、Project（Entity）はname・description（目的）・status・Repository / Resourceを持つ。RepositoryはProjectのResourceの一つで、複数件を持ち、ProjectをRepositoryと1:1に固定しない。未入力のdescription / visionはnull。

## 作成と更新

HumanはWeb UIを使う。Web APIは`POST /api/projects`、`GET /api/projects`、`GET /api/projects/:projectId`、`PATCH /api/projects/:projectId`。作成にはログイン、参照にはMembership、更新にはadministrator以上が必要。Web UIからのProject作成は既存Workspaceへの追加（`POST /api/workspaces/:workspaceId/projects`。Workspaceのadministrator以上）を使う。Projectの更新はname・purpose・Repository・Resourceだけで、Mission等は所属Workspaceの更新で変更する。Projectの応答は所属Workspaceの`workspaceId`を含む。所属Workspaceの参照は`GET /api/workspaces/:workspaceId`（Workspace Membership）で行う。

更新は部分更新で、未指定項目を維持する。任意テキストはnull / 空文字でクリアできる。配列は全体置換で、空配列は全件削除。Repository / Resourceの既存IDを指定するとIDを維持し、未知・別ProjectのIDは新しいIDとして保存する。重複IDと更新項目なしは拒否する。

作成は戦略値を持つ専用のWorkspaceを同じtransactionで作る。更新はMission等を所属Workspaceへ、それ以外をProjectへ書き、archivedのWorkspaceへのMission等の更新は409で拒否する。親と子要素を同じtransactionで保存し、失敗時は一部だけ更新しない。楽観ロックは提供していない。archive後は [archive規則](step-5-project-archive-design.md) を適用する。

## 保存と画面

SQLiteの`project`・`project_repository_link`・`project_resource`と、所属Workspaceの`workspace`・`workspace_principle`・`workspace_constraint`に保存する。子要素は入力順を保持する。`project`の旧列（`mission`・`vision`）と`project_principle`・`project_constraint`は読み書きしない（旧列を正本としていたProjectはserver起動時の移行で一度だけWorkspaceへ写す）。

画面は参加中のProject`/projects`、作成`/workspaces/:workspaceId/projects/new`、詳細`/projects/:projectId`、編集`/projects/:projectId/edit`。詳細にはIntent・Outcome・Research・Decision・Execution・Member・Agent管理を表示する。未設定・空一覧・読み込み失敗を区別する。

remote modeのMCPにはProject作成・更新を公開せず、参照はAgent CredentialとProject Grantで認可する。
