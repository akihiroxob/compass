# COMPASS Workspace Architecture — Codex Handoff v2

## 0. 目的

既存の `akihiroxob/compass` 実装に対して、Workspace を上位概念として導入し、COMPASS を「開発チームの自動化」から「自律ソフトウェア組織の Control Plane」へ拡張する。

この文書は新規実装の理想図ではない。2026-10-05 時点の `main` の既存コードを前提に、壊す箇所・残す箇所・移行順序を明示する。

最重要原則:

- リリース前のCompass開発DBはDROP・file削除で再作成してよい。旧データ・ID・Credential・cursorの引継ぎと旧クライアント互換は必須にせず、新規DBの構造・保存・認可・業務規則を検証する。
- Workspace を単なる UI フォルダにしない。
- Workspace は GitHub Organization と同一概念にしない。
- Direction は Workspace scope、Work は Project scope とする。
- Outcome は Workspace-level の達成状態であり、複数 Project にまたがる。
- Story は Project に所属し、1つの Outcome に貢献する。
- Orchestrator は状態判定のみを行い、Project 選択を含む知的判断を自前で行わない。
- `packages/work` は Project 内の開発チーム coordination domain として維持する。
- Ralph は Worker / Reviewer の execution loop のまま残す。
- standalone Wacha は COMPASS product/runtime の構成要素ではない。

---

# 1. 現行コードから確認できた事実

現行 COMPASS はすでにかなり実装されている。

```text
server/
orchestrator/
ralph/

roles/
skills/
knowledge/
policies/

packages/
├─ direction/
├─ work/
├─ activity/
├─ access/
└─ shared/
```

既存の重要な設計は維持する。

## 1.1 Direction

現在 `packages/direction` が以下を所有している。

```text
Project
Intent
Outcome
Success Criteria
Research
Direction Decision
Outcome Evaluation
Outcome Execution Summary / Evidence
Runtime Event
ADR handoff
```

現行 `Project` は `name / description / mission / vision / principles / constraints / repositories / resources` を持つ。

つまり現行 Project は「戦略単位 + Direction scope + Execution scope + Resource scope」を兼務している。Workspace 導入後はこの責務を分離する。

## 1.2 Intent / Outcome

現在 `Intent.projectId` と `Outcome.projectId` があり、Direction は完全に Project scope。Workspace 導入後は Workspace scope へ移す。

## 1.3 Work

現行 Story はすでに次を持つ。

```text
StoryRecord {
  project_id
  outcome_ref
}
```

つまり「Story は Project に所属しながら Direction の Outcome を参照する」という形はすでに存在する。今回の変更では Story の基本モデルを壊さない。

## 1.4 Activity

`packages/activity` は独立 package。Activity は append-only、`runId` を持たず、Operational Log / Change Log / Activity は分離済み。この原則は維持する。

## 1.5 Access

現行 Access は Project scope で `ProjectRoleGrant / ProjectMembership / ProjectInvitation / Agent Credential / Runtime Credential / Human Session` を管理する。Workspace 導入ではここが大きな変更点。

## 1.6 Orchestrator

現在 Orchestrator は Project 単位の `get_orchestration_state` を読み、`strategist / researcher / manager / evaluator` を deterministic に起動する。config も Project 単位。

## 1.7 Ralph

Ralph は Project 内の Worker / Reviewer loop。Workspace 導入による本質的な変更は不要。

## 1.8 Wacha

Wacha は COMPASS product/runtime の下位サービスとして残っているわけではない。

Wacha で形成された開発チーム coordination のモデル・実装知見は、現在の COMPASS では主として `packages/work` と周辺 runtime に移植・統合されている。

代表例:

```text
Story
Task
Claim
Comment
Review
Acceptance
Change Log
```

したがって、現在の製品アーキテクチャにおける対応関係は次の通り。

```text
packages/work
= Project-level development team coordination domain

manager
= Project内でOutcomeをStory / Taskへ分解し、Acceptanceを担うRole

Ralph
= Worker / Reviewer execution loop
```

