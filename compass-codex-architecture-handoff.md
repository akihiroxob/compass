# COMPASS Architecture Handoff for Codex

## 0. この文書の目的

既存の Wacha / Shirube / agent-foundation を、COMPASS という1つのモノレポへ段階的に統合する。

この文書は、Codex が統合作業を行う際の設計上の正本として使うことを目的とする。

Workspace と Project の境界は [ADR 0001](docs/adr/0001-workspace-project-boundary.md) で確定した。本書の Direction / Access / Activity / Orchestrator の scope は同 ADR に従う。

重要な原則は以下。

- DDD で業務上の境界を表現する。
- Clean Architecture の依存方向を守る。
- 人間と Agent の双方が理解しやすい構造にする。
- 実体のない抽象化や将来用の空ディレクトリを先に作らない。
- 境界が見えてから分ける。
- 共通性が実際に現れてから共通化する。
- 保存先は情報の内容と所有責務で決める。COMPASS が管理する Project 別の状態・判断・評価・活動記録は COMPASS 内に保持できる。
- Repository / Docs が正本となる成果物は対象 Project 側に置き、COMPASS は参照する。Project 固有であることだけを理由に保存を禁止しない。

---

# 1. COMPASS の全体構造

現時点では次を基本構造とする。

```text
compass/
├─ server/
├─ orchestrator/
├─ ralph/
│
├─ roles/
├─ skills/
├─ knowledge/
├─ policies/
│
├─ packages/
│  ├─ organization/
│  ├─ direction/
│  ├─ work/
│  ├─ activity/
│  ├─ access/
│  └─ shared/
│
├─ infra/
├─ docs/
│
├─ package.json
├─ pnpm-workspace.yaml
└─ README.md
```

`apps/` は使用しない。

`server` / `orchestrator` / `ralph` は、同一 Application の別エントリポイントではなく、COMPASS を構成する独立した実行システムとして扱う。

それぞれ独立して、

- 実行できる
- ビルドできる
- デプロイできる
- 異なるライフサイクルを持てる

ことを前提とする。

---

# 2. server

## 2.1 責務

`server` は COMPASS の中心となる Control Plane。

以下を提供する。

- Web UI
- HTTP API
- MCP
- 認証・認可
- Role / Skill / Knowledge の配信
- Direction / Work / Activity 等の Application Use Case への入口

概念構造：

```text
Human
  │
  ├─ Web
  └─ HTTP API
        │
        ▼
     Application
        ▲
        │
Agent ─ MCP
```

Web / HTTP API / MCP に業務ロジックを重複実装しない。

同じ操作は同じ Application Use Case を呼ぶ。

例：

```text
HTTP handler ───┐
                ▼
        ClaimNextTaskUseCase
                ▲
MCP tool ───────┘
```

## 2.2 想定構成

```text
server/
├─ src/
│  ├─ web/
│  ├─ api/
│  ├─ mcp/
│  ├─ auth/
│  ├─ bootstrap/
│  └─ main.ts
├─ tests/
├─ package.json
├─ tsconfig.json
└─ README.md
```

---

# 3. orchestrator

## 3.1 責務

`orchestrator` は Workspace 単位で COMPASS の現在状態を確認し、

> 次にどの専門 Role を実行すべきか

を判断して Agent を起動する Batch Application。

Orchestrator 自身が専門的な知的作業を抱え込まない。

概念例：

```text
Workspace の現在状態を確認
        │
        ├─ 未処理 Intent / Target Project のない Outcome
        │      └─ strategist(workspace)
        │
        ├─ 調査が必要
        │      └─ researcher(workspace)
        │
        ├─ Target Project に Outcome の Story がない
        │      └─ manager(project)
        │
        ├─ 全 Target Project の Execution が評価可能
        │      └─ evaluator(workspace)
        │
        └─ その他
               └─ 適切な専門 Role
```

## 3.2 deterministic code と Agent 判断の境界

明示的な状態判定はコードで行う。

例：

```text
未処理 Intent が存在
→ strategist を起動

research_required 状態
→ researcher を起動

Target Project に Outcome の Story が存在しない
→ その Project の manager を起動
```

以下のような知的判断は専門 Role に委譲する。

