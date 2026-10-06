# Research・Decision・ADR

[Architecture Handoff](../compass-codex-architecture-handoff.md) と [ADR 0001](adr/0001-workspace-project-boundary.md) に従う。現在の保存方式は [実装状況](implementation-status.md) を参照する。

## Directionの判断

Research Request / Result / Finding / Synthesis、Direction Decision、EvaluationはWorkspace scopeとする。EvidenceやADR等のProject固有の成果物はProject Resourceを参照する。

IntentまたはEvaluationを受けて、Strategistが次に追うOutcomeを判断する。情報が十分ならOutcomeを定義し、不足する場合にResearchを依頼する。ResearchをIntentとOutcomeの間の必須工程にしない。

Researcherは調査結果・Evidence・選択肢・リスク・不明点を返す。Outcomeや最終方針は決めず、結果を受けたStrategistが判断する。OrchestratorはResearchの必要性を判断せず、現在状態から該当Roleを起動する。

## 成果物と参照

保存先はProject別かどうかではなく、内容と所有責務で決める。Compassが管理するDirection Decision・Evaluationなどの構造化レコードはCompass内に保持できる。Research Result / Finding / Synthesisの本文も一律に外部移行せず、Compassの管理レコードか外部成果物かを内容ごとに判断する。

Repository / Docsが正本となる調査・設計文書、実装計画、ADR等は対象Project側に置く。ProjectResourceが参照先を示し、Activityは要約と成果物への参照を保持する。Project別情報を共通の`knowledge/`へ混在させない。

Repository成果物の参照にはResource、path、revision等を使い、どの版に基づく判断かを追跡できるようにする。Activityの本文は任意の説明であり、Project成果物全体の保存先にはしない。

## 評価と権限

Outcomeの成功条件は作成時に固定する。Workの受入だけで成功と判断せず、Evidenceが足りない場合は`insufficient_evidence`として扱う。Runtimeは専門Roleの判断を代行しない。

HumanはWeb UIから現在の方向・判断理由・Research・成果物の参照を確認する。AgentはMCPから権限の範囲内で操作する。