これらの組み合わせが、Wacha で目指していた「開発チームの再現」に相当する。

---

# 2. 新しい概念モデル

```text
COMPASS
└─ Workspace
   ├─ Mission
   ├─ Vision
   ├─ Principles
   ├─ Constraints
   │
   ├─ Intent
   │  └─ Outcome
   │     ├─ Target Project A
   │     │  └─ Story
   │     ├─ Target Project B
   │     │  └─ Story
   │     └─ Target Project C
   │        └─ Story
   │
   └─ Projects
      ├─ Project A
      ├─ Project B
      └─ Project C
```

意味:

```text
Workspace = Mission / Vision を共有する戦略的活動単位
Direction = Workspace がどこへ向かうか
Outcome = Workspace level で実現したい観測可能な状態
Project = 独立した execution / system boundary
Story = 特定 Project が Outcome に対して引き受ける仕事
Task = Story を実現する具体作業
```

---

# 3. Workspace

Workspace は単なる Project folder ではない。

> 同じ Mission / Vision / Direction を共有し、複数の Project を通じて成果を実現する戦略単位。

初期状態では 1 Workspace : 1 Project でもよい。

```text
Workspace: Petari
└─ Project: Petari
```

複雑化した時だけ Project を分割できる。

---

# 4. Workspace と GitHub Organization

同一視しない。

```text
Workspace = business / product / strategic boundary
GitHub Organization = source code hosting boundary
```

GitHub Org / Repository は Resource / integration として扱う。

---

# 5. Project の新しい責務

Workspace 導入後の Project は実行境界に絞る。

```text
Project
├─ workspaceId
├─ name
├─ description / purpose
├─ status
├─ repositories
├─ resources
└─ execution state
```

Project から以下を外す。

```text
mission
vision
principles
workspace-level constraints
Intent
Outcome
Research
Direction Decision
Evaluation
```

Project は Repository と同義ではない。

```text
Project
└─ Resources
   ├─ Repository A
   ├─ Repository B
   ├─ Documentation
   ├─ Figma
   └─ External URL
```

---

# 6. Direction の scope を Workspace に変更する

現行:

```text
Project
└─ Intent
   └─ Outcome
```

変更後:

```text
Workspace
└─ Intent
   └─ Outcome
```

少なくとも以下を Workspace scope へ変更する。

```text
Intent
Outcome
Research Request / Result / Finding / Synthesis
Direction Decision
Outcome Evaluation
Runtime Event
Outcome Execution Summary
Outcome Execution Evidence
```

Project-specific reference が必要な record では別途 `projectId` を持つ。

---

# 7. Outcome → Project の明示的関連

Workspace 化で最重要の追加概念。

Story 作成前に Orchestrator が「どの Project の manager を起動するか」を deterministic に判断できる必要があるため、Direction に `OutcomeTargetProject` 相当の関連を持たせる。

```ts
type OutcomeTargetProject = {
  outcomeId: string;
  projectId: string;
  createdAt: number;
};
```

必要になるまで status / priority 等は入れない。

```text
Outcome
├─ Target → Project A
├─ Target → Project B
└─ Target → Project C
```

その後:

```text
Outcome + Target Project A
↓
manager(Project A)
↓
Story(projectId=A, outcomeRef=Outcome)
```

---

# 8. Target Project を決める主体

Project 選択は知的判断。Orchestrator に実装しない。

```text
Strategist
↓
Outcome を作成 / 判断
↓
必要な Target Projects を設定
```

Strategist の Role Context に Workspace と Project summary / purpose / resource summary を含める。

---

# 9. Target Project が無い Outcome

許容する。

```text
Active Outcome + Target Project = 0
→ strategist
```

Target 設定後:

```text
Target Project + そのProjectにOutcome Storyが無い
→ manager(targetProject)
```

---

# 10. Work は Project scope を維持