```text
Intent をどの Outcome に具体化するか
→ strategist

何をどう調査するか
→ researcher

Outcome をどの Project が担当するか
→ strategist

Outcome をどの Story / Task に分解するか
→ manager
```

Orchestrator を巨大な Manager Agent にしない。

## 3.3 Activity を workflow の正本にしない

Orchestrator の起動判断は、原則として Direction / Work 等の「現在状態」を参照して行う。

Activity cursor を workflow checkpoint として使わない。

Activity は過去の意味ある履歴・文脈復元に利用する。

これにより Orchestrator 自身に複雑な cursor 永続化を持たせない。

---

# 4. ralph

## 4.1 背景

現在の Ralph 実装は `agent-foundation` に存在する。

将来的に COMPASS モノレポへ移行する。

## 4.2 責務

Ralph は Worker / Reviewer の実行ループを担当する独立した Batch / Loop Application。

概念的には、

```text
COMPASS Server
      ▲
      │ MCP / API
      │
    Ralph
      │
      ├─ worker Role を起動
      ├─ Task を実行
      ├─ 結果を COMPASS へ戻す
      ├─ reviewer Role を起動
      └─ Loop
```

Ralph に Role の詳細な instruction や Skill 本文を固定しない。

Ralph は実行時に COMPASS Server へ問い合わせて取得する。

Ralph が持つべき責務は主に、

```text
Role を指定する
↓
Role Context を取得する
↓
LLM / Agent を起動する
↓
結果を COMPASS に戻す
```

である。

---

# 5. Direction Bounded Context

## 5.1 責務

`packages/direction` は、

> Workspace が何を、なぜ実現したいのか

を扱う。Direction の scope は Workspace とする。

現時点では Direction 全体を1つの Bounded Context とする。

主な概念：

```text
Workspace                       (Organization)
  ├─ Mission / Vision / Principles / Constraints
  ├─ Projects
  └─ Intent                     (Direction)
       └─ Outcome
            └─ Target Project
```

Workspace / Project / ProjectResource は `packages/organization` が所有する。Direction は Intent / Outcome / 成功条件 / OutcomeTargetProject / Research / Direction Decision / Evaluation / Execution Summary・Evidence / Runtime Event を所有する。Intent / Outcome を最初から別 Bounded Context にしない。

Workspace は Mission / Vision を共有し、複数 Project を通じて成果を実現する戦略単位。Project は1つの Workspace に属する実行・システムの境界。Workspace を GitHub Organization と、Project を Repository と同一視しない。

## 5.2 Outcome の所有

Outcome は Direction が所有する。

```text
Direction

Intent
  ↓
Outcome
```

Work は Outcome の Entity を複製せず、`outcomeId` を参照する。

Outcome は Workspace level の状態であり、複数 Project にまたがれる。どの Project が担当するかは Strategist が `OutcomeTargetProject` として明示する。Target Project の manager が、その Project の Story を作る。Story 作成時は Project と Outcome の Workspace が一致し、Project が Target であることを強制する。

```text
Direction                Work

Outcome ─── outcomeId ─→ Story
                          ↓
                         Task
```

## 5.3 Project Resource

Project と ProjectResource は `packages/organization` が所有する。Repository / Docs が正本となる Project 成果物は対象 Project 側に置く。COMPASS が所有する Project 別レコードは COMPASS 内に保持できる（§9）。

COMPASS の Project は「どこを見るべきか」を Resource として保持する。

概念例：

```ts
ProjectResource {
  id
  projectId
  type        // repository | documentation | url | design ...
  name
  uri
  role?       // primary | docs | reference ...
}
```

例：

```text
Petari
├─ Primary Repository
├─ Architecture Docs
└─ Figma
```

Project 固有の文書本文を COMPASS Knowledge へコピーしない。

---

# 6. Work Bounded Context

## 6.1 責務

`packages/work` は、

> Outcome を実現するための仕事をどう管理するか

を扱う。

主な概念：

```text
Story
Task
Claim
Review
Acceptance
```

現時点ではこれらを別 Bounded Context に分割しない。

## 6.2 基本フロー

```text
Outcome
  ↓
Story
  ↓
Task
  ↓
Claim
  ↓
Execution
  ↓
Review
  ↓
Acceptance
```

