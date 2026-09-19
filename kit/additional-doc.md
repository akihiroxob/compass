# Shirube / Wacha Agent System Handoff Summary

## 1. 目的

最終目標は、**Lv6の自律協調型Agent System** を構築すること。

Humanの介入は原則として最初の `Intent` 投入のみとし、その後はAgent群が自律的に以下を回す。

```text
Intent
  ↓
Research
  ↓
Strategy / Outcome
  ↓
Planning
  ↓
Design
  ↓
Execution
  ↓
Review
  ↓
Acceptance
  ↓
Operation
  ↓
Outcome Evaluation
  ↓
Re-plan
  ↺
```

さらに、通常のProduct/Execution Loopとは別に、Agent System自体を改善するImprovement Loopも持つ。

---

# 2. システム全体の基本構造

全体を3つのLoopに分ける。

## Direction Loop

「何を目指すか」を決め、評価し、次の方向を決める。

主なRole:

```text
Researcher
Strategist
Outcome Evaluator
```

このLoopを管理するシステムが **Shirube**。

---

## Execution Loop

Outcomeを実行可能なWorkへ変換し、実装・レビュー・受け入れまで進める。

主なRole:

```text
Manager
Product Designer
Architect
Worker
Reviewer
Acceptor
Operator
```

このLoopを管理するシステムが **Wacha**。

---

## Improvement Loop

Agent System自体の性能や運用方法を改善する。

主なRole:

```text
Improvement Agent
```

対象:

```text
Prompt
Skill
Policy
Workflow
Tool
Agent configuration
Evaluation
```

Improvement Systemは別責務として考える。

---

# 3. Agent / System / Runtimeの責任分離

重要な原則。

```text
Agent
= 判断・作業する

System
= 状態を管理する

Runtime / Orchestrator
= Agentを実行する
```

ShirubeやWachaはAgent Roleではない。

また、ShirubeをRuntime / Orchestratorにはしない。

Runtime / Orchestratorは別責務として必要。

Runtimeが行うのは、

```text
状態を見る
↓
起動条件を満たしたRoleを判断
↓
Agentを起動
↓
Runを管理
↓
Retry / Resume
```

まで。

Domain上の判断はAgentが行う。

---

# 4. Agent Role一覧

## Researcher

Goal:

```text
意思決定の不確実性を減らす
```

Input:

```text
Intent
Question
Current State
Codebase
Existing Evidence
```

Output:

```text
Research
Findings
Evidence
Risks
Unknowns
Options
```

Researcherは最終判断をしない。

---

## Strategist

Goal:

```text
Intentを達成するためのOutcomeを決める
```

Input:

```text
Intent
Research
Evaluation
Current State
Constraints
```

Output:

```text
Outcome
Success Criteria
Priority
Decision
```

---

## Manager

Goal:

```text
Outcomeを実行可能なWorkに変換する
```

Input:

```text
Outcome
Current execution state
Research / Design
```

Output:

```text
Story
Task
Dependency
Acceptance Criteria
Priority
```

ManagerはShirubeとWachaの境界をまたぐRole。

```text
ShirubeからOutcomeを読む
↓
WachaにStory / Taskを作る
```

---

## Product Designer

Goal:

```text
ユーザーにとっての解決方法を設計する
```

Output:

```text
UX Flow
UI Spec
Prototype
Acceptance Example
```

必要なProjectのみ使用。

---

## Architect

Goal:

```text
安全に実装できる技術構造を決める
```

Output:

```text
ADR
Technical Design
API
Schema
Implementation Plan
```

---

## Worker

Goal:

```text
Taskを実行して成果物を作る
```

Output:

```text
Code
Test
Migration
Document
Artifact
```

WorkerはTaskやAcceptance Criteriaを勝手に変更しない。

---

## Reviewer

Goal:

```text
成果物がTask要求・品質基準を満たしているか検証する
```

Output:

```text
Approved
Changes Requested
Findings
Required Changes
```