`packages/work` は基本境界を変えない。

```text
Project
└─ Story
   └─ Task
```

Story の `project_id / outcome_ref` を維持し、1 Outcome → 複数 Project の Story を正式に許可する。

---

# 11. DirectionReferenceLookupService

現在の `getOutcomeSnapshot(projectId, outcomeId)` は Outcome と Project が同一 scope の前提。

Workspace 化後は概念的に分ける。

```text
getOutcomeSnapshot(workspaceId, outcomeId)
getProjectExecutionContext(projectId)
```

Story 作成時には `Outcome snapshot + Workspace constraints + Target Project context + selected repository/resource` が必要。

Direction → Work の依存を作らない現行原則は維持する。

---

# 12. Mission / Vision / Principles / Constraints

現行 Project のこれらを Workspace へ移す。

```text
Workspace {
  id
  name
  description?
  mission
  vision?
  principles[]
  constraints[]
  status
  createdAt
  updatedAt
}
```

Goal entity は現行コードに存在しないので、この migration だけを理由に作らない。

---

# 13. Package boundary

推奨:

```text
packages/
├─ organization/
├─ direction/
├─ work/
├─ activity/
├─ access/
└─ shared/
```

`organization` が所有:

```text
Workspace
Project
ProjectResource
ProjectRepositoryLink
```

`direction` が所有:

```text
Intent
Outcome
OutcomeTargetProject
Research
Direction Decision
Evaluation
Execution Evidence / Summary
```

`work` が所有:

```text
Story
Task
Claim
Review
Acceptance
Change Log
```

一度に file move + schema change + behavior change を行わず段階移行する。

---

# 14. Access model

## 14.1 Human

`WorkspaceMembership` を追加する。

用途:

```text
Workspace の閲覧
Mission / Vision / Direction の管理
Project 作成
Workspace member 管理
```

ProjectMembership は当面維持する。

```text
WorkspaceMembership != ProjectMembership
```

Workspace member だから全 Project を自動操作できる、とはしない。

## 14.2 Agent Role

Workspace-scoped Direction roles:

```text
strategist
researcher
evaluator
```

Project-scoped Execution roles:

```text
manager
worker
reviewer
```

`runtime` は Credential scope として別扱いを維持する。

## 14.3 Grant

推奨:

```text
WorkspaceRoleGrant
ProjectRoleGrant
```

Role inheritance は作らない。

---

# 15. Credentials

現行 Credential は `project_id` 必須なので見直す。

Application model として scope を明示する。

```text
scope_kind: workspace | project
scope_id
```

保存実装は unified table でもよいが、scope invariant を必ず強制する。

---

# 16. activeRole

原則維持。

```text
Principal + Scope + activeRole
```

許可:

```text
Workspace + strategist/researcher/evaluator
Project + manager/worker/reviewer
```

不正な role-scope 組み合わせは deny。

---

# 17. Activity

scope を拡張する。

```text
system
workspace
project
```

概念:

```ts
Activity {
  id
  cursor
  scope
  workspaceId?
  projectId?
  type
  principalId
  role
  summary
  body?
  refs
  occurredAt
}
```

Invariant:

```text
system: workspaceId=null, projectId=null
workspace: workspaceId!=null, projectId=null
project: workspaceId!=null, projectId!=null
```

Direction canonical Activity は Workspace Activity。
Work canonical Activity は Project Activity。

---

# 18. Project-specific artifact

方針維持。

```text
Project Repository / Docs = Source of Truth
COMPASS Activity = what happened + reference
```

Workspace-level Research / Decision / Evaluation 等、COMPASS Domain 自身が正本の record は DB に保持してよい。

---

# 19. Orchestrator の新しい境界

現行 Project 単位 state から Workspace 単位 state へ変更する。

推奨:

```text
get_workspace_orchestration_state(workspaceId)
```

応答には以下を含める。

```text
Workspace
Active Intent
Outcomes
Research Requests
Evaluations
Projects summary
Outcome Targets
Projectごとの Work summary
```

