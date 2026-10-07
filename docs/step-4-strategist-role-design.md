# Agent認可・Instruction配信の現行仕様

## 認証とRole Grant

remote modeではAgent CredentialでPrincipalを認証する。公開入口のRole GrantはProject・Principal・Roleの組で保持し、発行してもAgentは起動しない。内部applicationのWorkspace Grantは下記で説明する。新規Project Grantは`manager` / `worker` / `reviewer`と`runtime`だけを受け付ける。`strategist` / `researcher` / `evaluator`はWorkspace Roleのため、新規Project Grantには指定できない（400 `VALIDATION_ERROR`）。`runtime`はtrusted-localでOrchestratorが名前Bearerを使うための開発用Grantで、Role-scope認可の対象外（remote modeはRuntime Credentialのscope）。scopeの扱いはS08-03で決める。旧Roleの保存済みGrantは一覧・取消の対象として残す。

HumanはProject詳細のWeb UIからGrantを管理する。一覧はviewer以上、発行・取消はadministrator以上。Human MembershipとAgent Grantを相互代用しない。archived ProjectではGrant変更を拒否する。

MCPの専用toolはapplication層で必要なRoleを検査する。remote modeの参照系も対象ProjectのGrantを検査する。CredentialとRuntime scopeの詳細は [認証仕様](step-6-human-auth-design.md) を参照する。

## Workspace Grantと明示scope認可

Workspace Agent Role Grantは`workspace_grant`へ保存し、`GrantWorkspaceRoleUseCase`・`RevokeWorkspaceRoleUseCase`・`ListWorkspaceGrantsUseCase`をserverへ配線済み。許可Roleは`strategist` / `researcher` / `evaluator`で、Workspace FK・Role CHECK・Workspace/Principal/Roleの複合主キーを持つ。付与・取消は書込と同じtransactionでarchiveを検査し、付与はcreatedAtを保った冪等操作、取消は存在しなければfalse。archivedのGrantは一覧で参照できる。Human Membership・Project Grantからの継承は無い。

`RoleScopeAuthorizationService`は`{ kind: workspace | project, id }`と必要Roleを受け、WorkspaceはDirectionの3Role、Projectは`manager` / `worker` / `reviewer`だけを認可する。操作ContextのactiveRole指定時は必要Roleとの一致も検査し、他RoleのGrantを合算しない。serverの`forActiveRole`もこのserviceを同じRoleに固定する。`runtime`はこのAgent Role-scope認可の対象外で、Credential scopeとして後続Taskで接続する。

Workspace Grantの管理・Directionの公開API/MCP・Workspace Role Contextは未接続（S03-04・S07）。Workspace Credentialは発行・認証・Principal束縛まで実装済みで、Workspace Agent CredentialのPrincipalはこのserviceのWorkspace scopeで認可する（[Credential](step-6-human-auth-design.md#agentruntime-credential)）。既存のProject Direction入口は専用Workspaceだけに限定したadapterとProject Grantを引き続き使い、新規Project Grant入力はExecutionの3Roleと`runtime`に限る。Project Direction adapterは保存済みの旧Grantだけで動作し、公開入口切替時に除去する（S03-04）。新規DBのAgent Direction運転は公開入口が接続されるまで未対応。HumanのDirection操作はMembershipを使う。新しいscope認可では同じProjectにDirection Roleの旧GrantがあってもProject scopeで拒否する。Workの`TaskCoordinationService`も参照・更新の共通認可をExecution Roleに限定する。Direction/Runtimeの旧GrantだけでTask・Story・Comment・Change Logを参照できず、Direction activeRoleでは同じPrincipalのExecution Grantも使えない。Runtime Credentialによる明示scopeのChange Log参照は別の認可経路である。`server/tests/workspaceGrant.test.ts`で新規DB・file DB再初期化・archive・FK・全Roleのscope/activeRole境界・Work権限の非継承を確認する。実HTTP・実AgentでのWorkspace運転は未接続・未検証。

## ContextとInstruction

`get_strategist_context`は内部のWorkspace Contextから`workspace`・Intent/Outcome・判断材料を返し、移行中はProject参照も付ける。Research要約はrequests/syntheses/conflicts各50件までで、`researchHistory`が総件数と省略の有無を示す。Project Grantを使う現行Contextは所属Projectが1件のWorkspaceだけ対象とし、共有Workspaceでは`CONFLICT`（`reason: workspace_direction_required`）を返す。Workspace Grantを使うDirection Contextは未接続。`get_role_instructions({ role, includeShared })`は現在の`roles/<role>.md`を読み、`includeShared`指定時は`policies/role-policy.md`も返す。静的Instructionは認可の強制手段ではない。

`roles/`・`policies/`・`skills/`・`knowledge/`は実行時に配信される構成資産なので、変更はWachaの実装Taskで行う。

## 確定した移行先

`manager`を含む既存Role名を維持し、Role Definitionは`roles/`、共通Policyは`policies/`へ配置する。RoleはSkillを参照し、Skillに`allowRoles`を持たせない。machine-readableなTool metadataはnamespace付きにする。

1回の実行・操作Contextは1つのactiveRoleに固定し、Serverがscopeに対応するGrantを検査する。Role / Skill ContextはMCPからJIT取得する。Project入口のactiveRoleとRole / Skill Contextは実装済み。Workspace公開入口への接続は上記の後続Taskで行う。
