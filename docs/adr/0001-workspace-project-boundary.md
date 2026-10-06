# ADR 0001: WorkspaceとProjectの境界

- 状態: 承認
- 対象: Direction / Work / Access / Activity / Orchestrator / Ralph / Server

## 背景

現行実装のProjectは、Mission・Vision・Principles・Constraints等の戦略、Intent / Outcome以下のDirection、Story / Task以下の実行、Repository等のResourceを1つの単位で兼ねている。複数Projectで1つの成果を目指せず、ProjectとRepositoryの区別も曖昧になる。

Workspaceを導入し、戦略単位と実行単位を分ける。Story・Task・Grant・Credential・Change Log・Activityは既存のProject IDに強く依存しているため、既存Projectを壊さない移行を前提とする。

## 決定

### 概念と所有

| 概念 | 意味 | 所有するもの |
| --- | --- | --- |
| Workspace | Mission / Visionを共有し、複数Projectで成果を実現する戦略単位 | Mission / Vision / Principles / Constraints、Direction |
| Project | 独立した実行・システムの境界。1つのWorkspaceに必ず属する | purpose（description）・status・Resource（Repositoryを含む）・実行状態、Work |
| Outcome | Workspaceで実現したい観測可能な状態。複数Projectにまたがれる | Target Project |
| Story | 特定のProjectがOutcomeへ貢献するために引き受ける仕事 | Task |

1 Workspace : 1 Projectから始めてよい。Projectは必要になった時だけ分割する。WorkspaceはProjectを入れるUIフォルダではない。

WorkspaceはGitHub Organizationと同一視しない。GitHub Organizationはソースコードを置く境界で、Repositoryと同じくProjectのResource・連携先として扱う。ProjectもRepositoryと同一視しない。1つのProjectは複数のRepository・Docs・Figma・URL等をResourceとして持てる。

### Bounded Context

| 境界 | 所有する概念 |
| --- | --- |
| Organization（`packages/organization`） | Workspace、Project、ProjectResource |
| Direction | Intent、Outcome、成功条件、OutcomeTargetProject、Research Request / Result / Finding / Synthesis、Direction Decision、Outcome Evaluation、Outcome Execution Summary / Evidence、Runtime Event、ADR参照 |
| Work | Story、Task、Claim、Comment、Review、Acceptance、Change Log |
| Access | Principal、Workspace / ProjectのMembership、Role Grant、Credential、scope付きの認可判断 |
| Activity | system / workspace / projectの意味ある履歴 |

DirectionのscopeはWorkspace、WorkのscopeはProjectとする。Project固有の参照が必要なDirectionのレコードは、Workspaceとは別に`projectId`を明示的に持つ。Direction → Workの直接依存は作らない。WorkはOutcome Entityを複製せず、`outcomeRef`で参照する。

Workspaceに固有のSkill・Knowledge・Policy・Role Definitionは持たせない。

### OutcomeとTarget Project

OutcomeとProjectの関連を`OutcomeTargetProject`（`outcomeId`・`projectId`・`createdAt`）としてDirectionが所有する。必要になるまでstatus・priority等を持たせない。

- Target ProjectはOutcomeと同じWorkspaceのProjectに限り、重複を許さない。archive済みProjectは新たにTargetにしない。
- Target Projectが0件のOutcomeを許容する。
- どのProjectをTargetにするかは知的判断としてStrategistが決める。Orchestratorは判断しない。
- Outcome向けのStoryを作るときは、Outcomeが存在し、Projectが存在し、ProjectとOutcomeのWorkspaceが一致し、ProjectがそのOutcomeのTargetであることを強制する。
- 1つのOutcomeから、Target Projectごとに別のStoryを作れる。Storyは`projectId`と`outcomeRef`を持ち続ける。
- Outcomeの評価には、全Target ProjectのExecution Summary / Evidenceを使う。1 ProjectのTask受入やWork完了をOutcome達成とみなさない。

### Roleと認可のscope

| scope | Role | 主な責務 |
| --- | --- | --- |
| Workspace | `strategist` / `researcher` / `evaluator` | Direction、Target Projectの判断、調査、Outcome評価 |
| Project | `manager` / `worker` / `reviewer` | Story / Taskへの分解・実行・レビュー・受入 |

- Serverは`principalId`・scope（Workspace / Project）・`activeRole`の組合せでGrantを検証する。上表と異なるRoleとscopeの組合せは拒否する。
- 1回の実行・操作Contextで`activeRole`は1つに固定し、複数Roleの権限を合算しない。
- Grantは`WorkspaceRoleGrant`と`ProjectRoleGrant`に分ける。WorkspaceのGrantやMembershipからProjectの権限を継承しない。
- `manager`はProject内の開発チームのRoleとして維持し、Workspace全体のplannerにしない。
- HumanのWorkspaceMembershipはWorkspaceの閲覧、Mission / Vision / Directionの管理、Project作成、Workspace member管理に使う。ProjectMembershipは維持し、Workspace memberが全Projectを自動で操作できるようにはしない。
- Credentialのscopeは`workspace | project`とscope IDで明示する。保存方式に関わらず、scopeの不変条件を強制する。`runtime`はCredentialのscopeとして別に扱う。
- 自己レビュー・自己受入の禁止、Claimの所有者・期限、Taskの状態遷移はWorkで強制する。