本文を返さず ID / status / counts 中心にする現在の思想を維持する。

---

# 20. Orchestrator dispatch rule

```text
open Research
→ researcher(workspace)

pending Evaluation
→ strategist(workspace)

Active Intent with no live Outcome / Research / pending Evaluation
→ strategist(workspace)

Active Outcome with no Target Projects
→ strategist(workspace)

Outcome Target Project with no Story / Tasks
→ manager(project, outcome)

全Target ProjectのExecutionが評価可能
→ evaluator(workspace, outcome)
```

Orchestrator は以下を判断しない。

```text
どのProjectがOutcomeを担当すべきか
何を調査すべきか
Storyをどう切るか
```

---

# 21. Orchestrator config / dispatch key

Direction orchestration は Workspace Runtime Credential で現在状態を読む。

Project execution の dispatch key 例:

```text
<workspaceId>:<projectId>:manager:outcome:<outcomeId>
```

Orchestrator Credential を Agent へ渡さない現行原則は維持する。

---

# 22. Role Context

曖昧な optional parameter だらけの API は避ける。

候補:

```text
get_workspace_role_context({ workspaceId, role })
get_project_role_context({ projectId, role })
```

または scope object を使って統一する。

Workspace Role Context:
- Mission / Vision / Principles / Constraints
- Projects summary
- Role Definition
- Policy
- Skill metadata
- recent Workspace Activity

Project Role Context:
- Project / Resources
- Workspace summary
- relevant Outcome
- Role Definition
- Policy
- Skill metadata
- recent Project Activity

---

# 23. Wacha と `.mcp.json` に関する正本

ここは誤読防止のため、この文書全体に対する解釈ルールとする。

## 23.1 `.mcp.json` の Wacha

Repository root の `.mcp.json` にある Wacha MCP は、**COMPASS 自身を開発する作業を Wacha で管理するための development tooling** である。

```text
Codex / 開発Agent
↓
Wacha MCP
↓
COMPASSリポジトリの開発Story / Taskを管理
```

これは COMPASS product/runtime architecture の依存関係ではない。

したがって次のように解釈してはいけない。

```text
COMPASS runtime
→ standalone Wacha service
```

## 23.2 COMPASS 製品内での Wacha 機能

Wacha の主要な coordination 機能は、現在の COMPASS では `packages/work` を中心にかなり移植・統合済みである。

```text
packages/work
├─ Story
├─ Task
├─ Claim
├─ Comment
├─ Review
├─ Acceptance
└─ Change Log
```

周辺を含めると:

```text
Project
├─ manager
├─ packages/work
└─ Ralph
   ├─ Worker
   └─ Reviewer
```

この全体が「Project 内の開発チーム再現」に相当する。

## 23.3 Workspace migration で Wacha を再導入しない

Workspace 導入を理由に standalone Wacha service を COMPASS runtime へ再導入しない。

歴史的には:

```text
Wacha
↓
開発チーム coordination のモデルと実装知見
↓
COMPASS packages/work / manager / Ralph へ統合
```

と理解する。

---

# 24. Wacha MCP から見える作業履歴

将来 standalone Wacha MCP を外部から接続できれば、COMPASS 自身の開発に使った Wacha の永続化データから以下は取得可能。

```text
Story
Task
Task Comment
Claim
Change Log
Review / Acceptance transitions
```

ただしこれは **COMPASS 製品内の Project Activity ではなく、COMPASS そのものを開発した開発工程の履歴**。

また、Wacha に保存していない以下は復元できない。

```text
Agent内部会話
未投稿の判断
raw terminal output
未記録の推論
```

したがって、Wacha MCP は Workspace migration の前提条件ではない。

---

# 25. Ralph

Ralph は Project execution のまま。

Workspace を直接理解させない。必要な Workspace context は Server の Project Role Context 経由で供給する。

---

# 26. Evaluator / Manager