Agent process の起動そのものは Work Domain の責務ではない。

Work は「仕事の状態」を管理する。

## 6.3 manager

Wacha の `manager` Role は、COMPASS 統合後も同じ名前で扱う。manager は Project scope の Role であり、Workspace 全体の planner にしない。

責務：

- 自 Project が Target である Outcome を Story / Task に分解する
- Story / Task を管理する
- 最終 Acceptance を担当する
- 要件観点から Reject する

---

# 7. Activity Bounded Context

## 7.1 Activity は最初から独立 Package とする

Activity は Direction / Work / Orchestrator / Ralph 等、複数領域から利用される。

また、

> Agent や人間が後から Workspace / Project の経緯を復元する

という独自の責務を持つため、最初から `packages/activity` として境界を切る。

```text
packages/
├─ direction/
├─ work/
├─ activity/
├─ access/
└─ shared/
```

## 7.2 Activity の目的

Activity はアプリケーションの raw log ではない。

```text
Activity
= System / Workspace / Project 上で何が起き、
  何が分かり、
  何が決まったかを、
  後から人間や Agent が理解するための履歴
```

## 7.3 最低 Schema

概念モデル：

```ts
Activity {
  id

  scope       // system | workspace | project
  workspaceId? // scope=workspace / project の場合必須
  projectId?  // scope=project の場合必須。それ以外は持たない

  type

  principalId
  role

  summary
  body?

  refs[]

  occurredAt
  cursor
}
```

Direction の canonical Activity は Workspace Activity、Work の canonical Activity は Project Activity とする。scope と ID の組合せが合わない記録は拒否する。

`runId` は持たせない。

理由：

- Agent の1回の実行単位は Project の記憶モデルでは重要性が低い
- Activity を execution trace に引っ張らない
- 実行追跡が必要なら Operational Log / Trace で扱う

## 7.4 Principal と Role

Activity では、

```text
principalId = 誰が実行したか
role        = 何の立場で行ったか
```

を記録する。

例：

```text
principalId: orchestrator
role: researcher

principalId: ralph-worker
role: worker

principalId: ralph-reviewer
role: reviewer
```

## 7.5 summary は必須

Agent が過去を読むとき、大量の本文を毎回読む必要がないようにする。

```text
Activity 一覧
↓
summary を読む
↓
必要な Activity の body / refs のみ掘る
```

`body` は任意で Markdown を許可する。

## 7.6 Activity Reference

Activity は Project 側の成果物や COMPASS 内部 Entity への参照を持てる。

例：

```text
ActivityReference

- Project Resource + path + revision
- URL
- Intent ID
- Outcome ID
- Story ID
- Task ID
```

Project 固有成果物の本文を Activity に複製しない。

## 7.7 Activity は DB 保存

Activity は以下が重要。

- Workspace / Project 単位取得
- 時系列取得
- Role / Principal での絞り込み
- cursor による差分取得
- Entity との関連付け

そのため DB に構造化データとして保存する。

原則 append-only とする。

修正が必要な場合は過去 Activity を書き換えるより、訂正 Activity を追加する方針を優先する。

## 7.8 Activity の生成

すべてを Agent の手動記録に依存しない。

重要な Domain 状態変更については、Application / Domain Event 等から canonical Activity を自動生成できる構造を目指す。

一方、

- 調査結果
- 判断理由
- 意思決定
- 引き継ぎ情報

等の意味的 Activity は Agent が明示的に記録してよい。

---

# 8. Logging の3層

COMPASS では次を区別する。

## Operational Log

対象：

- 開発者
- 運用者

内容：

- error
- request
- latency
- stacktrace
- trace

保存：

- stdout
- log backend
- observability system

Agent の通常 Context には入れない。

## Change Log

対象：

- System
- Agent

内容：

- 正確な状態変更
- Claim
- Task status transition 等

形式：

- structured
- append-only

## Activity

対象：

- Human
- Agent

内容：

- 意味のある活動
- 判断
- 調査結果
- 決定
- 成果への参照

形式：

- structured metadata
- summary
- optional Markdown body
- refs

Operational Log / Change Log / Activity を同一概念にしない。

---

