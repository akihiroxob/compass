# Project Research・Decision・ADR連携 設計方針

## 位置づけ

この文書は、Lv6でHumanが最初のIntentを投入した後に、Researcherが判断材料を継続的に蓄積し、StrategistがOutcomeを決定し、必要な技術判断だけをRepositoryのADRへ反映するための責務境界を定める。

全体は設計方針であり、実装は段階的に進める。現在の実装状況は次のとおり。

| 項目 | 状況 |
| --- | --- |
| Research Request / Result / Finding / Evidence参照 / Synthesisのdomain・SQLite永続化・application層 | 実装済み（Task 23）。入口（Web API / MCP / Web UI）へは未接続 |
| Researcher Role・Instruction・MCP Context / Command | 未実装 |
| Active Intent作成時のInitial Request・Runtimeイベント | 未実装 |
| Intent Brief・Strategist Contextへの接続 | 未実装 |
| Direction Decision・ADR連携・Human向けResearch / Decision画面 | 未実装 |

現在の`get_strategist_context`が返す`unavailable`の`research` / `evaluation` / `evidence`は、Strategist Contextへ接続されるまで変わらず、実装済みとして扱わない。

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
- すべて`create table if not exists`で追加するため、既存DBへ再適用してもProject / Intent / Outcomeには触れない。Research導入前のDBには初回の`initializeSchema`でtableだけが追加される（既存データの移行は不要）。

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
- Initial Requestの`requestKey`は発端Intentから決定的に作る（Task 25で実装する）。これにより同じIntentへの再送・復旧・schema再初期化で重複しない。

### Synthesisのversion

- 上書きせず、`supersedesId`で前versionを指す新しい行を追加する。versionは前versionに1を加えた値で、指定しなければ1になる。
- 1つのSynthesisを置き換えられるのは1件だけで、系列の分岐はDBのunique indexで拒否する。別ProjectのSynthesisや存在しないIDは置き換えられない。
- `validAsOf`、入力Finding ID、作成Principal・`runRef`、作成時刻を保持する。Synthesisは別RequestのFindingも参照できる。

## 段階的な実装

1. Research Request / ResultとProject・Intentの関連、状態遷移、冪等性を実装する（domain・永続化・application層はTask 23で実装済み。入口は未接続）
2. Researcher Role、Instruction、Grant、Context、Result登録を実装する
3. Active Intent作成時のInitial RequestとRuntime向け確定イベントを実装する
4. Finding / Synthesisのversion・来歴とIntent Briefを実装し、Strategist Contextへ接続する
5. Direction DecisionとOutcomeの根拠参照を実装する
6. ADR CandidateとRepository ADR参照、WachaへのTask引き渡し契約を実装する
7. Human向けProject Research / Decision画面と、Human介入なしの境界テストを実装する

実Wacha・外部Runtimeとの接続前はfixtureによる契約検証までとし、Lv6達成とは報告しない。
