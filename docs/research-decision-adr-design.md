# Project Research・Decision・ADR連携 設計方針

## 位置づけ

この文書は、Lv6でHumanが最初のIntentを投入した後に、Researcherが判断材料を継続的に蓄積し、StrategistがOutcomeを決定し、必要な技術判断だけをRepositoryのADRへ反映するための責務境界を定める。

全体は設計方針であり、実装は段階的に進める。現在の実装状況は次のとおり。

| 項目 | 状況 |
| --- | --- |
| Research Request / Result / Finding / Evidence参照 / Synthesisのdomain・SQLite永続化・application層 | 実装済み（Task 23）。入口（Web API / MCP / Web UI）へは未接続 |
| Researcher Role・Instruction・MCP Context / Command | 実装済み（Task 24）。Human向けGrant画面はTask 29で実装済み。Runtimeによる起動は未接続 |
| Active Intent作成時のInitial Request・Runtimeイベント | 実装済み（Task 25）。Intent作成・`complete`と同一transactionで`runtime_event`へ追記し、application層の`listRuntimeEventsUseCase`で取得できる。Web API / MCPの取得・ack入口はTask 31で実装済み（「実装記録: Runtime eventのcursor・ack公開（Task 31）」）。Runtimeによる起動は未接続 |
| Intent Brief・Strategist Contextへの接続 | 実装済み（Task 26）。`get_strategist_context`の`research`にIntent Brief、新規MCP tool `get_research_request`にSynthesis→Finding→Evidence参照のID指定Queryを実装 |
| Direction Decision・Outcomeの根拠参照 | 実装済み（Task 27）。MCP tool `create_direction_decision`（next_outcome以外の5種）と`decide_next_outcome`（next_outcomeとOutcomeを同一transactionで保存）を実装。ADR連携（Repository参照・Wacha引き渡し契約）はTask 28、Human向けResearch / Decision画面はTask 29で実装済み |
| ADR Candidate・Repository参照・Wacha引き渡し契約 | 実装済み（Task 28）。MCP tool `create_adr_handoff_request` / `record_adr_reference` / `list_adr_references`を実装。実Wachaとは未接続で、fixture契約の検証まで |
| 追加Research判断のRequest・Runtimeイベント接続 | 実装済み（Task 32）。`create_direction_decision`の`additional_research`が、Decision・追加Research Request・`research_requested`イベントを1 transactionで保存する。Runtimeによる起動は未接続 |
| Human向けResearch / Decision / ADR参照のWeb UI・Web API、ResearcherのGrant管理画面統合、空DBからの実HTTP/MCP自動検証 | 実装済み（Task 29）。読み取り専用画面とWeb API、`test/researchDecisionIntegration.test.ts`を追加。外部RuntimeとWachaは未接続で、fixture契約の検証まで |

`get_strategist_context`が返す`unavailable`は`evaluation` / `evidence`のみになった（Task 26で`research`を除外）。Evaluation・Evidence相当はStrategist Contextへ接続されるまで変わらず、実装済みとして扱わない。

## 決定

- Research RequestはIntentを発端として作る。初回RequestはActive Intent作成時にCompassのapplication層が自動作成し、Agentの恣意的な起動判断に依存させない
- Research Result、Finding、SynthesisはProjectに所属させ、後続Intentから再利用できるようにする。発端と用途は`originIntentId`や参照関係で残す
- Researcherは調査と圧縮を担当するが、Outcomeや方針を決定しない
- Strategistは圧縮されたIntent Briefを読み、追加Research、Outcome、Direction Decisionを判断する
- Project WatchとDecision Researchを分ける。前者は継続観測、後者はIntentやEvaluationを発端とする期限・予算・終了条件付きの調査とする
- Direction Decision Recordの正本はCompassに置く。Mission / Vision / Principles / Constraintsの変更案は記録できるが、Agentが運用中に基盤方針を勝手に緩めない
- Architecture Decision Record（ADR）の正本は対象Repositoryに置く。Wachaの既存Manager / Worker / Reviewerが作成・レビュー・受入を担い、新しいExecution専用Roleは追加しない
- CompassはRepository ADRの本文を正本として複製せず、Decision、Repository、path、commit SHA、PR URLを参照として保持する

## 全体フロー

```text
Human creates Intent
  -> IntentActivated
  -> Initial Research Request
  -> Runtime starts Researcher
  -> Research Run
  -> Evidence Reference
  -> Finding
  -> Research Synthesis
  -> ResearchCompleted(completed | insufficient | not_needed)
  -> Intent Brief
  -> Runtime starts Strategist
  -> Direction Decision
       |- additional Research Request
       |- Outcome
       `- ADR Candidate
            -> Wacha Manager plans Story / Task
            -> Wacha Worker writes Repository ADR
            -> Wacha Reviewer reviews it
            -> Wacha Manager accepts it
            -> Compass records Repository path / commit / PR reference
```

Researchが深い調査を常に要求するわけではない。既存知識だけで判断可能ならResearcherは`not_needed`、証拠を集め切れなければ`insufficient`を終了結果として返す。いずれもRuntimeが次の判断へ進める確定結果であり、Researchを無期限の待機条件にしない。

## 2種類のResearch

### Project Watch

Project全体を継続観測する。外部Runtimeが定期または更新イベントで短いResearch Runを起動し、AgentプロセスをCompass内に常駐させない。

- ProjectのMission、Principles、Constraintsをscopeとする
- 市場、技術、Repository、運用情報などの変化をFindingとして保存する
- メインフローを停止しない
- 重複、鮮度、費用を管理し、無制限に調査しない

### Decision Research

Intent、Evaluation、Strategistの情報不足を発端にする。

- 明確なQuestion、scope、期限、業務予算、Run予算、終了条件を持つ
- `originIntentId`、必要に応じて`originOutcomeId` / `originEvaluationId`を残す
- `completed` / `insufficient` / `not_needed` / `cancelled`のいずれかで終了する
- 終了後のイベントがStrategistまたはEvaluatorを起動する

## 情報の圧縮と来歴

Strategist Contextへ全資料を投入しない。次の階層で圧縮し、各段階から根拠へ戻れるようにする。

```text
Intent Brief
  -> Research Synthesis
      -> Finding
          -> Evidence Reference
