# Project archiveの現行仕様

## 状態と操作

Projectは作成時active。ownerがWeb UIから理由を指定するとarchivedへ遷移する。Web APIは`POST /api/projects/:projectId/archive`。理由はtrim後1〜2,000文字。復帰・物理削除・MCP・CLIによるarchiveは提供しない。

`status`、`archivedAt`、`archiveReason`を保存し、`updatedAt`をarchive日時に更新する。所属Workspaceの状態は変えない（最後のactive Projectでも同じ）。WorkspaceのarchiveはWorkspace ownerによる別の操作（`POST /api/workspaces/:workspaceId/archive`）で、Project RoleだけではWorkspaceを停止できない。再archiveは409で拒否し、理由や日時を上書きしない。

## 参照専用

子データの状態・履歴・Grantを消さずに保持する。HumanはMembership、AgentはGrantに基づいて引き続き参照できる。MCPの`list_projects`はactiveのみを返す。

Executionへの変更、Grant変更、招待、Membership変更は拒否する。Direction（Intent・Outcome等）は所属Workspaceが所有し、変更可否はWorkspaceの状態で決まる。Projectがarchivedでも、activeなWorkspaceではWorkspace Membershipに従い変更でき、Workspace ownerがWorkspaceをarchiveした場合は拒否する（409、`workspaceStatus: archived`）。書込transaction内でもarchive状態を確認し、検査後の競合による更新を防ぐ。例外として、platform ownerによるowner不在ProjectのMembership補完がある。

archiveは外部Agent processの停止完了を意味しない。実行システムによる停止制御は別責務。

## UIと認可

Project一覧はactive / archivedを切り替えられる。archivedの詳細は理由・日時を表示し、Projectの変更導線を出さない。Directionの変更導線は、archive後に所属Workspaceの状態を再取得して決める。未認証は401、未所属は404、Role不足は403、認可済みのarchive済みProjectへの変更は409。

関連仕様: [Human認証](step-6-human-auth-design.md)、[Project](step-1-project-design.md)。