---

## Acceptor

Goal:

```text
Story / Taskとして要求されたものが完成したか確認する
```

Reviewerとの違い:

```text
Reviewer:
正しく作られているか

Acceptor:
要求されたものが完成したか
```

---

## Operator

Goal:

```text
Productionを安全・安定して動かす
```

Output:

```text
Deployment
Rollback
Incident
Operational Metrics
```

---

## Outcome Evaluator

Goal:

```text
実際にOutcomeを達成したか評価する
```

Input:

```text
Outcome
Success Criteria
Execution Result
Production Metrics
Evidence
```

Output:

```text
achieved
not_achieved
insufficient_evidence

+ Evaluation
+ Evidence
+ Findings
```

Outcome Evaluatorは次のOutcomeを決めない。

Evaluation後にStrategistが次の方向を決める。

---

## Improvement Agent

Goal:

```text
Agent System自体を改善する
```

Input:

```text
Run history
Failures
Review findings
Rework
Cost
Latency
Quality
```

Output:

```text
Prompt Update
Skill Update
Policy Update
Workflow Update
Tool Proposal
Evaluation
```

---

# 5. Role分離の重要原則

自己承認を防ぐ。

```text
Worker ≠ Reviewer

Reviewer ≠ Acceptor

Acceptor ≠ Outcome Evaluator
```

同一Modelを使うことは可能だが、Role ContextとRunは分離する。

---

# 6. Shirubeの責務

Shirubeは **Direction Management System**。

中心となる問い:

> このProjectは何を目指していて、なぜその方向へ進み、実際に達成できたのか。

Shirubeが管理する中心概念:

```text
Project
Intent
Outcome
Success Criterion
Research
Evidence
Decision
Evaluation
```

ShirubeはTask Management Systemではない。

---

# 7. ShirubeのDirection Loop

最小Loop:

```text
Human
  ↓
Intent
  ↓
Research
  ↓
Outcome
  ↓
WachaでExecution
  ↓
Evaluation
  ↓
Decision
  ↓
Next Outcome
  ↺
```

Intentは長寿命。

OutcomeはIntentへ近づくための中間目標・仮説。

```text
Project
└── Intent
      ├── Outcome A
      │    └── Evaluation
      ├── Outcome B
      │    └── Evaluation
      └── Outcome C
```

---

# 8. Intent

Humanが与える最上位の目的。

Intentは「何を実装するか」ではない。

例:

```text
AI Agent群が、
人間の継続的な介入なしに
Software Productを継続改善できる状態を作る。
```

Intent Status候補:

```text
active
achieved
abandoned
```

---

# 9. Outcome

Intentへ近づくために達成すべき、観測可能な状態。

例:

```text
複数Workerが競合せず、
安全に並列実行できる。
```

Outcomeは「現時点でこれを達成すればIntentへ近づく」という仮説でもある。

主な属性:

```text
id
intentId
title
description
successCriteria
constraints
priority
status
parentOutcomeId?
```

Status候補:

```text
proposed
active
evaluating
achieved
not_achieved
cancelled
```

`not_achieved` は異常状態ではなく、正常な学習結果。

---

# 10. Success Criterion

Outcome作成時に成功条件を固定する。

Evaluation時に後付けで変更しない。

例:

```text
Outcome:
複数Workerが安全に並列実行できる

Success Criteria:

duplicate_claim_count = 0

abandoned_claim_recovery = 100%
```

---

# 11. Research

Direction判断の材料。

構造例:

```text
question
findings
evidence
unknowns
options
risks
```

ResearcherはDecisionを行わない。

---

# 12. Evidence

判断の根拠。

Shirubeに実体をすべて保存する必要はない。

参照先候補:

```text
GitHub
Repository
Wacha
CI
Grafana
Sentry
Test Result
Web source
Document
```

基本的にReferenceとして扱う。

---

# 13. Decision

Lv6では重要。

目的:

```text
なぜその方向を選んだのか
```