# 9. Project 固有成果物の所有

Project 別の情報も、その内容と所有責務に応じて COMPASS 内に保存できる。Direction Decision・Evaluationなど、COMPASS の判断・状態管理に必要な構造化レコードは保持する。Project 固有という理由だけで既存データを削除・外部移行しない。

Repository / Docs が正本となる設計文書・ADR・成果物は、対象 Project 側に置く。Research の結果や本文は、その内容が COMPASS の管理レコードか、外部成果物かを判断して保存先を決める。長さだけで一律に決めない。

例：

```text
Project Repository
├─ docs/research/auth.md
├─ docs/design/database.md
└─ ...
```

外部に正本がある成果物について、COMPASS は、

```text
何が行われたか
どこに成果物があるか
```

を Activity / ProjectResource として保持する。

例：

```text
Activity
「認証方式の調査を完了。OAuth を第一候補とした」

refs:
  ProjectResource: primary-repository
  path: docs/research/auth.md
  revision: abc123
```

正本は情報ごとに定める。COMPASS 所有のレコードは COMPASS、Repository / Docs 所有の成果物は対象 Project 側を正本とし、同じ本文の二重管理を避ける。

初期構成では `packages/artifact` を作らない。

System Artifact の管理が将来明確な独立責務になった時点で、新しい境界として検討する。

---

# 10. Role / Principal / Execution のモデル

## 10.1 概念は分離する

```text
Principal
= 実行主体

Role
= 何をする立場か

Skill
= その仕事をどう行うか

Tool
= 実行可能な操作

Knowledge
= 判断・作業時に使う共通知識
```

概念的には分離する。

ただし実運用上、

```text
Ralph Worker ↔ worker
Ralph Reviewer ↔ reviewer
```

のように1:1でも問題ない。

モデル上1:1に固定しない。

## 10.2 Principal

Principal は認証された実行主体を表す。

例：

```text
orchestrator
ralph-worker
ralph-reviewer
human:akihiro
system:web-ui
```

Ralph の Worker / Reviewer は当面、別 Principal・別 Credential で運用する。単に activeRole を切り替えて同一 Principal を兼用しない。自己レビュー・自己受入禁止は引き続き Work 側で強制する。運用上の支障が具体化した場合に分離方式を再検討し、自動的に制約を緩めない。

上記の名前は例であり、具体的な命名規則は実装時に既存認証方式との整合を見て決める。

## 10.3 Role

Role と scope：

```text
Workspace: strategist / researcher / evaluator
Project:   manager / worker / reviewer
```

Role は Agent 実行主体の名前として使わない。

`agent/worker.md` のような構造ではなく、

```text
roles/worker.md
```

とする。

## 10.4 Active Role

1 Principal は同一 scope（Workspace または Project）で複数 Role Grant を持てる。

ただし、1回の Agent 実行・操作 Context では `activeRole` を1つに固定する。

概念：

```text
Principal
  ├─ granted: strategist
  ├─ granted: researcher
  └─ granted: manager

今回の実行
  └─ activeRole: researcher
```

Server は、

```text
principalId
+
scope（workspaceId または projectId）
+
activeRole
```

について Role Grant を検証する。Role と scope の組合せが §10.3 と異なる場合は拒否する。Workspace の Grant / Membership から Project の権限を継承しない。

これにより、

- Activity にどの Role として行動したか記録できる
- 複数 Role の権限を暗黙に合算しない
- 最小権限で実行できる
- 越権行為を抑制できる

`activeRole` を transport 上でどう伝えるかは実装詳細とし、Codex は既存認証方式を確認して最小変更で設計すること。

---

# 11. Access / Authorization

## 11.1 独立境界

Role Grant が COMPASS 全体へ広がるため、認証・認可の業務ロジックを `shared` や `work` に押し込まない。

```text
packages/access/
```

を設ける。

主な責務：

```text
Principal
Role
WorkspaceMembership / ProjectMembership
WorkspaceRoleGrant / ProjectRoleGrant
scope 付き Credential（workspace | project）
Workspace / Project scoped authorization
Authorization decision
```

## 11.2 認可は Server 側で強制する

Instruction や Skill は認可の正本ではない。

例：

