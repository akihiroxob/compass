# Agent認可・Instruction配信の現行仕様

## 認証とRole Grant

remote modeではAgent CredentialでPrincipalを認証する。Role GrantはProject・Principal・Roleの組で保持し、発行してもAgentは起動しない。現在のRole名は`strategist` / `researcher` / `manager` / `worker` / `reviewer` / `evaluator`と、trusted-local用の`runtime`。

HumanはProject詳細のWeb UIからGrantを管理する。一覧はviewer以上、発行・取消はadministrator以上。Human MembershipとAgent Grantを相互代用しない。archived ProjectではGrant変更を拒否する。

MCPの専用toolはapplication層で必要なRoleを検査する。remote modeの参照系も対象ProjectのGrantを検査する。CredentialとRuntime scopeの詳細は [認証仕様](step-6-human-auth-design.md) を参照する。

## ContextとInstruction

`get_strategist_context`はProject・Intent・Outcome・判断材料を返す。`get_role_instructions({ role, includeShared })`は現在の`agent/<role>.md`を読み、`includeShared`指定時は`agent/role-policy.md`も返す。静的Instructionは認可の強制手段ではない。

`agent/`は実行時に配信される構成資産なので、変更はWachaの実装Taskで行う。今回の文書整理では変更しない。

## 確定した移行先

Role名は`manager`から`work-manager`へ移行し、Role Definitionは`roles/`、共通Policyは`policies/`へ配置する。RoleはSkillを参照し、Skillに`allowRoles`を持たせない。machine-readableなTool metadataはnamespace付きにする。

1回の実行・操作Contextは1つのactiveRoleに固定し、ServerがProject Grantを検査する。Role / Skill ContextはMCPからJIT取得する。これは [統合設計](../compass-codex-architecture-handoff.md) 上の確定事項であり、現行APIへの実装は未実施。