をHumanが後から追跡できるようにする。

例:

```text
Question:
次にどのOutcomeを追うか

Options:
A. Claim concurrency
B. Review automation
C. Context compression

Decision:
A

Rationale:
並列化を阻害する最大の問題だから
```

---

# 14. Evaluation

Outcomeと対になる概念。

Success Criteriaが満たされたかEvidenceに基づいて評価する。

Result:

```text
achieved
not_achieved
insufficient_evidence
```

`insufficient_evidence` を必ず持つ。

例:

```text
duplicate claim = 0

しかし実行回数 = 3

→ insufficient_evidence
```

と判断可能にする。

---

# 15. ShirubeのProject

Projectは単なるコンテナではない。

Humanが、

> この現場は何で、何を目指していて、今どうなっているか

を把握するための最上位コンテキスト。

概念構造:

```text
Project
├── Mission
├── Vision
├── Principles
├── Constraints
├── Repositories
├── Resources
│
├── Intent
│   └── Outcome
│       └── Evaluation
│
└── Wacha Execution Reference
```

---

# 16. Mission

Projectの存在理由。

```text
Mission
= なぜこのProjectが存在するか
```

長期間変わりにくい。

例:

```text
AI Agent群が安全に協調して
Software Developmentを進められる
Work Coordination基盤を提供する。
```

---

# 17. Vision

Projectが最終的に実現したい状態。

```text
Vision
= 将来どんな世界を作りたいか
```

例:

```text
HumanがIntentを与えるだけで、
複数Agentが計画・実装・レビュー・改善を
継続的に行えるSoftware Engineering環境。
```

---

# 18. Principles

AgentとHuman双方の判断原則。

例:

```text
Human intervention should be minimized.

Decisions must remain traceable.

Agents must not self-approve their own work.

State must survive agent termination.

System state must remain transparent to humans.
```

Constraintより柔らかく、迷ったときの判断基準。

---

# 19. Constraints

超えてはいけない制約。

例:

```text
Technical
- MCP compatible

Security
- SecretをRepositoryへ保存しない

Operational
- Production data destructionは禁止
```

---

# 20. Repository / Resource

ProjectとRepositoryは1:N。

ProjectをGitHub Repositoryと1:1にしない。

```text
Project
 ├── Repository A
 ├── Repository B
 └── Repository C
```

Resource候補:

```text
GitHub
Figma
Documentation
Production
Staging
Monitoring
Analytics
CI
```

---

# 21. Shirube Project画面

Humanが現場把握するため、以下を表示する。

優先表示:

```text
1. Project Name / Description / Status
2. Mission
3. Vision
4. Principles
5. Repositories / Resources
6. Active Intent
7. Active Outcomes + Success Criteria
8. Execution Summary from Wacha
9. Recent Decisions
10. Recent Learnings
11. Recent Agent Activity
```

将来追加候補:

```text
Constraints
Health
Blocked Outcomes
Incidents
Insufficient Evidence
Integration Status
```

---

# 22. Project Dashboardの考え方

Task Progress中心にしない。

Shirubeでは、

> 目標がどこまで達成されたか

を中心に見せる。

イメージ:

```text
Project: Wacha

Mission
Agentが安全に協調して...

Vision
HumanがIntentだけを...

Current Direction

Intent
└ Autonomous Development

Active Outcomes
├ Reliable Claim
├ Autonomous Review
└ Failure Recovery

Execution Summary
8 Stories
23 Tasks
4 Blocked

Recent Decisions
...

Recent Learnings
...

Recent Activity
...
```

---

# 23. Wachaの責務

Wachaは **Execution Loop Management System**。

中心となる問い:

> このOutcomeを実現するために、どんな仕事があり、今どこまで進んでいるか。

主な概念:

```text
Story
Task
Claim
Review
Acceptance
Changelog
```

ShirubeのOutcomeをWachaへ複製しない。

Wacha側ではReferenceだけ持つ。

例:

```text
Story {
  outcomeRef
}
```

---

# 24. Shirube / Wachaの境界

重要なContract:

```text
Shirube
「何を達成するか」
        │
        │ Outcome
        ▼
Wacha
「どう実行するか」
        │
        │ Result / Evidence
        ▼
Shirube
「達成できたか」
```

OutcomeがDirection LoopとExecution Loopの境界。

---

# 25. Wachaが持たないもの

Wachaには以下を持たせない方向。

```text
Mission
Vision
Intentの詳細
Strategic Decision
Outcome Evaluation
```

必要ならReferenceのみ。

---

# 26. Shirubeが持たないもの

Shirubeには以下をDomain Conceptとして持たせない。

```text
Task
Claim
Pull Request
Code Review
Agent Run
Prompt
Skill
Deployment Job
```

必要な場合はReferenceのみ。

---

# 27. Runtime / Orchestrator

必要だがShirube/Wachaとは別責務。

責務:

```text
State observation
Agent invocation
Role selection
Context construction
Run lifecycle
Retry
Resume
Waiting
Concurrency
```

Runtimeは戦略判断をしない。

例:

```text
Shirube:
Outcome Evaluation = not_achieved

Runtime:
Strategistを起動

Strategist:
次のOutcomeを決定

Shirube:
Outcomeを保存
```

---

# 28. Repository統合方針

論理的責務分離とRepository分割は別問題。

方向性としては **モノレポ化に前向き**。

1 Repositoryでも、Bounded Contextは分離する。

以前の草案:

```text
agent-system/
├── apps/
│   ├── api/
│   ├── ui/
│   └── runner/
│
├── packages/
│   ├── shirube/
│   │   ├── domain/
│   │   ├── application/
│   │   └── infrastructure/
│   │
│   ├── wacha/
│   │   ├── domain/
│   │   ├── application/
│   │   └── infrastructure/
│   │
│   ├── improvement/
│   │   ├── domain/
│   │   └── application/
│   │
│   ├── agent-runtime/
│   ├── agent-roles/
│   └── shared/
```

ただし、これはまだ最終決定ではない。

最新のDirection / Execution分離を反映したディレクトリ構成は再検討する。

---

# 29. MCP方針

外向きMCP Serverは一つでもよい。

内部責務は分離する。

例:

```text
shirube.create_intent
shirube.get_outcome
shirube.record_evaluation

wacha.create_story
wacha.claim_task
wacha.submit_review

improvement.record_evaluation
```

将来必要ならEndpoint自体を分離可能。

---

# 30. 重要な設計原則

## A. 状態を外部化する

Agentが停止しても状態が消えない。

```text
Agent memoryに依存しない
```

---

## B. 判断理由を残す

単に「何をしたか」ではなく、

```text
なぜそう判断したか
```

をDecision / Evidenceで追跡可能にする。

---

## C. Humanへの透明性

Lv6でもHumanから見て、

```text
何を目指しているか
なぜそれを目指しているか
今何をしているか
何が問題か
何を学んだか
```

が把握できること。

---

## D. Roleと権限を分離する

Roleは少なくとも、

```text
Goal
Input
Decision authority
Output
Allowed operations
Forbidden operations
```

で定義する。

---

## E. System同士でDomain ownershipを重複させない

```text
Direction state → Shirube
Execution state → Wacha
Agent execution state → Runtime
Agent improvement state → Improvement System
```

を基本とする。

---

# 31. 現時点での最小Shirube Domain

Core:

```text
Project
Intent
Outcome
SuccessCriterion
Evaluation
Decision
```

Support:

```text
Research
Evidence
Repository
Resource
Principle
Constraint
```

MVPではSupport Conceptを簡略化してもよい。

---

# 32. 未解決事項

以下はまだ最終決定していない。

## 32.1 モノレポの最終構造

Shirube / Wacha / Improvement / Runtimeを、

```text
apps
packages
contexts
services
```

のどの粒度で分けるか。