```text
worker → claim_task     allow
worker → complete_task  allow
worker → accept_task    deny
```

LLM が誤った操作を試みても Server が拒否する。

## 11.3 Domain invariant は Domain に残す

Role Policy だけでは表現できないルール、

例：

- 自己レビュー禁止
- 自己受入禁止
- Claim 所有者のみ更新可能
- Claim expiration
- Task status transition

等は `packages/work` の Domain / Application で強制する。

Authorization と Domain invariant を混同しない。

---

# 12. Role Definition / Skill / Knowledge / Policy

トップレベル：

```text
roles/
skills/
knowledge/
policies/
```

これらは「実行システムのソースコード」ではなく、

> COMPASS で Agent を構成するための Git 管理された構成資産

として扱う。

---

# 13. Role Definition

例：

```text
roles/
├─ strategist.md
├─ researcher.md
├─ manager.md
├─ worker.md
└─ reviewer.md
```

Role Definition は主に、

- Purpose
- Responsibilities
- Boundaries
- Prohibited actions
- 使用する Skill
- 行動原則

を定義する。

Role Definition に具体的な Skill の詳細手順を重複記載しない。

依存方向：

```text
Role
  └─ uses → Skill

Skill
  └─ Role を知らない
```

---

# 14. Skill

Skill は、

> 再利用可能な実行手順

を表す。

Wacha の Markdown + Frontmatter 方式を継承する。

例：

```yaml
---
name: implement-task
description: Task をレビュー可能な状態まで実装する
status: active
version: 6
requiredKnowledge:
  - principles/development-principles.md
requiredTools:
  - compass:list_tasks
  - compass:claim_task
  - compass:complete_task
---
```

Skill から `allowRoles` は削除する。

Role との対応は Role Definition 側から表現する。

Skill は認可を担当しない。

---

# 15. Tool Namespace

Tool metadata では namespace を必須とする。

例：

```text
compass:list_tasks
compass:claim_task
compass:complete_task

github:create_pull_request

web:search
```

Skill 本文では可読性のため短縮名を使ってもよいが、machine-readable metadata では namespace 付き識別子を使う。

---

# 16. Knowledge

`knowledge/` は Agent System 共通の知識だけを置く。

例：

```text
knowledge/
├─ principles/
│  ├─ development-principles.md
│  └─ ai-native-ddd.md
└─ tips/
   ├─ reviewing.md
   └─ verification.md
```

Project 固有知識を共通の `knowledge/` に混在させない。Repository / Docs の資料は対象 Project を正本とし、COMPASS が管理する Project 別の記録は該当する Domain に保持できる。

```text
COMPASS Knowledge
= 共通知識

Project Repository / Docs
= Project 固有知識
```

Skill は `requiredKnowledge` を宣言し、JIT で取得する。

---

# 17. Policy

`policies/` には Agent が理解すべき共通 Policy 文書を置く。

ただし、Markdown Policy を認可の唯一の強制手段にしない。

実際の認可は `packages/access`、Domain invariant は該当 Domain のコードとテストで強制する。

Policy 文書は、

- Agent instruction
- 人間向け説明
- 実装方針

として利用する。

Wacha の `role-policy.md` は COMPASS 用に一般化して移行する。

---

# 18. Role Context API

実行システムを薄く保つため、Role 情報は MCP から取得する。

## 18.1 get_role_context

概念：

```text
Workspace Role 向け（strategist / researcher / evaluator）
  scope: workspace
Project Role 向け（manager / worker / reviewer）
  scope: project
```

API は scope を明示し、曖昧な optional parameter の組合せにしない。

返すもの：

```text
Role Definition
+
適用される Policy
+
利用可能 Skill の metadata
+
Workspace: Mission / Vision / Principles / Constraints、Project 要約
Project:   Project 基本情報、Project Resources、Workspace 要約、関連 Outcome
+
同じ scope の最近の Activity summary
```

返さないもの：

- 全 Skill 本文
- 全 Knowledge 本文
- Project Repository の文書全文
- 大量の過去 Activity body

## 18.2 get_skill_context

必要になった Skill だけ JIT 取得する。

```text
get_skill_context({
  name: "implement-task"
})
```

返すもの：