Evaluator は Outcome 評価担当なので Workspace-scoped に変更。

Manager は Project-scoped の開発チーム Manager として維持する。Workspace-wide planner にしない。

---

# 27. リリース前のDB再作成方針

Compass開発DBはschema変更に合わせてtableをDROPするかDB fileを削除し、現在のCREATE定義から再作成してよい。開いているCompassプロセスを先に停止する。

旧DBの非破壊migration・既存ID保全・旧Credential継続・旧クライアント互換は必須にしない。開発用WachaのStory / Taskは別管理のため、この再作成に含めない。

---

# 28. 新規DBの検証

- Workspaceを作成し、全Projectを必ず1つのWorkspaceに所属させる。
- Mission / Vision / Principles / ConstraintsはWorkspace、purpose・Repository / ResourceはProjectが所有する。
- Intent / Outcome / Research / Decision / EvaluationはWorkspace scope、Story / Task / Change LogはProject scopeとする。
- 新規発行するMembership / Grant / CredentialはWorkspace / Projectのscopeと一致させる。
- Activityは正しいworkspaceId/projectIdの組合せで記録する。
- 保存済みデータは同じschemaでの再起動後も参照できる。旧データのコピー・Target補完・Activity変換は不要とする。

---

# 29. Project table

Projectは`workspace_id`を必須とし、戦略値のread/writeはWorkspaceへ切り替える。unused mission/vision等の旧列・旧table・移行用コードは、参照元を切り替えるTaskで除去してよい。旧データ保存のための段階migrationを要求しない。

---

# 30. Direction DB column

Domain model は早期に `workspaceId` へ変える。
最終 DB も `workspace_id` にする。

`project_id` という列へ Workspace ID を長期間保存する互換ハックは禁止。

---

# 31. Outcome Target table

例:

```text
outcome_target_project
- outcome_id
- project_id
- created_at

UNIQUE(outcome_id, project_id)
```

Project が Outcome の Workspace に属することを Application / Domain で検証する。

---

# 32. Outcome → Story invariant

Outcome handoff Story 作成時:

```text
Outcome exists
Project exists
Project.workspace_id == Outcome.workspace_id
Project is Target of Outcome
```

を強制する。

---

# 33. Outcome execution / evaluation

1 Outcome に複数 Project があるため、Project ごとの execution summary を扱う。

```text
OutcomeProjectExecutionSummary
- workspace_id
- outcome_id
- project_id
- ...
```

Evaluator は全 Target Project の summary / evidence を snapshot として評価する。

Task accepted = Outcome achieved にはしない現行原則を維持する。

初期 evaluator 起動条件:

```text
全 target project から execution summary が還流
AND incomplete が無い
→ evaluator
```

---

# 34. Research / ADR

Research は Workspace scope。
Evidence は Project Resource を参照できる。

Direction Decision は Workspace scope。
ADR artifact は対象 Project / Repository 側。
COMPASS は reference を保持する。

---

# 35. UI

```text
Workspace Selector

Overview
Direction
Projects
Activity
Agents
```

Workspace Overview:
- Mission
- Vision
- Active Intent
- Active Outcomes
- Target Projects
- Needs Attention
- Active Agents
- Recent Activity

Project detail:
- Purpose
- Contributing Outcomes
- Stories
- Tasks
- Claims
- Activity
- Resources
- Agents

Outcome detail:

```text
Outcome
├─ Consumer Project
│  └─ Stories
├─ Business Project
│  └─ Stories
└─ Platform Project
   └─ Stories
```

---

# 36. 今回入れないもの

```text
Workspace-specific Skill
Workspace-specific Knowledge override
Workspace-specific Policy override
Workspace-specific Role definition
Billing
Tenant subscription
Organization SSO
Workspace inherited Project Role
```

Workspace 導入を SaaS 機能導入にしない。

---

# 37. 推奨 migration sequence