```

| 層 | 内容 | 主な保持先 |
| --- | --- | --- |
| Evidence Reference | URL、Repository file、Issue / PR、CI、Wacha実行結果、取得時刻、version / hash | Project |
| Finding | 原子的な発見、信頼度、観測時刻、有効期限、反証・競合、Evidence ID | Project |
| Research Synthesis | Questionへの結論、主要Finding、risk、option、unknown、`validAsOf`、対象Finding ID | Project |
| Intent Brief | Active Intentに関連するSynthesis、競合、未解決事項、鮮度、残り予算 | Context応答。Decision時はsnapshotを保存 |

圧縮結果は上書きせずversionを追加し、`supersedesId`、入力ID、作成Run、作成時刻、`validAsOf`を保持する。相反するFindingを平均化して消さず、競合としてIntent Briefへ残す。

初期実装では全文検索やベクトル検索を必須にしない。関連付けられたIntent、最新version、status、鮮度を使う決定的な絞り込みから始める。

## Entity境界

### Research Request

- `id`, `projectId`
- `kind`: `project_watch` / `decision`
- `originIntentId?`, `originOutcomeId?`, `originEvaluationId?`
- `question`, `scope`, `completionCondition`
- `budget`, `deadlineAt?`
- `status`: `requested` / `running` / `completed` / `insufficient` / `not_needed` / `cancelled`
- `correlationId`, `createdAt`, `updatedAt`

Active Intent作成時のInitial Research Requestは同一Intentに対して重複作成しない。自動作成と再送の冪等性をapplication層とDB制約で保証する。

### Research Run

- `id`, `researchRequestId`, `principalId`, `runRef`
- `status`, `startedAt`, `finishedAt?`
- 使用予算、停止理由、失敗情報

Runの起動、timeout、再試行、pollingは外部Runtimeの責務である。Compassは結果と監査参照を保持し、Agentプロセスの生存管理をしない。

### Research Result / Finding / Synthesis

すべてProjectに所属し、Request / Runとの来歴を保持する。Research Resultは`summary`、`findings`、`evidenceRefs`、`unknowns`、`options`、`risks`を持つ。初期実装でFindingを独立tableにするかResult配下の不変な子要素にするかは、検索要件と既存Kysely集約方針を比較してTask内で小さく決める。

### Direction Decision

- `id`, `projectId`, `intentId?`, `outcomeId?`
- `type`: `next_outcome` / `additional_research` / `intent_complete` / `intent_abandon` / `policy_proposal` / `adr_candidate`
- 判断、理由、選択肢、使用したSynthesis / FindingのIDとversion
- `principalId`, `runRef`, `createdAt`
- 判断時のIntent Brief snapshot

## Research Requestを作る主体

| 契機 | 作成主体 | 扱い |
| --- | --- | --- |
| Active Intent作成 | Compass application層 | Initial Requestを自動作成する |
| Outcome判断に情報不足 | Strategist | 追加Decision Researchを作る |
| 評価に証拠不足 | Evaluator | ResearchまたはObservation Requestを作る |
| 調査中に派生Questionを発見 | Researcher | 親Request、深さ、残予算を継承した子Requestを作る |
| 定期・外部更新 | Runtime | 事前設定されたProject Watchを起動する。新しい権限や予算を自己付与しない |

派生Requestには最大深度と予算上限を設ける。上限到達は失敗ではなく`insufficient`またはAttentionを伴う正当な停止とする。

## Decision RecordとADR

### Direction Decision Record

製品・Projectの方向を記録する。

- 対象利用者、優先順位、次Outcome、撤退、追加Research
- Mission / Vision / Principles / Constraintsの変更提案
- 正本はCompass
- ResearcherとWacha実行Roleは確定しない

基盤方針の変更・緩和は通常の自律ループで即時反映しない。Agentは`policy_proposal`を作れるが、既存Constraintsを無効化して実行を継続できない。

### Architecture Decision Record

Repositoryの技術設計を記録する。

- API、DB、認証、責務境界、技術構成など、複数Taskへ影響し変更コストが高い判断だけを対象にする
- 単発のFindingや市場情報をADRへ昇格しない
- ADR CandidateにはCompass Decision ID、根拠Synthesis ID、対象Repository、制約を含める
- Wacha ManagerがTask化し、Workerが既存Repository規約に従ってADRを作成し、Reviewerが設計と根拠・実装整合を確認する
- Wachaは方針を決めず、Compassで確定したDirection Decisionの文書反映だけをTaskとして実行できる

Repositoryに既存規約があれば`docs/adr`などを決め打ちせず従う。規約がなければ最初のADR Taskで配置と命名を小さく決める。

Compassが保持する参照の初期形は次とする。

```json
{
  "decisionId": "decision-id",
  "repositoryId": "project-repository-id",
  "path": "docs/adr/0012-example.md",
  "commitSha": "full-commit-sha",
  "pullRequestUrl": "https://example.invalid/pull/42"
}
```

`path`はProjectに登録されたGit Repository内の相対pathである。Compass serverのローカルfilesystem pathではない。Repository変更はWachaの実行フローを通し、Compassが直接Git working treeへ書き込まない。

## Roleと入口

| Role / 主体 | 責務 | 正規入口 |
| --- | --- | --- |
| Human | Project基盤設定、Intent投入、保護された方針変更、停止・再開 | Web UI |
| Researcher | Requestの調査、Result / Finding / Synthesis登録 | MCP |
| Strategist | Intent BriefからDirection DecisionとOutcomeを作る | MCP |
| Evaluator | Evidenceから評価し、証拠不足なら追加観測を要求する | MCP |
| Wacha Manager / Worker / Reviewer | ADRを含むRepository作業の計画・実行・レビュー・受入 | Wacha MCP |
| Runtime | event監視、Role起動、retry / timeout / token予算 | Web API / MCP接続 |

Human向けのResearch閲覧・手動登録はWeb UIから共通application層を使う。AgentへHuman管理操作を公開せず、HumanへCLIや直接DB操作を要求しない。

## Context API方針

- ResearcherにはProject snapshot、発端Intent、Question、既存の関連Finding、Evidence Reference、予算を返す
- StrategistにはProject、Active Intent、既存Outcome、Intent Brief、関連Synthesisの要約、競合、unknown、鮮度を返す
- すべてのResearch本文を`get_strategist_context`へ埋め込まない。詳細はID指定で取得する
- Outcome作成時は、使用したSynthesis / FindingのIDとversion、Direction Decision IDを保存する
- 外部文書本文はデータとして扱い、Role変更や権限拡張の命令として解釈しない

## Lv6と停止条件

通常経路は`IntentActivated -> Researcher -> ResearchCompleted -> Strategist`をHuman承認なしで進める。次の場合は理由・残予算・未解決事項を保存して停止してよい。

- Research予算またはdeadline到達
- 証拠不足
- 相反する重大Findingを解消できない
- 既存Constraintsへの抵触
- 保護されたProject方針の変更が必要
- Runtimeまたは外部接続の復旧予算超過

停止は正当な結果だが、人が途中でRequest、回答、再起動、予算増加を行ったRunを介入ゼロのLv6実証として数えない。

## 実装記録: Research集約の永続化（Task 23）

上記の設計のうち「未決定」とされた事項について、既存のKysely / SQLite / application層に合わせて小さく選んだ初期選択と理由を記録する。入口（Web API / MCP / Web UI）へは接続しておらず、application層のuse caseだけを公開している（`createApplicationServices`の`createResearchRequestUseCase`など）。

### 保存構造

- Findingは**独立table**（`research_finding`）にした。Synthesisが複数のFinding IDを参照し、後続のRequest・Intentから同じProject内で再利用するため、Resultの子要素にするとID指定の参照と外部キー整合を保てない。全文検索・ベクトル検索は導入せず、`project_id`の索引だけを持つ。
- Evidence参照は`research_evidence_ref`（Resultに属する）、FindingとEvidenceの対応は`research_finding_evidence`、SynthesisとFindingの対応は`research_synthesis_finding`で表し、外部キーで整合を守る。Findingは同じResultのEvidence参照を1件以上指す必要があり、Evidenceのない主張は登録できない。
- Findingの競合は`research_finding_conflict`に保存する。競合を宣言できるのは**登録済みの同一ProjectのFinding**だけで、同じResult内のFinding同士の競合は宣言できない。平均化・除外は行わず、競合はそのまま残す。競合の解釈とunknownとしての提示はIntent Brief（後続Task）が担う。
- `unknowns` / `options` / `risks`は不変な文字列配列で、要素単位では検索しないため、JSON列に保存する。
- Research Runは独立tableにしていない。Runの起動・timeout・retryはRuntimeの責務であり、Compassは来歴として`principalId`と`runRef`をResult / Finding / Synthesisに必須で保存する。使用予算はRequestの`budgetUsed`に集計し、Resultごとの使用量も保存する。Runの状態管理が必要になった時点で追加する。
- `originEvaluationId`は持たない。Evaluationが未実装で存在確認できず、存在しない参照を受け付けないため、Evaluationの導入時に追加する。`originOutcomeId`は`originIntentId`と同じIntent配下のOutcomeだけを指せる。
- すべて`create table if not exists`で追加するため、既存DBへ再適用してもProject / Intent / Outcomeには触れない。Research導入前のDBには初回の`initializeSchema`でtableだけが追加される（既存データの移行は不要）。Active Intentを持つ既存DBへのInitial Request補完は、Task 25の再初期化時のbackfillで行う。

### 状態と規則

- `requested`から、最初のResult / Synthesis登録で`running`へ進む。`completed` / `insufficient` / `not_needed` / `cancelled`は終了状態で、以後のResult・Synthesis登録、確定、取消はすべて`CONFLICT`（`details.status`に現在の状態）で拒否する。
- `completed`にはResultとSynthesisが各1件以上必要。`insufficient` / `not_needed`は停止理由（`stopReason`）が必須で、Resultなしでも確定できる（既存知識だけで判断できる場合と、証拠を集め切れなかった場合）。`cancelled`は取消理由を`stopReason`に保存する。
- `decision` Requestは`originIntentId`が必須で、そのIntentが同じProjectのactiveである場合だけ作成できる（DBのcheck制約でも強制）。`project_watch`は発端を持たない。archivedのProjectには一切書き込まない。
- 期限（`deadlineAt`）は作成時点より後でなければならず、期限後は新しいResult / Synthesisを受け付けない（`insufficient`での確定は可能）。予算は`budgetTotal`（1以上10,000以下の整数、単位はRuntimeが定める）で、使用量の累計が総量を超えるResultは登録しない。上限到達は失敗ではなく`insufficient`での正当な停止に進む。

### 冪等性

- Request・Result・Synthesisは呼び出し側が指定する`requestKey`を必須とし、Requestは`(projectId, requestKey)`、Result・Synthesisは`(requestId, requestKey)`をDBのunique indexで一意にする。
- 同じ`requestKey`で入力内容が同じ（入力のhashが一致）再送は、新しい行を作らず既存の行を返す。使用予算も二重に加算しない。Requestが確定した後に届いた再送も、状態違反ではなく作成済みの結果として返す。
- 同じ`requestKey`で内容が異なる場合は`CONFLICT`（`details.requestKey`）で拒否する。
- 確定・取消は再送しても成功しない（2回目は終了状態として拒否する）。呼び出し側はRequestを再取得して状態を確認する。
- Initial Requestの`requestKey`は発端Intentから決定的に作る（Task 25で実装済み。「実装記録: Initial Research Request・Runtime確定イベント」を参照）。これにより同じIntentへの再送・復旧・schema再初期化で重複しない。

### Synthesisのversion

- 上書きせず、`supersedesId`で前versionを指す新しい行を追加する。versionは前versionに1を加えた値で、指定しなければ1になる。
- 1つのSynthesisを置き換えられるのは1件だけで、系列の分岐はDBのunique indexで拒否する。別ProjectのSynthesisや存在しないIDは置き換えられない。
- `validAsOf`、入力Finding ID、作成Principal・`runRef`、作成時刻を保持する。Synthesisは別RequestのFindingも参照できる。

## 実装記録: Researcher Role・Instruction・MCP（Task 24）

- `ProjectRole`へ`researcher`を追加した。Grantの保存・Web API（`POST /api/projects/:projectId/grants`）・Instruction配信は既存のStrategistと同じ経路で、roleにcheck制約が無いためschema変更は無い。Web UIのGrant欄はStrategist専用のままで、Researcherの管理画面はTask 29で追加する（Strategist欄にResearcherのGrantが混ざらないよう、一覧は`strategist`だけを表示する）。
- `agent/researcher.md`を追加し、`get_role_instructions({ role: "researcher" })`は既存と同じ応答形式（`role` / `includeShared` / `files`）で返す。tool名と権限は`test/researcherMcp.test.ts`で契約テストする。
- MCP tool: `get_researcher_context`、`list_research_requests`、`register_research_result`、`register_research_synthesis`、`complete_research_request`。すべてBearerとそのProjectのresearcher Grantを毎回検査し（`UNAUTHENTICATED` / `FORBIDDEN`）、tool入力の`role`・`principalId`は認可にも来歴にも使わない。既存のResearch use caseへ委譲し、業務規則をMCP側に重複させない。
- Result / Synthesisの`principalId`はBearerから、`runRef`は入力から保存する。Request作成・取消はResearcherに公開しない（Requestの作成はTask 25でIntent作成と同一transactionで行う）。確定できるのは`completed` / `insufficient` / `not_needed`だけ。
- `get_researcher_context`が返す内容: Project snapshot、Request（Question / scope / completionCondition / 期限 / 状態）、発端Intent、予算（total / used / remaining）、このRequestの既存Result・Synthesis、関連Finding・引用Evidence参照、`unavailable: ["evaluation"]`。
- 初期選択: 「関連Finding」は、同じProjectで**同じ発端Intent**（`project_watch`は発端なし同士）を持つ**他Request**のFindingを新しい順に最大50件とした。別Intent・別Projectは含めず、自身のFindingは`results`に含まれる。Intentをまたぐ再利用・鮮度・競合の解釈・圧縮はIntent Brief（Task 26）で扱い、ここでは平均化・除外をしない。
- Direction管理（`update_project` / `create_intent` / `update_intent` / `abandon_intent`）は、Researcher Grantを持つPrincipalにも`FORBIDDEN`とした（Strategistと同じ職務分離。Agent名の変更で回避できるため、trusted-localでは構造上の保証＝Researcher用toolに該当操作が無いことが本体）。`create_outcome`等は従来どおりstrategist Grantが必要で、Researcherは実行できない。Direction Decisionは未実装（Task 27）。
- 未接続・未検証: Runtimeによる起動・監視、外部検索Provider、Strategist Contextへの接続（`get_strategist_context`の`research`は`unavailable`のまま）。検証は`createApp`に対するin-processのMCP呼び出しで、実Runtimeでの自律運転の実証ではない。

## 実装記録: Initial Research Request・Runtime確定イベント（Task 25）

Active Intent作成を契機とするInitial Requestと、Runtimeが起動条件を取得できる確定イベントを実装した。Agentの起動・schedule・polling・retry・timeout・token予算はCompassに置かない（Runtimeの責務）。

### Initial Research Request

- Web UI・Web API・MCPの`create_intent`は同じ`CreateIntentUseCase`を通る。`SQLiteIntentRepository.create`が、Intentの保存と同一transactionでInitial Requestとイベントを保存する。Requestまたはイベントの保存に失敗すればIntentも残らない（`test/initialResearch.test.ts`が、両tableへ失敗を注入して確認する）。
- `requestKey`は`initial-research:{intentId}`で、既存の`(projectId, requestKey)`のunique indexにより、同じIntentのInitial Requestは1件に収束する。作成済みなら、Requestが取消・終了済みでも再作成しない。`correlationId`は`intent:{intentId}`で、以降の`research_completed`イベントにも引き継がれる。
- 内容は`domain/model/InitialResearchRequest.ts`が決める。`kind`は`decision`、`originIntentId`はそのIntent。Questionはtitleを含む定型文で、Intent本文（desiredState / completionDefinition）は複製せず発端Intentとして参照する（Researcherは`get_researcher_context`で取得する）。予算は`initialResearchBudget`（100。単位はRuntimeが定める）。初期選択として`deadlineAt`は置かない。Compassは期限・timeoutを管理せず、Runtimeが必要に応じて`insufficient`での確定または取消を行うため。
- archivedのProject・Active以外のIntent・検証エラーでは、Intentもその子のRequest・イベントも作らない。Active Intentの重複作成は従来どおり`CONFLICT`で、再送しても増えない。
- Intentを放棄すると、そのIntentの未終了（`requested` / `running`）のResearch Requestを同一transactionで`cancelled`にする（activeなOutcomeの連動取消と同じ扱い）。放棄されたIntentのRequestが起動条件として残らないようにするため。取消はイベントにしない。

### Runtime向け確定イベント

- tableは`runtime_event`（追記のみ。更新・削除しない）。項目は`cursor`（`autoincrement`の`sequence`）、`id`、`version`（`runtimeEventVersion`、現在1）、`type`、`projectId`、`intentId`、`researchRequestId`、`correlationId`、`conclusion`、`occurredAt`。同じRequest・同じ種類のイベントはunique indexで1件に収束する。
- `research_requested`: Requestが作成されたとき。RuntimeがResearcherを起動する条件。Initial Requestに限らず、`createRequest`・追加Research判断（Task 32）でも、Request保存と同じ経路（`insertResearchRequest`）で必ず保存する。Requestがあってイベントが無い状態を作らないため。
- `research_completed`: Requestが`completed` / `insufficient` / `not_needed`で確定したとき（`conclusion`に確定結果）。Runtimeが次にStrategistを起動する条件。`not_needed`と`insufficient`も、次の判断へ進める確定結果として区別せず同じ種類で表す。
- `research_completed`を作らないもの: `cancelled`（Strategistを起動する結果ではない）、`project_watch`のRequest（発端Intentが無く、Strategistの判断対象がない）、発端IntentがactiveでなくなったRequest、確定に失敗した操作（`completed`のResult・Synthesis不足、終了済みRequestへの再送）、archivedのProject。
- 取得は`ListRuntimeEventsUseCase`（`projectId`、`afterCursor`、`limit`）で、cursor昇順・Project単位。Runtimeがcursorを保持して差分を取得する（Wachaの`list_changes`と同じ考え方）。Web API・MCPの取得入口は、consumer単位のcursor・ack付きでTask 31に実装した（下記「実装記録: Runtime eventのcursor・ack公開（Task 31）」）。`ListRuntimeEventsUseCase`はconsumerを持たない全件の読取として残す。

### 既存Intentのbackfill方針

- Initial Request導入前に作られたActive Intentは、`initializeSchema`の末尾で、Request（とイベント）が無いものにだけInitial Requestを補う。keyがIntentから決定的で、既にあれば何もしないため、起動のたびに実行しても重複しない。取消済みのRequestも再作成しない。
- 対象はarchivedでないProjectのActive Intentだけ。`abandoned` / `achieved`のIntentとarchivedのProjectには補わない。既存のIntent・Outcome・Resultは変更しない（Requestを持たない状態でも従来どおり動く）。
- 理由: 起動時の自動backfillは、専用のCLI・Web操作を要求せず（CLIは保守用途に限る）、導入前のActive Intentも他のIntentと同じ流れでRuntimeが扱えるため。導入前のIntentにResearchを走らせたくない場合は、そのIntentのRequestを`cancelled`にすれば再作成されない。
- 未検証: 実DB（本番相当のデータ量）でのbackfill、Runtimeが実際にイベントを取得して起動する経路。検証は`createApplicationServices`に対するin-processの呼び出しで、Lv6の実証ではない。

## 実装記録: Intent Brief・Strategist Context接続（Task 26）

Finding → Research Synthesis → Intent Briefの段階圧縮をapplication層で組み立て、`get_strategist_context`の応答へ`research`として追加した。全文検索・ベクトル検索・LLM Summarizerは使わず、Task 23の設計どおり関連付け・状態・最新version・`validAsOf`による決定的な絞り込みだけで組み立てる。

### Intent Briefの構成

- `GetStrategistContextUseCase`がActive Intentを解決した後、`ResearchRepository.findIntentResearchSummary(projectId, intentId)`を呼び、結果を`research`に載せる。Active Intentが無ければ`research`も`null`（`activeIntent`と対称）。
- `research.requests`: このIntentを`originIntentId`に持つDecision Requestの要約（`status` / `question` / 予算 / `deadlineAt`）を新しい順に返す。`cancelled`を含む全状態で、除外しない（来歴として残す）。
- `research.syntheses`: `cancelled`のRequestを除いた上で、各Synthesis系列（`supersedesId`の連鎖）のうち他のSynthesisの`supersedesId`から指されていない行だけを「最新version」として返す。置き換えられた古いversionはIntent Briefから落ちるが、削除も上書きもしない。`stale`は、そのSynthesisが引用する`findingIds`のいずれかで`research_finding.expires_at`が現在時刻以下なら`true`（Findingの既存の期限切れ表現をそのまま利用し、新しい鮮度フィールドは足さない）。
- `research.conflicts`: `research_finding_conflict`から、`research.syntheses`の`findingIds`に含まれるFindingが当事者になっている行をそのまま返す（宣言した側・宣言された側のどちらでも拾う。`finding_id`は競合を宣言した側、`conflicting_finding_id`は宣言された側という保存時の方向を`findingId` / `conflictsWithFindingId`としてそのまま返し、向きの入れ替えはしない）。`research_finding_conflict`は新しいFindingが既存Findingを指す非対称な保存形式のため、宣言する側だけで絞ると「最新Synthesisが引用済みのFindingに対して、まだ引用されていない新しいFindingが競合を宣言した」場合に競合が黙って消える。平均化・多数決・黙った除外はしない。
- Evidence全文・Result本文（`summary` / `unknowns` / `options` / `risks`の生ログ）は`research`へ埋め込まない。Synthesisの`conclusion` / `risks` / `options` / `unknowns`は圧縮結果そのものなので含める。

### 初期選択と理由

- **最新versionの判定範囲をIntent配下のRequestに限定した**: `supersedesId`はProject全体のSynthesis IDを指せる（Task 23の設計）が、Intent Briefでの「最新」はこのIntentに属するRequestの集合内だけで計算する。既存設計・Task 23の実装との整合を保ちつつ最も単純な絞り込みであり、Project全体を跨いだ連鎖解決は将来Intentを跨いだ再利用が要件化した時点で拡張する。
- **cancelledのRequestは`requests`に残し`syntheses`から外した**: 取消は「この調査を判断根拠にしない」という意思表示であり、Outcomeの取消と同様に来歴（何を試して取り消したか）は見せつつ、圧縮結果の根拠には使わない。
- **ID指定の詳細Queryは既存の`GetResearchRequestUseCase`を再利用した**: 新しいUse Case・Repositoryメソッドを増やさず、MCP tool `get_research_request`から`asStrategist`で認可した上で委譲する。Researcher・永続化層の既存実装（Task 23〜25）には触れていない。
- **staleはFindingの`expiresAt`だけを根拠にした**: Synthesis自体に新しい鮮度フィールドを追加せず、既存のFinding期限切れの仕組みをIntent Briefでも再利用する小さな選択。Synthesis単位の有効期限が必要になった場合は別途設計する。

### 検証結果

- `npm test`: 追加した`test/intentBrief.test.ts`（cancelled除外、supersedesIdでの最新version判定、Finding競合、staleフラグ、Project scope）と、`test/strategistMcp.test.ts` / `test/projectArchive.test.ts` / `test/intentAdapters.test.ts`の更新分を含めて全件成功。
- `npm run typecheck` / `npm run lint`（`tsc` 2本）/ `npm run build`: 成功。
- 未実施: ブラウザでのWeb UI確認（Task 26はUI変更なし。Human向けResearch画面はTask 29）。実Runtime・実Wachaとの接続はまだ無く、検証は`createApplicationServices` / in-process MCP呼び出しに限る。

## 実装記録: Direction DecisionとOutcomeの根拠参照（Task 27）

Compassを正本とするDirection Decisionと、Strategistの判断を記録する2つのMCP toolを実装した。ADR CandidateのRepository参照・Wacha引き渡し契約（Task 28）と、Human向けのRequest/Decision画面（Task 29）はこのTaskに含めない。

### 入口とtype

- `create_direction_decision`: `next_outcome`以外の5種（`additional_research` / `intent_complete` / `intent_abandon` / `policy_proposal` / `adr_candidate`）を記録する。判断（`judgment`）・理由（`reason`）・選択肢（`options`）・使用した`usedSyntheses`（Synthesis id + version）・`usedFindingIds`を保存する。`additional_research`以外は他のEntityを作らない（`additional_research`はTask 32で追加Research Requestも作る）。
- `decide_next_outcome`: `next_outcome`のDecisionとOutcome（固定のSuccess Criteria含む）を1 transactionで保存する（部分保存を許さない）。Outcome入力は既存の`createOutcomeSchema`をそのまま使い、`create_outcome`の固定Success Criteriaの規則を重複させない。
- 既存の`create_outcome`はそのまま維持し、Decisionを経由しないOutcome作成に使える。そのOutcomeの`originDecisionId`は`null`のままで、既存の呼び出し・テストは変更なしで動く。

### 判断時点のsnapshotと根拠の来歴

- `intentBriefSnapshot`は、use caseが`ResearchRepository.findIntentResearchSummary`をDecision保存の直前に読み、そのままDecisionへJSONで保存する。**snapshotの読取とDecisionの書込は別transaction**にした（`DirectionDecisionRepository`はResearch集約に依存させず、cross-aggregateな結合を避ける小さな選択）。Researcherが同時にResult/Synthesisを登録するごく短い競合はあり得るが、これは初期実装の対象外とし、必要になれば`findIntentResearchSummary`をtransaction越しに呼べるよう拡張する。
- `usedSyntheses`は`{synthesisId, version}`で、保存時に同じProjectに存在し**指定versionが現在versionと一致すること**を検証する（不一致は`synthesis_version_mismatch`→`CONFLICT`）。supersedeされた古いversionをそのまま参照させない。`usedFindingIds`は存在確認だけを行う（Findingはversionを持たない）。

### next_outcomeの原子性とOutcome↔Decisionの相互参照

- `direction_decision.outcome_id`は`outcome.id`への外部キーで、`outcome.origin_decision_id`は逆方向の参照だが、双方向のFKは循環参照になるため**outcome側は意図的にFK制約を付けない**（`initializeSchema.ts`の`addOutcomeOriginDecisionColumn`）。保存順は「Outcomeを先に作る→Outcomeの`id`を指すDecisionを作る」の1方向で、`origin_decision_id`はDecision作成前に確定させたIDをそのまま書き込む。
- Outcome行の構築（`insertOutcomeRow` / `loadOutcomes`）は`SQLiteOutcomeRepository`と`SQLiteDirectionDecisionRepository`の両方から使う共有ヘルパー（`infrastructure/repository/outcomeRecord.ts`）へ切り出した。重複実装を避け、Success Criteriaの検証・保存規則を1箇所にする。

### 冪等性

- 既存のResearch集約と同じ設計（`requestKey` + `input_hash`のunique index）を踏襲する。`decideNextOutcome`は`outcome`フィールドを含む入力全体をhashするため、同じrequestKeyでOutcome内容が異なる再送は`CONFLICT`で拒否し、部分的な重複も作らない。

### Role境界

- 両toolとも`asStrategistWithPrincipal`（Bearerからprincipalを解決しつつStrategist Grantを検査）でのみ呼べる。ResearcherはStrategist用のtoolを一切持たず、Grantを持っていても`FORBIDDEN`になる。Evaluator・Wacha Roleは`ProjectRole`に存在しないため、これらのRoleでのDecision確定は構造上不可能。
- `policy_proposal`は判断を記録するだけで、`update_project`を呼ばない。Mission / Vision / Principles / Constraintsの変更は、Human主導の別経路（Web UIの`update_project`）を要する。

### 検証結果

- `npm test`: 新規`test/directionDecision.test.ts`（冪等性・requestKey競合・存在しないSynthesis/Finding・version不一致・放棄済みIntent・policy_proposalの無変更・next_outcomeの原子性と`originDecisionId`・Role境界）を含め、既存の`researcherMcp.test.ts` / `strategistMcp.test.ts` / `outcome.test.ts` / `intentAdapters.test.ts` / `projectArchive.test.ts`のtool一覧更新分を含めて全件成功。
- `npm run typecheck` / `npm run lint`（`tsc` 2本）/ `npm run build`: 成功。
- ドキュメント: README・`agent/strategist.md`（Direction Decisionの使い分け、Allowed、判断権限）を更新。`agent/strategist.md`の契約テスト（`test/instruction.test.ts`）が、backtickで囲んだtype値をtool名と誤認しないよう表記を調整した。
- 未実施: ブラウザでのWeb UI確認（Task 27はUI変更なし。Human向けDecision画面はTask 29）。実Runtime・実Wachaとの接続は無く、検証は`createApplicationServices` / in-process MCP呼び出しに限る。

## 実装記録: ADR Candidate・Repository参照・Wacha引き渡し契約（Task 28）

`adr_candidate` Direction Decisionから、既存Wacha Manager / Worker / Reviewerへ渡す依頼と、その完了結果（Repository参照）を扱う3つのMCP toolを実装した。実Wachaとは未接続で、どちらもGitHub API等の外部呼び出しは行わない、fixtureの契約検証である。

### 入口と契約

- `create_adr_handoff_request`: `decisionId`（`adr_candidate`のDecision）と`repositoryId`（Projectに登録済みのRepository）から、依頼payloadを組み立てて保存する。payloadは`decisionId` / `intentId` / `usedSyntheses`（id+version）/ `usedFindingIds` / 対象Repositoryの`repositoryId` / `repositoryName` / `repositoryUrl` / Projectの現在の`constraints` / `expectedAdrContent`を持つ
- `record_adr_reference`: Wachaが完了させた結果（対象Repository内の相対`path`、完全な40桁の`commitSha`、任意の`pullRequestUrl`）を取り込み、Project scopeの参照として保存する
- `list_adr_references`: Project配下のADR参照を新しい順に返す（Human向け画面はTask 29）

両toolとも`asStrategistWithPrincipal`でStrategist Grantを検査し、`requestKey`で再送を冪等にする（同じkeyで異なる内容の再送は`CONFLICT`）。`correlationId`は依頼と完了結果を1つの往復として結び付けるidで、`record_adr_reference`は同じ`decisionId` / `repositoryId` / `correlationId`の`create_adr_handoff_request`が先に存在しない場合は`CONFLICT`で拒否する（依頼を経ていない参照や、無関係なcorrelationIdの取り違えを受け付けない）。

### 初期選択と理由

- **`expectedAdrContent`は呼び出し側の自由記述を受け付けず、Decisionの`judgment` / `reason` / `options`から決定的に組み立てる**: 「Direction方針はCompassで確定し、Wachaは方針を自己決定しない」という制約を、入力を狭めることで構造的に保証する。新しい方針を依頼時点で書き足せる余地を作らない
- **`repositoryId`はRepository本文を複製せず、Projectに登録済みの`project_repository_link.id`を指す**: `path`はそのRepository内の相対pathとして検証し、Compass serverのローカルfilesystem pathとして扱わない。絶対path（先頭の`/`、`\`、Windowsドライブレター）と`..`セグメント（path traversal）を`shared/adrHandoffSchema.ts`のzod refineで拒否する
- **`commitSha`は40桁16進数の完全なSHA-1だけを受け付け、短縮SHAを拒否する**: 対象Repositoryを一意に特定できる形だけを参照として保存するための小さな初期選択。Git以外のVCSやSHA-256オブジェクト形式への対応が必要になった時点で拡張する
- **`adr_handoff_request.repository_id` / `adr_reference.repository_id`にFKは付けるが、`onDelete("cascade")`は意図的に付けない**: ProjectのRepositoryは`update_project`の同期処理で削除され得るが、依頼・参照は監査記録として残すべきため、削除しようとした場合はFK制約でrestrictされることを選んだ（Repositoryの削除・強制解除はこのTaskの対象外）。`decision_id`はdirection_decisionに削除操作が無いため、cascadeの有無は実質的に意味を持たない
  - **Reviewとの往復で修正**: 上記のrestrict自体はTask 28完了時点の初期選択どおりだが、初回実装では`SQLiteProjectRepository.syncRepositories`がFK制約違反を未捕捉のままSQLiteの生例外として投げ、`update_project`（Repository配列を含む他フィールドの変更も同一transaction）全体が`500 INTERNAL_ERROR`になり、name等の無関係な変更も巻き込まれて失われる回帰があった。`update()`は他の書込より前に`findRepositoryRemovalConflict`でADR参照済みRepositoryの削除を検査し、該当すれば書込ゼロのまま`repository_referenced`を返す（`UpdateProjectResult`に追加）。`UpdateProjectUseCase`はこれを`ConflictError`（`409 CONFLICT`）に変換する。`test/adrHandoff.test.ts`にHTTP経由の回帰テストを追加した
- **`list_adr_references`はStrategist Grantを要求しない**: `get_project`のRepository一覧・`list_outcomes`と同じ読み取り専用の公開範囲にそろえた。ADR参照はRepository構成と同程度の情報で、Project個別の機密を含まない

### 検証結果

- `npm test`: 新規`test/adrHandoff.test.ts`（payload生成・冪等性・requestKey競合・存在しないDecision / adr_candidateでないDecision / 未登録Repository・依頼未経由の参照拒否・correlationId不一致・絶対path / path traversal / 短縮SHA / 不正URLのVALIDATION_ERROR・Role境界・ADR参照済みRepositoryを外そうとする`update_project`がCONFLICTになり他フィールドも巻き込まれて失わない回帰テスト）を含め、既存の`projectArchive.test.ts` / `intentAdapters.test.ts`のtool一覧更新分を含めて全192件成功
- `npm run typecheck` / `npm run lint`（`tsc` 2本）/ `npm run build`: 成功
- ドキュメント: README・`agent/strategist.md`（ADR Candidateの引き渡しと参照、Allowed）を更新
- 未実施: ブラウザでのWeb UI確認（Task 28はUI変更なし。Human向けADR参照画面はTask 29）。実Runtime・実Wachaとの接続・GitHub API呼び出しは無く、検証は`createApplicationServices` / in-process MCP呼び出しに限る。Lv6達成とは報告しない

## 段階的な実装

1. Research Request / ResultとProject・Intentの関連、状態遷移、冪等性を実装する（domain・永続化・application層はTask 23で実装済み。入口は未接続）
2. Researcher Role、Instruction、Grant、Context、Result登録を実装する（Task 24で実装済み。Human向けGrant画面はTask 29で実装済み）
3. Active Intent作成時のInitial RequestとRuntime向け確定イベントを実装する（Task 25で実装済み。取得・ack入口はTask 31で実装済み。Runtimeによる起動は未接続）
4. Finding / Synthesisのversion・来歴とIntent Briefを実装し、Strategist Contextへ接続する（Task 26で実装済み）
5. Direction DecisionとOutcomeの根拠参照を実装する（Task 27で実装済み）
6. ADR CandidateとRepository ADR参照、WachaへのTask引き渡し契約を実装する（Task 28で実装済み）
7. Human向けProject Research / Decision画面と、Human介入なしの境界テストを実装する（Task 29で実装済み）

実Wacha・外部Runtimeとの接続前はfixtureによる契約検証までとし、Lv6達成とは報告しない。

## 実装記録: Human向けResearch / Decision / ADR参照画面とHuman介入なし境界の自動検証（Task 29）

Web UIとWeb APIに読み取り専用の入口を追加し、Researcher Role Grant管理をStrategistと同じ画面パターンへ統合した。あわせて、
空DBからIntent作成 → Initial Research Request → Researcher（Result・Synthesis・確定）→ Strategist（Intent Brief・
Direction Decision・Outcome・ADR handoff/参照）→ Web API参照までを、実HTTPサーバーとMCP SDK clientで通す自動検証を追加した。

### 追加した入口

- Web API（Role Grant不要。Humanの読み取りはWeb UIの正規入口を経由し、Agentと同じ認可を課さない）:
  `GET /api/projects/:projectId/research-requests`（`originIntentId` / `status` で絞り込み）、
  `GET /api/projects/:projectId/research-requests/:requestId`（Result → Finding / Evidence、Synthesisの来歴）、
  `GET /api/projects/:projectId/intents/:intentId/decisions`、`GET /api/projects/:projectId/adr-references`。
  いずれも既存のMCP向けuse case（`ListResearchRequestsUseCase` / `GetResearchRequestUseCase` / `ListAdrReferencesUseCase`）
  と、新規の`ListDirectionDecisionsUseCase`（`DirectionDecisionRepository.findByIntent`を`ListOutcomesUseCase`と同じ形で公開する
  だけの読み取り専用Query）にそのまま委譲し、業務規則を入口ごとに重複させない。
- Web UI: Project詳細に Research section（Request一覧 → 個別画面でResult/Finding/Evidence/Synthesisの来歴）、ADR参照
  section、Researcher Grant section（既存の`GrantSection`を`role`パラメータで汎用化し、Strategistと同じ構造をそのまま流用）
  を追加した。Intent詳細に Direction Decision section（type・judgment・reason・options・関連Outcomeへのリンク）を追加した。

### 初期選択と理由

- **Grant Sectionはrole引数で汎用化し、新しいComponentを増やさなかった**: StrategistとResearcherはGrantの構造（発行・
  一覧・取消、Web API/CLIとの併用）が完全に同じで、違いは表示名と取消時の影響説明だけだった。`grants.ts`の`GrantRole`型と
  `grantRoleLabels`を追加し、`GrantSection` / `GrantRow`をrole引数で切り替える方が、別Componentを複製するより重複が少ない。
- **Web APIの読み取りはRole Grantを要求しない**: 既存の`list_adr_references` MCP toolが既にStrategist Grant無しで公開さ
  れている（Task 28）のと同じ扱いで、ResearchやDecisionの一覧・詳細もRepository構成や既存Outcome一覧と同程度の情報であり、
  Project個別の機密を含まない。Humanの製品操作はWeb UIを正規入口とする方針（AGENTS.md）どおり、Human向けの読み取りに
  Agent向けのRole認可を重ねない。
- **Direction Decisionの一覧はIntent単位にした**: `DirectionDecisionRepository.findByIntent`が既に実装済み（Task 27の
  `next_outcome`原子性のために用意されていたが、どのuse caseからも呼ばれていなかった）で、Outcome一覧と同じ「Intent配下」
  という単位がHumanの閲覧導線（Intent詳細画面）と自然に一致するため、Project全体を横断する一覧は追加しなかった。
- **Research Requestの一覧はProject単位にした**: `ListResearchRequestsUseCase`は元々Researcher向けにProject scopeで
  実装済みで、Human向けにも同じuse caseをそのまま使う。Project詳細に置き、Intent起点かProject Watchかは一覧のkindバッジ
  で区別する。

### 自動検証（`test/researchDecisionIntegration.test.ts`）

`test/strategistIntegration.test.ts`と同じ形（実HTTPサーバー・MCP SDK client、loopback listenが拒否される環境では理由付き
skip）で、2本のtestを追加した。

- 1本目: 空DBから、Web APIでProject（Repository登録込み）とIntentを作成 → Initial Research Requestの自動作成をWeb APIで
  確認 → Researcher（`get_researcher_context` → `register_research_result` → `register_research_synthesis` →
  `complete_research_request`で`completed`に確定、途中でResearcherが`create_outcome`を拒否されることを確認）→
  Strategist（`get_strategist_context`でIntent Briefの`syntheses`にFinding/Synthesisが載ることを確認し、途中で
  Strategistが`register_research_result`を拒否されることを確認 → `decide_next_outcome`でOutcome+Decisionを原子的に作成
  → `create_direction_decision`で`adr_candidate`を記録 → `create_adr_handoff_request` → `record_adr_reference`でWacha
  完了結果のfixtureを記録）→ Web API（Research Request詳細、Intentの`decisions`一覧、`adr-references`一覧、Outcome詳細）
  から一貫した内容を参照できることを確認する。
- 2本目: 同じProject内でIntentを作り直しながら（`abandon_intent`後に次のIntentを作成し、Initial Research Requestを1件
  ずつ得る）、`completed`（Result・Synthesis経由）・`not_needed`（Resultなし、stopReasonあり）・`insufficient`
  （Resultなし、stopReasonあり）・未確定（`requested`のまま）の4状態が、Web APIから区別して参照できることを確認する。
  あわせて、別ProjectのResearcher Grantでは`get_researcher_context` / `list_research_requests`が`FORBIDDEN`になること、
  Web API読み取りはAuthorizationヘッダーなしでも200で応答すること（Humanの読み取りにRole Grantを要求しない）を確認する。

Task本文にある「証拠不足・予算停止・通信結果不明」は、Compassの状態モデルでは新しい状態を追加せず、既存の4終了状態
（`completed` / `insufficient` / `not_needed` / `cancelled`）とその`stopReason`、および未終了（`requested` /
`running`）の組み合わせで表す。「証拠不足」「予算停止」はどちらも`insufficient`＋`stopReason`（理由の文言で区別する）
であり、「通信結果不明」はRuntimeがまだResearcherの応答を確定できていない状態で、CompassはRequestを`requested` /
`running`のまま保持するだけで、Runtimeが最終的にどう終了させるかを先取りしない。既存のTask 23実装（状態遷移・
`stopReason`の必須化）に新しい概念を追加しない、小さく単純な選択とした。

### 未実施・未接続

- ブラウザでの実UI確認は行っていない（Runtime実行環境の制約でブラウザツールを起動していない）。Web APIの応答は実HTTP
  サーバーに対するcurlと、上記の自動検証（実HTTPサーバー・MCP SDK client）で確認した。画面のComponentは既存の
  `GrantSection` / `IntentSection` / `OutcomeSection`と同じデータ取得・表示パターンをそのまま踏襲している。
- 外部RuntimeによるResearcher/Strategistの自動起動、実Wacha・GitHub APIとの接続は引き続き未接続。本Taskの自動検証は
  fixture契約の確認であり、Lv6の自律運転実証ではない。
- `additional_research`型のDirection Decisionから新しいResearch Requestを作る確定経路はTask 32で実装済み
  （「実装記録: 追加Research判断のRequest・Runtimeイベント接続（Task 32）」）。`CreateResearchRequestUseCase`自体は
  MCP/Web APIへ公開していない。

## 実装記録: Runtime eventのcursor・ack公開（Task 31）

`runtime_event`を外部Runtimeが取得し、処理結果を記録できる入口を、Web APIとMCPに同じapplication層（`FetchRuntimeEventsUseCase`・`AckRuntimeEventUseCase`）への委譲として実装した。Agentの起動・polling間隔・backoff・retry上限はCompassに置かない（Runtimeの責務）。

- **consumer**: BearerのPrincipal。入力では受け取らない。consumerごとにackが独立し、複数consumerが同じイベントをそれぞれ処理できる。
- **認可（初期選択）**: 暫定の`runtime` Role Grant（`ProjectRole.RUNTIME`）をProject単位で検査する。既存のGrant発行・取消・即時反映・別Project分離をそのまま使えるため。Task 37でRuntime Credentialの`runtime:event:read` / `ack` scopeへ置き換える。`get_role_instructions`のenumに入るため`agent/runtime.md`を追加した。Human向けのWeb UI発行画面は、Task 35の差し戻し対応でProject詳細のGrant画面にRuntime sectionとして追加した（Task 37でCredential管理画面へ置き換える予定）。
- **取得**: `fetch_runtime_events` / `GET /api/projects/:projectId/runtime-events?afterCursor&limit`。読取専用で、ackが無いイベントと`retryable_failure`のイベントをcursor昇順で返し、`nextCursor`（同じ周回のページ送り用）と`resumeCursor`（再起動後の再開用。差し戻し対応で追加）を添える。取得しても状態を変えないため、応答が失われても同じイベントを再取得でき、欠落しない。配送はat-least-onceで、重複起動の防止はイベント`id`とackの確定状態で行う。visibility timeout（lease）は持たない。同じconsumerを複数プロセスで共有して並列に取得する構成は対象外（初期選択。必要になればleaseを追加する）。
- **ack**: `ack_runtime_event` / `POST /api/projects/:projectId/runtime-events/:eventId/ack`（`outcome`: `processed` / `retryable_failure` / `terminal_failure`）。失敗は`reason`必須、`processed`は`reason`を受け付けない。`processed` / `terminal_failure`は確定で、以後そのconsumerへ返さず、同じ結果の再送は冪等（`recorded: false`）、異なる結果は`CONFLICT`。`retryable_failure`は返り続け、`retryCount`と`lastFailureReason`を付ける（回数の上限は設けず、Runtimeが決めて`terminal_failure`にする）。別Projectのイベントは`NOT_FOUND`。archivedのProjectでもackは記録できる（Runtimeの取りこぼしを残さないため。Directionの状態は変えない）。
- **差し戻し対応（ack冪等性・cursor）**: `docs/lv6-unification-design.md`の決定に従い、ack入力に必須の`attemptId`を追加した。`(consumer, event, attemptId)`ごとの試行記録（`runtime_event_ack_attempt`、入力と初回結果を保持）により、同じ試行の再送は初回結果を返して`retryCount`を増やさず、同じ`attemptId`で別の結果・理由は`CONFLICT`。取得応答へ`resumeCursor`（そのconsumerについて、それ以下がすべて確定済みの最大cursor）を追加し、`nextCursor`は永続化しないページ送り用と明記した。`resumeCursor`はProject最新cursorを先に読み、その範囲の最古の未確定イベントの手前とするため、読取中の追記で未確定イベントを追い越さない。
- **永続化**: 新規table `runtime_event_delivery`（主キー`(consumer_id, event_sequence)`、`outcome`、`retry_count`、`last_failure_reason`、`created_at`、`updated_at`）。`runtime_event`は追記のみのまま変更しない。schema初期化は`create table if not exists`で既存DBへ再適用でき、既存tableには触れない。再起動後もackと未処理の状態が残る。
- **Strategist起動に必要な項目**: `research_completed`は`projectId`・`intentId`・`researchRequestId`・`correlationId`・`version`・`conclusion`を持つ（既存項目。`researchRequestId`がRequest IDである）。
- **未接続・未検証**: 実Runtimeによる取得・Agent起動は未接続。検証は`test/runtimeEvents.test.ts`のWeb API / MCP in-process呼び出しと、ファイルDBでのserver再起動再現で、Lv6の実証ではない。`outcome_confirmed`イベント（Task 33で実装。`docs/lv6-unification-design.md`の「実装記録（Task 33）」）を除き、remote向け認証（Task 37）は未実装。

## 実装記録: 追加Research判断のRequest・Runtimeイベント接続（Task 32）

Strategistの`additional_research` Direction Decisionから、追加Research Requestと`research_requested`イベントを作る確定経路を実装した。入口は既存のMCP tool `create_direction_decision`で、新しいtool・Web API・DB tableは追加していない。

- **決定主体と入力規則**: `research`（`question` / `scope` / `completionCondition` / `budgetTotal` / `deadlineAt`）は**Strategistが決め**、`additional_research`では必須、他のtypeでは`VALIDATION_ERROR`。項目の規則はInitial Requestや`CreateResearchRequestInput`と同じ`researchPlanShape`（`shared/researchSchema.ts`）を共有する（予算は1〜10000の整数で単位はRuntimeが定める）。ResearcherやRuntimeはQuestion・Outcome・Directionを決める権限を持たない（`create_direction_decision`はstrategist Grantが必要）。
- **原子性**: `SQLiteDirectionDecisionRepository.create`が、Decision行・Request行・`research_requested`イベントを1 transactionで保存する。Request・イベントは既存の`insertResearchRequest`を使うため、Requestがあってイベントが無い状態は作れない。いずれかのtableへの挿入に失敗すると3つとも残らず、復旧後に同じ`requestKey`を再送すれば1件ずつ作られる（`test/additionalResearch.test.ts`が3 tableへ失敗を注入して確認）。
- **相関ID・冪等性**: Requestの`correlationId`は`decision:{decisionId}`、`requestKey`は`additional-research:{decisionId}`（`domain/model/AdditionalResearchRequest.ts`）。相関IDは`research_requested` / `research_completed`イベントへ引き継がれ、Decision・Request・イベントを結ぶ。同じDecisionの`requestKey`再送は既存のDecisionと、`requestKey`（既存のunique index）で引いたRequestを返し、重複しない。`research`を含む入力全体をhashするため、異なる計画で同じ`requestKey`を使うと`CONFLICT`。
- **拒否**: archived Project（`CONFLICT` / `projectStatus`）、Activeでない・存在しない・別ProjectのIntent、別Projectの`usedSyntheses` / `usedFindingIds`、過去の`deadlineAt`（`VALIDATION_ERROR`、`research.deadlineAt`）、不正な予算・空の項目をapplication層で拒否し、Decision・Request・イベントのいずれも作らない。過去期限の検査は再送の判定より後に置き、期限後の同じ入力の再送は作成済みの結果を返す。
- **取得**: RuntimeはTask 31の`fetch_runtime_events`（Web APIも同じ）から、`type: "research_requested"`・`researchRequestId`・`correlationId`付きの新しいイベントを取得できる。
- **初期選択（理由）**: Decision↔Requestの逆参照列（`origin_decision_id`）は追加せず、DBスキーマを変更しない。既存の`request_key`のunique indexと決定的な`correlationId`で、再送・遡りに足りるため。Decision作成時刻と期限判定は注入された`clock`を使う（Researchと同じ時刻源）。
- **互換性**: `additional_research`で`research`を省いた従来の呼び出しは`VALIDATION_ERROR`になる（Requestを伴わない`additional_research`を残さないため）。応答は`{ decision, researchRequest }`になり、他のtypeでは`researchRequest`が`null`。
- **未接続・未検証**: RuntimeによるResearcher起動は未接続（`outcome_confirmed`イベントはTask 33で実装済み）。検証は`test/additionalResearch.test.ts`のin-processのMCP / Web API呼び出しで、Lv6の実証ではない。