```text
Skill 本文
+
requiredKnowledge
```

## 18.3 Context loading の基本

```text
Agent 起動
↓
get_role_context

具体作業開始
↓
get_skill_context

Project 固有詳細が必要
↓
ProjectResource の正本を読む

過去経緯が必要
↓
Activity を追加取得
```

Progressive Disclosure を基本とする。

---

# 19. Role / Skill / Knowledge の version

Markdown の `version` は人間向けとして残してよい。

再現性の正本は Git revision とする。

将来的に実行時の configuration revision を追跡したくなった場合は Git commit SHA 等を利用する。

Activity に Agent Run ID は保存しない。

---

# 20. 保存方式

## DB に保存するもの

少なくとも以下：

```text
Workspace
Project
ProjectResource
Intent
Outcome
OutcomeTargetProject

Story
Task
Claim
Review / Acceptance state

Principal
Membership / RoleGrant（Workspace / Project）

Change Log
Activity
```

実際の DB schema は既存 Wacha / Shirube の schema を調査して段階的に統合する。

## Git 管理するもの

```text
roles/
skills/
knowledge/
policies/
docs/
```

Git 管理の利点：

- diff
- review
- rollback
- branch
- PR
- history

Agent Improvement を将来導入する場合も、直接 DB の Skill を書き換えるのではなく、原則 Git diff / review / merge の流れを優先する。

## 外部を正本とするもの

内容と所有責務に基づき、Project Repository / Docs が正本であるべき資料は外部へ置く。例：

```text
Project 固有の調査文書
Project 固有の設計文書
Project 固有の長文レポート
Project 固有の実装計画
Project Repository が正本であるべき資料
```

これらの外部成果物については参照先を保持する。COMPASS が所有する Project 別の判断・評価・Research等の管理レコードは内容に応じて保持できる。本文を含む既存レコードの移行要否は個別に判断する。

---

# 21. Package 内部構造

基本形：

```text
package/
├─ src/
│  ├─ domain/
│  ├─ application/
│  ├─ infrastructure/
│  └─ index.ts
├─ README.md
├─ package.json
└─ tsconfig.json
```

ただし、存在しない概念用の空ディレクトリを先に作らない。

例：

Domain Event がなければ `events/` は不要。

Domain Service がなければ `services/` は不要。

---

# 22. 依存方向

基本：

```text
Infrastructure
      ↓
Application
      ↓
Domain
```

Domain は以下へ依存しない。

```text
React
Hono / Express
MCP SDK
Kysely / Drizzle
PostgreSQL / SQLite
Redis
Codex / Claude
Cloudflare
```

Interface 層から Domain を直接操作せず Application Use Case を通す。

---

# 23. Bounded Context 分割方針

現時点：

```text
Organization
Direction
Work
Activity
Access
```

を主要境界とする。Organization は Workspace / Project / ProjectResource を所有する。

以下のようにはまだ分けない。

```text
work/contexts/
├─ task/
├─ claim/
├─ review/
└─ acceptance/
```

Task / Claim / Review 等は Work 内の Domain 概念として開始する。

言語・モデル・ルール・ライフサイクルが明確に分離した場合のみ、新たな Bounded Context を検討する。

---

# 24. shared

`shared` は最小限にする。

許容例：

```text
shared/
├─ id/
├─ time/
├─ result/
└─ errors/
```

以下のような便利箱にしない。

```text
shared/
├─ task/
├─ project/
├─ agent/
├─ repository/
├─ services/
└─ utils/
```

業務上意味のある概念は対応する Domain に置く。

---

# 25. 実行時 Agent の考え方

静的な `agents/` ディレクトリは作らない。

Agent は実行時に、

```text
Principal
+
active Role
+
Role Definition
+
Skill
+
Knowledge
+
Project Context
+
Tools
```

から構成されるものと考える。

つまり、

> Agent は保存された1つの定義ファイルではなく、実行時に構成される。

実行主体と Role は概念的に分離するが、実運用上1:1であることは問題ない。

---

# 26. 現時点の推奨 Tree

