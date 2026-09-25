# Codex Addendum: Intent to Outcome Flow

## 変更点

ShirubeのDirection Loopにおいて、`Intent → Outcome` を固定的な直結フローとして扱わないこと。

正しくは、StrategistがIntentを受け取り、Outcomeを定義するための情報が十分かを判断する。

```text
Intent
  ↓
Strategist
  ├─ 情報が十分
  │     ↓
  │   Outcome
  │
  └─ 情報が不足
        ↓
      Research
        ↓
      Strategist
        ↓
      Outcome
```

Researchは必須ステップではない。

---

## 理由

Intentは通常、Outcomeより抽象度が高い。

例えば、

```text
Intent:
「人が最初にIntentを与えるだけで、
AI Agent群が自律的にSoftwareを改善できるようにしたい」
```

というIntentから、

```text
Outcome:
「Claimの二重取得を0件にする」
```

を直接導くことはできない。

その間には、

```text
現在どこまでできているか
何がLv6を阻害しているか
どこに最大の不確実性・ボトルネックがあるか
```

というCurrent State Understandingが必要になる。

そのため、典型的には以下の流れになる。

```text
Intent
  ↓
Strategist
  ↓
Research / Analysis
  ↓
Strategist
  ↓
Decision
  ↓
Outcome
```

---

## ただしResearchを必須にしない

Intentが十分具体的なケースもある。

例:

```text
Intent:
「主要APIのP95 latencyを200ms未満にしたい」
```

この場合はStrategistがそのまま、

```text
Outcome:
「主要APIのP95 latency < 200ms」
```

を定義してよい。

したがって、ResearchはWorkflow上の必須工程ではなく、

> Outcomeを決めるために必要な情報を補うための手段

として扱う。

---

## Role責務

### Strategist

Goal:

```text
IntentまたはEvaluationを受け取り、
次に追うべきOutcomeを決定する
```

Strategistは以下を判断する。

```text
- Outcomeを定義するための情報は十分か
- Researchが必要か
- どの問いをResearchすべきか
- どのOutcomeを優先するか
```

可能なOutput:

```text
Outcome
Research Request
Decision
Intent Completion
```

---

### Researcher

Goal:

```text
Strategistが意思決定するための不確実性を減らす
```

Researcherは最終的なOutcomeを決定しない。

Output:

```text
Findings
Evidence
Options
Risks
Unknowns
```

Research完了後はStrategistへ戻す。

---

## Evaluation後も同じ構造

Direction Loopの2周目以降も同様。

```text
Outcome
  ↓
Execution
  ↓
Evaluation
  ↓
Strategist
  ├─ 情報十分
  │     ↓
  │  Next Outcome
  │
  └─ 情報不足
        ↓
      Research
        ↓
      Strategist
        ↓
      Next Outcome
```

つまりDirection Loopは厳密には、

```text
Intent / Evaluation
       ↓
   Strategist
   ↙        ↘
Research   Outcome
   ↓
Strategist
   ↓
 Outcome
```

という形になる。

---

## Domain Modelへの影響

`Research` を `Intent` と `Outcome` の固定的な中間Entityとして扱わない。

Researchは、必要に応じて複数の対象に紐づけられる独立したDirection Support Conceptとする。

対象候補:

```text
Project
Intent
Outcome
Evaluation
Decision
```

例:

```text
Research {
  id
  projectId

  subjectType
  subjectId

  question
  findings
  evidence
  risks
  unknowns
  status
}
```

---

## Workflow設計への影響

以下のような固定ステートマシンにはしない。

```text
Intent
→ Research
→ Outcome
```

代わりに、

```text
Intent
→ Strategist

Strategist
→ Outcome

or

Strategist
→ Research Request
→ Researcher
→ Strategist
→ Outcome
```

というRole-drivenな遷移にする。

Runtime / Orchestrator側にも、

```text
Intentが作られたら必ずResearcherを起動する
```

というルールを持たせない。

正しくは、

```text
Intent created
  ↓
Strategist起動
```

とする。

Strategist自身がResearchの必要性を判断する。

---

## 設計原則

今回の修正で特に重要なのは以下。

```text
Workflowが判断しない。
Agent Roleが判断する。
```

Runtime / Orchestratorは、

```text
「どのRoleを起動する条件が成立したか」
```

だけを扱う。

```text
「このIntentにはResearchが必要か」
```

というDomain判断はStrategistの責務とする。

---

## 更新後のDirection Loop

最終的な基本形は以下。

```text
Human
  ↓
Intent
  ↓
Strategist
  ├───────────────┐
  │               │
情報不足         情報十分
  │               │
  ↓               │
Researcher        │
  │               │
  └────→ Strategist
              │
              ↓
            Decision
              ↓
            Outcome
              ↓
            Wacha
              ↓
           Evaluation
              ↓
           Strategist
              ↺
```

Shirube実装では、この柔軟性を保つこと。