1. ADR: Workspace / Direction scope / OutcomeTargetProject / Access scope / Activity scope
2. `packages/organization`
3. Workspace persistence + `project.workspace_id`
4. Project / Resource ownership move
5. Direction Workspace scope
6. OutcomeTargetProject
7. Work handoff / multi-project Story
8. Activity Workspace scope
9. Access Workspace scope
10. Role Context
11. Orchestrator
12. UI
13. legacy cleanup

---

# 38. 必須テスト

Workspace:
- Workspace作成
- Projectは必ず1 Workspace
- archive behavior

Direction:
- IntentはWorkspace所属
- OutcomeはIntentと同Workspace
- Research / Decision / EvaluationがWorkspace scope

Outcome Target:
- 同一Workspace Projectのみ
- 重複不可
- targetなし許容
- target追加後Manager dispatch

Work:
- 1 Outcomeから複数Project Story
- target外Project handoff拒否
- Project間漏洩なし

Access:
- Workspace RoleでProject Work tool拒否
- Project RoleでWorkspace Direction tool拒否
- activeRole + scope不一致拒否

Activity:
- Workspace Activity
- Project Activity
- workspace/project不整合拒否
- append-only/correction semantics維持

Orchestrator:
- targetなしOutcome → strategist
- target A/B → manager A/B
- AにStoryあり/Bなし → manager Bだけ
- 全target execution完了 → evaluator
- archived Project / Workspaceはdispatchなし

---

# 39. 辛口レビュー

1. Workspaceを便利箱にしない。
2. Project = Repository に戻さない。
3. OrchestratorにProject選択をさせない。
4. ManagerをWorkspace Roleにしない。
5. Access inheritanceを早期導入しない。
6. Project IDとWorkspace IDを区別し、新規DB内の参照整合を保つ。
7. `project_id`列にWorkspace IDを長期保存しない。
8. Project単体の完了でOutcome達成にしない。
9. Workspace導入を理由にWachaを再サービス化しない。
10. `.mcp.json` のWachaをproduct/runtime依存と誤読しない。
11. 一度のPRで全migrationを完成させない。

---

# 40. Codexへの最初の指示

実装前に:

1. この文書と現行 `compass-codex-architecture-handoff.md` を比較。
2. `packages/direction` の全 `projectId` 依存を列挙。
3. `packages/access` の Project scope 前提を列挙。
4. `packages/activity` の `project|system` 前提を列挙。
5. `orchestrator` の Project config/state 前提を列挙。
6. `server` の Project top-level UI/API/MCP 前提を列挙。
7. DB migration impact map を作る。
8. migration phase を file 単位の Task へ分解。
9. COMPASS 自身の開発作業管理には既存の Wacha を利用して Story / Task を登録してよい。
10. Task 単位で実装。

ここでの Wacha 利用は **COMPASSを開発するための開発プロセス** であり、COMPASS製品ランタイムへの依存追加ではない。

---

# 41. 最終像

```text
COMPASS
│
├─ Workspace: Taneru
│  ├─ Mission / Vision
│  ├─ Intent
│  │  └─ Outcome
│  │      ├─ Target: Consumer → Story
│  │      ├─ Target: Business → Story
│  │      └─ Target: Platform → Story
│  │
│  ├─ Project: Consumer
│  │  ├─ packages/work
│  │  │  └─ Story / Task / Claim / Review / Acceptance
│  │  └─ Ralph
│  │     └─ Worker / Reviewer
│  │
│  ├─ Project: Business
│  └─ Project: Platform
│
└─ Workspace: Petari
   └─ Project: Petari
```

COMPASS は、

> Mission / Vision から Intent / Outcome を導き、複数Project・複数専門Role・複数開発チームを協調させ、組織全体として成果へ進む自律ソフトウェア組織の Control Plane

である。

Wacha が目指した「開発チームの再現」は、現在の COMPASS では `packages/work + manager + Ralph` に統合されている。

COMPASS はその上位で「組織自体の再現」を担う。