```text
compass/
│
├─ server/
│  ├─ src/
│  │  ├─ web/
│  │  ├─ api/
│  │  ├─ mcp/
│  │  ├─ auth/
│  │  ├─ bootstrap/
│  │  └─ main.ts
│  ├─ tests/
│  └─ README.md
│
├─ orchestrator/
│  ├─ src/
│  ├─ tests/
│  └─ README.md
│
├─ ralph/
│  ├─ src/
│  ├─ tests/
│  └─ README.md
│
├─ roles/
│  ├─ strategist.md
│  ├─ researcher.md
│  ├─ manager.md
│  ├─ worker.md
│  └─ reviewer.md
│
├─ skills/
│
├─ knowledge/
│  ├─ principles/
│  └─ tips/
│
├─ policies/
│  └─ role-policy.md
│
├─ packages/
│  ├─ organization/
│  │  └─ src/
│  │
│  ├─ direction/
│  │  └─ src/
│  │     ├─ domain/
│  │     ├─ application/
│  │     └─ infrastructure/
│  │
│  ├─ work/
│  │  └─ src/
│  │     ├─ domain/
│  │     ├─ application/
│  │     └─ infrastructure/
│  │
│  ├─ activity/
│  │  └─ src/
│  │     ├─ domain/
│  │     ├─ application/
│  │     └─ infrastructure/
│  │
│  ├─ access/
│  │  └─ src/
│  │     ├─ domain/
│  │     ├─ application/
│  │     └─ infrastructure/
│  │
│  └─ shared/
│     └─ src/
│
├─ infra/
│  ├─ docker/
│  ├─ migrations/
│  ├─ deploy/
│  └─ schedules/
│
├─ docs/
│  ├─ architecture/
│  ├─ domain/
│  └─ adr/
│
├─ package.json
├─ pnpm-workspace.yaml
├─ tsconfig.base.json
└─ README.md
```

この Tree は「空ディレクトリを全部作れ」という意味ではない。

既存コードを分類した結果、実際に必要なものだけ作ること。

---

# 27. 既存システムからの概念マッピング

## Wacha

主に以下へ移行する。

```text
Wacha Project / Story / Task / Claim / Review
→ packages/work または packages/direction

Wacha Role Grant
→ packages/access

Wacha Change Log
→ Work の Change Log と Activity への投影を整理

agent/*.md
→ roles/*.md

skill/*.md
→ skills/*.md

knowledge/*
→ knowledge/*

role-policy.md
→ policies/role-policy.md
```

`manager` Role の名前を維持する。

Wacha の開発チーム調整のモデルは `packages/work`・`manager`・Ralph へ統合した。standalone Wacha は COMPASS の製品・ランタイムの構成要素ではない。repository root の `.mcp.json` の Wacha MCP は COMPASS 自身の開発を管理する開発ツールであり、製品の依存関係ではない。

## Shirube

Intent / Outcome 等の上流概念を `packages/direction` へ、Project を `packages/organization` へ統合する。

Orchestrator 相当の実行処理はトップレベル `orchestrator/` へ整理する。

## agent-foundation

Ralph 実装をトップレベル `ralph/` へ段階的に移行する。

Worker / Reviewer の instruction を Ralph 内へ複製しない。

---

# 28. Codex が守るべき重要ルール

1. `server` / `orchestrator` / `ralph` は独立実行システム。
2. `apps/` は作らない。
3. Web / API / MCP のビジネスロジックを重複させない。
4. Role と Principal を同一概念にしない。
5. 1 Principal は複数 Role Grant を持てる。
6. 1回の実行 Context では activeRole を1つに固定する。
7. 認可は Server / `packages/access` で強制する。
8. 自己レビュー等の Domain invariant は `packages/work` で強制する。
9. Role は責務、Skill は手順。
10. Skill に `allowRoles` を持たせない。
11. Role → Skill の一方向参照とする。
12. Tool metadata は namespace 付きにする。
13. Knowledge は COMPASS 共通知識のみ。
14. 保存先は内容と所有責務で決め、外部成果物は Project 側を正本とする。
15. COMPASS 所有の Project 別レコードは保持できる。外部成果物の本文を二重管理しない。
16. Activity は DB に保存する。
17. Activity に runId を持たせない。
18. Activity には principalId と role を残す。
19. Activity summary は必須。
20. Activity を Orchestrator の workflow checkpoint にしない。
21. Operational Log / Change Log / Activity を分離する。
22. 静的な `agents/` ディレクトリを作らない。
23. Agent 定義を Ralph / Orchestrator 内へ埋め込まない。
24. Role Context / Skill Context は MCP から JIT 取得する。
25. `shared` を便利箱にしない。
26. 空のアーキテクチャ用ディレクトリを先回りして作らない。
27. 不要な抽象化・Repository・Serviceを作らない。
28. 既存挙動を維持しながら段階的に移行する。

