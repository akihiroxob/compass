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

## 現在の保存・Context・公開入口

Research Request/Result/Finding/Evidence/SynthesisとDirection Decisionは`workspace_id`で保存・検索する。発端Intent/Outcomeと親子recordのWorkspace一致はRepositoryの検査と複合FKで強制する。予算・期限・来歴・Synthesisのversion/supersedes・Decisionの根拠snapshotは維持する。Workspaceがarchivedなら書込を拒否し、履歴の読取は可能。

Research Evidenceは`uri`・`versionHash`に加え、任意の`resourceId`で同じWorkspaceのProject Resourceを参照できる。別WorkspaceのResourceを拒否する。Resourceを削除してもEvidenceのURI・revisionは残り、Resource IDだけNULLになる。外部成果物の本文は取り込まない。ADR依頼/参照はWorkspaceのDecisionと、明示した対象`projectId`・`repositoryId`を関連付ける。同じWorkspaceのProjectに登録されたRepositoryだけを対象とし、archived Projectへの新しい依頼・参照を拒否する。ADR本文は対象Repositoryを正本とし、参照にはpath・commit SHA・PR URLを保持する。

内部の`workspaceDirection`にResearch/Decision/ADRのuse caseとStrategist/Researcher Contextを組み立てる。Contextは`workspace`を返し、StrategistはResult/Evidence本文を含めず、Intent Briefのrequests/syntheses/conflictsをそれぞれ最大50件、件数と省略の有無を`researchHistory`で返す。Researcherは対象Requestの最新Result/Synthesisを各10件、関連Findingを50件まで返し、`history`に総件数と省略の有無を示す。省略した履歴はRequest一覧・詳細から取得する。EvaluationもWorkspace所有で、StrategistはWorkspaceとIntentを指定して最新の評価を読む。

公開入口はWorkspace IDを受け取る。Web APIは`/api/workspaces/:workspaceId/research-requests`・`/intents/:intentId/decisions`・`/adr-references`（Workspace Membership）、MCP toolは`workspaceId`入力（Workspace Role Grant）。`create_adr_handoff_request` / `record_adr_reference`は`workspaceId`に加え、対象artifactの`projectId`（同じWorkspaceのProject）と`repositoryId`を受け取る。Project ID・Project Grantから共有Workspaceは扱えない。Contextは`workspace`を返し、`project`参照は付けない。Runtime eventはProjectの数によらず同じtransactionでWorkspaceへ保存し、version 2の応答は`workspaceId`を持ち`projectId`を持たない。配送・ackもWorkspaceを指定し、公開入口（`fetch_runtime_events` / `ack_runtime_event`、`/api/workspaces/:workspaceId/runtime-events`）はWorkspace Runtime Credentialのscopeを先に検査する。

Research一覧・詳細のWeb応答は所有先の`workspaceId`を返し、`projectId`は返さない。現行UIの詳細URL `/projects/:projectId/research/:requestId` は閲覧中のProject IDで生成し、画面はProjectの所属Workspaceを解決してWorkspaceのAPIから読む。DecisionとIntent・Outcomeのリンクも閲覧中のProjectを用い、recordの所有先をURLのProjectとして扱わない。ADR参照の`projectId`は成果物の対象Projectを示し、`workspaceId`と併せて保持する。

新規DBの保存・同じschemaでの再初期化、別Workspace拒否、archive、Activity失敗時のrollback、Contextの上限、既存Project Web/MCP経路の非公開境界は`server/tests/workspaceResearch.test.ts`で検証する。旧DBデータの変換と旧ID保全は検証対象にしない。