### Activityのscope

Activityのscopeは`system` / `workspace` / `project`とする。

| scope | `workspaceId` | `projectId` |
| --- | --- | --- |
| system | なし | なし |
| workspace | 必須 | なし |
| project | 必須 | 必須 |

上表と異なる組合せは拒否する。Directionのcanonical ActivityはWorkspace Activity、Workのcanonical ActivityはProject Activityとして記録する。append-only、訂正Activityの追記、cursor、`principalId`・`role`、必須の`summary`、`runId`を持たない方針は変えない。Operational Log・Change LogとActivityを混同しない。

### Orchestrator・Ralph・Role Context

- OrchestratorはWorkspace単位の現在状態（ID・status・件数が中心で本文を含まない）を読み、状態だけで専門Roleを起動する。Target Projectのない有効なOutcomeは`strategist`、Target ProjectにOutcomeのStoryがなければそのProjectの`manager`、全Target ProjectのExecutionが評価可能なら`evaluator`を起動する。archive済みのWorkspace・Projectへはdispatchしない。
- Orchestratorは、OutcomeをどのProjectが担当するか、何を調査するか、Storyをどう分けるかを判断しない。Activity cursorをworkflow checkpointにしない。Orchestrator CredentialをAgentへ渡さない。
- RalphはProject内のWorker / Reviewerの実行ループのまま残す。Workspaceを直接所有・選択せず、必要なWorkspaceの情報はServerのProject Role Contextから受け取る。Worker / Reviewerは別Principal・別Credentialとする。
- Role Contextは、Workspace Role向け（Mission等・Project要約・最近のWorkspace Activity）とProject Role向け（Project・Resource・Workspace要約・関連Outcome・最近のProject Activity）を区別する。曖昧なoptional parameterの組合せにしない。Role・Policy・Skill本文を必要時に取得する方式は維持する。

### 成果物の正本

Workspaceが所有するResearch・Decision・Evaluation等、Compassが正本のレコードはDBに保持できる。ADR等のProject固有の成果物は対象ProjectのRepository / Docsを正本とし、CompassはResource・path・revision等の参照を保持する。

### standalone Wacha

standalone WachaはCompassの製品・ランタイムの構成要素ではない。Wachaの開発チーム調整のモデルは`packages/work`・`manager`・Ralphへ統合済みである。repository rootの`.mcp.json`にあるWacha MCPは、Compass自身の開発作業を管理するための開発ツールであり、製品の依存関係ではない。Workspace導入を理由にWachaを再サービス化しない。

## 移行の不変条件

- 既存のProject IDをProjectとして維持する。既存Projectごとに新しいWorkspaceを作り、Projectを所属させる。
- Mission / Vision / Principles / ConstraintsはWorkspaceへ移す。descriptionはProjectのpurpose、Repository / ResourceはProjectに残す。
- Intent / Outcome / Research / Decision / Evaluation等のscopeをWorkspaceへ移す。Story / Task / Change Log、ProjectのMembership / Grant / CredentialはProjectのまま残す。
- 既存のProject ActivityはProject Activityとして残し、`workspaceId`を補う。過去のActivityの再分類は必須にしない。
- 移行は再実行しても重複したWorkspaceを作らない。
- 一度に破壊的な移行をしない。Project tableは「Workspace追加と`workspace_id`の追加（既存列を維持）」→「読取をWorkspaceへ」→「書込をWorkspaceへ」→「未使用列の削除」の順に移す。file移動・schema変更・挙動変更を同じ段階にまとめない。
- Domain modelは早い段階で`workspaceId`へ変え、最終的なDB列も`workspace_id`にする。`project_id`列にWorkspace IDを保存する互換を長く残さない。Project IDをWorkspace IDと解釈する曖昧な互換経路を作らない。

## 対象外

- Workspace固有のSkill・Knowledge・Policy・Role Definition
- 課金・Tenant subscription・Organization SSO
- WorkspaceからProject Roleへの権限継承
- 現行コードに存在しないGoal Entity

Workspace導入をSaaS機能の導入にしない。

## 結果

- 戦略とDirectionはWorkspaceに集まり、Projectは実行の境界に絞られる。1つのOutcomeを複数Projectで分担できる。
- Access・Credential・Activity・Orchestrator・Role Context・UIに、WorkspaceとProjectのscopeの区別が加わる。
- 本ADRは設計の決定であり、実装はまだProject単位である。移行の手順とTaskは[移行計画](../architecture-migration-plan.md)、現在の実装は[実装状況](../implementation-status.md)を参照する。