---

# 29. Codex の最初の作業

いきなり大規模移動を始めない。

以下の順で進める。

```text
1. 現状把握
↓
2. 責務分類
↓
3. 移行マッピング
↓
4. 依存関係確認
↓
5. 段階的移行計画
↓
6. 最小単位で移動
↓
7. テスト・動作確認
↓
8. 次の移動
```

具体的には、

1. Wacha の現行コードを調査する。
2. Shirube の現行コードを調査する。
3. agent-foundation の Ralph 実装を調査する。
4. 各ファイルを以下へ分類する。
   - server
   - orchestrator
   - ralph
   - roles
   - skills
   - knowledge
   - policies
   - direction
   - work
   - activity
   - access
   - shared
5. 移行前 → 移行後のファイルマッピングを作る。
6. 責務が曖昧なコードを一覧化する。
7. 依存方向違反を一覧化する。
8. 移行計画を提示する。
9. その後、段階的に実装する。

---

# 30. 最初に作成すべき ADR 候補

少なくとも以下は ADR として残す価値がある。

```text
- Wacha / Shirube / agent-foundation の COMPASS モノレポ統合
- apps/ を使わず独立実行システムをトップレベルへ置く
- Web / API / MCP を1つの server として提供する
- Organization / Direction / Work / Activity / Access を主要境界とする
- Outcome を Direction が所有する
- Role と Principal を分離する
- activeRole を1実行1つに固定する
- Role / Skill / Knowledge を Git 管理して MCP 配信する
- Skill から allowRoles を削除する
- Project 別情報の保存先を内容と所有責務で分ける
- Activity を system / Workspace / Project scope の意味的履歴として DB 保存する
```

Workspace と Project の境界（Direction / Work の scope、OutcomeTargetProject、Role / Activity の scope）は [ADR 0001](docs/adr/0001-workspace-project-boundary.md) として作成済み。

---

# 31. 意図的に未確定の事項

以下は、現時点では固定しない。

- DB の具体的な table schema
- ORM / Query Builder の最終選択
- Activity type の完全列挙
- activeRole を transport 上で伝える具体方式
- Orchestrator の Cron / scheduler 間隔
- System Artifact の管理方式
- Improvement System の具体構造
- Role Context API の最終 JSON schema
- Skill の人間向け version 番号の運用ルール
- ProjectResource type の完全列挙

これらは現在のアーキテクチャ境界を壊さず後から変更可能である。

---

# 32. 最終的な全体像

```text
                           COMPASS

                         server
                ┌──────────┼──────────┐
                │          │          │
               Web        API        MCP
                           │
                 Source of Truth
                           │
          ┌────────────────┼─────────────────┐
          │                │                 │
      Direction           Work            Activity
   (Workspace scope)  (Project scope)        │
      Intent/Outcome   Story/Task    Workspace/Project Memory
          │                │                 │
          └──────────┬─────┴─────────────────┘
                     │
                  Access
          Principal / Role Grant
                     │
        ┌────────────┴────────────┐
        │                         │
  orchestrator                  ralph
        │                         │
  strategist(workspace)      worker(project)
  researcher(workspace)      reviewer(project)
  evaluator(workspace)
  manager(project)
```

Agent の実行時 Context：

```text
Principal
   +
active Role
   +
Role Definition
   +
Policy
   +
Skill
   +
Knowledge
   +
Project Resources
   +
Recent Activity
   +
Tools
       ↓
    Runtime Agent
```

COMPASS の役割は、

> 人間が方向性を与え、複数の専門 Role を持つ Agent が、Project の正本情報を尊重しながら、調査・計画・実装・レビュー・受入を継続的に協調できる基盤を提供すること。

である。