DDD / Clean Architectureをどこまで適用するかも含めて再設計する。

---

## 32.2 ProjectとMission / Visionのモデル

現状方向性は、

```text
Project
├ Mission
├ Vision
├ Principles
└ Constraints
```

だが、

これらをProject Entityのフィールドにするか、独立Conceptにするかは未決定。

初期実装ではProject Aggregate内に持つ可能性が高い。

---

## 32.3 IntentとMissionの関係

基本認識:

```text
Mission
= 永続的な存在理由

Intent
= Humanが現在実現したい状態
```

ただし複数Intentの同時Activeをどこまで許可するかは未決定。

---

## 32.4 Outcome階層

`parentOutcomeId` を持たせる案はあるが、

Outcomeを階層化しすぎると複雑になるため要検討。

---

## 32.5 Execution完了からEvaluation開始まで

以下のような場合がある。

```text
Story完了
↓
Production投入
↓
7日間Metrics収集
↓
Outcome Evaluation
```

このWaiting / Observation Windowを、

Shirube / Runtime / Operatorのどこで表現するかは未決定。

---

## 32.6 Improvement System

責務は定義したが、Domain Model / System名 / Repository構成はまだ未設計。

---

## 32.7 Runtime / Orchestrator

必要性は合意。

ただし名称・具体的責務・実装方法はまだ未確定。

以前のShirube内 `manager-runner` 等との関係も再整理が必要。

---

## 32.8 名前

Shirube / Wachaの名称は変更する可能性あり。

名前ではなく責務境界を優先する。

---

# 33. 次にやること

優先順。

## Step 1: 最新版Monorepo Architectureを決める

以下を同一Repoへ統合する前提で構造を決める。

```text
Shirube
Wacha
Improvement
Runtime
UI
API / MCP
```

ただしBounded Contextは維持する。

---

## Step 2: Project Domainを確定

最低限:

```text
Project
Mission
Vision
Principles
Constraints
Repositories
Resources
```

の型と更新ルールを決める。

---

## Step 3: Shirube MVP Domainを実装

順序候補:

```text
Project
↓
Intent
↓
Outcome
↓
SuccessCriterion
↓
Decision
↓
Evaluation
```

Research / Evidenceは後からでもよい。

---

## Step 4: Project Dashboard

最初にHumanが見る画面を作る。

最低表示:

```text
Project Identity
Mission
Vision
Principles
Repositories
Resources
Active Intent
Active Outcomes
Recent Decisions
Recent Learnings
Wacha Execution Summary
Activity
```

---

## Step 5: Shirube → Wacha Contract

最低限:

```text
OutcomeRef
Execution Result Reference
Evidence Reference
```

を定義する。

---

## Step 6: Runtimeを分離設計

Domain Systemと混ぜずに、

```text
watch
invoke
run
retry
resume
```

に集中させる。

---

## Step 7: Lv6の1周を実際に通す

具体例を一つ使い、

```text
Human Intent
→ Research
→ Outcome
→ Manager
→ Wacha Story / Task
→ Worker
→ Reviewer
→ Acceptor
→ Evaluation
→ Strategist
→ Next Outcome
```

をEnd-to-Endで成立させる。

最初は完全自律でなくてもよいが、Architecture上はHuman介入なしで成立する形にする。

---

# 34. Codexへの最重要指示

実装時に最優先するのは、機能量ではなく責務境界。

以下を崩さないこと。

```text
Shirube
= Direction Management

Wacha
= Execution Management

Runtime
= Agent Execution

Improvement
= Agent System Improvement
```

特に、

```text
ShirubeをTask Managerにしない
WachaをStrategy Managerにしない
RuntimeにDomain判断を持たせない
```

こと。

完成形のゴールは、

```text
Human
  ↓ Intent

Agent Organization
  ↓
自律的なDirection / Execution / Evaluation / Improvement

Human
  ↓
必要なときに透明に現場を観察できる
```

状態である。
