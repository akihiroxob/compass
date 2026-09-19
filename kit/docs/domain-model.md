# Domain Model

## 共通規則

IDは不透明なUUID文字列、時刻はUTC ISO 8601。変更可能な集約はversion（楽観ロック用整数）、createdAt / updatedAtを持つ。子を含めすべてのレコードにprojectIdを持たせ、参照先が同じProjectであることを検証する。actorは認証済みprincipalId / role / runRef（外部参照、Humanではnull）を記録する。

Projectは活動領域、Missionは存在理由、Visionは将来像、Intentは今実現したい状態、OutcomeはIntentへ近づく観測可能な仮説。Taskや実装手段をIntentにしない。

## 中心概念

| 概念 | 必須情報 | 関係・規則 |
|---|---|---|
| Project | name, description, mission, status, contextVersion | 詳細はproject-model。Missionは独立集約にしない |
| Intent | title, desiredState, completionDefinition, status, createdBy | Projectに属する。最初のHuman入力を保持し、Agentは意味を書き換えない |
| Outcome | intentId, title, desiredState, hypothesis, priority, status, contextVersion, executionMode, originDecisionId | Intentに属する。proposed以外は成功条件を固定。priorOutcomeIdは同じIntent内の任意参照 |
| SuccessCriterion | id, outcomeId, description, kind, measurement, target, observation, evidenceRequirements | Outcome内の値として扱いながら安定IDで保存。評価と外部参照のため独立表を許可 |
| Research | intentId, outcomeId?, question, findings, unknowns, options, risks, evidenceIds, status | statusはdraft / completed。completed後は変更せず、新規Researchで補足 |
| Evidence | intentId, outcomeId?, sourceType, sourceRef, summary, observedAt, collectedAt, provenance, payloadDigest? | 不変。観測範囲、環境、artifact revision、取得者をprovenanceに記録 |
| Decision | intentId?, outcomeId?, type, rationale, alternatives, evidenceIds, researchIds, evaluationIds, actor, contextVersion | 不変。訂正はsupersedesDecisionIdで追記 |
| Evaluation | intentId, outcomeId, criterionResults, verdict, findings, learnings, evaluatedAt, actor | 不変。全Criterionを一度ずつ含め、Evidenceと固定条件を参照 |

配列は空配列を許可するが、Decisionのrationale、Criterionの観測定義は空文字を禁止する。Projectに対する停止等のDecisionのみintentId=nullを許可する。Outcome関連レコードのintentIdはOutcomeの所属と一致させる。初期仕様ではOutcomeの階層化・子Outcomeは作らない。

## SuccessCriterion

- kindはquantitative / qualitative。
- quantitative: measurementにmetric名・unit、targetにoperator（eq / gte / lte）と数値。observationにenvironment、対象revision、window開始/終了または期間、minimumSamplesを記す。
- qualitative: targetに期待状態、measurementにrubricと検証手順、evidenceRequirementsに必要成果物・出典を記す。Agentの「できた」という主張だけではpassにできない。
- Criterionはすべて必須。optional・重み付き達成率は初期には作らない。
- Outcomeのactive移行時に1件以上必要。条件・対象環境・観測方法をsnapshot化し、その後変更禁止。
- 条件変更が必要なら元Outcomeをcancelledにし、Decisionを介して新Outcomeを作る。履歴を書き換えない。

## 状態遷移

### Project

active → paused → active、active / paused → archived。archivedは初期版では復帰不可。削除APIは作らない。

paused / archivedでは新しいIntent活性化・Outcome活性化・ExecutionRequest・次方向確定を拒否する。遅れて到着した実行結果とEvidence、Evaluationは監査のため受け入れる。外部実行の停止完了を意味しない。

### Intent

draft → active → achieved / abandoned。Projectにつきactiveは最大1。draftはHumanが編集可能。active以降の意味変更は禁止し、必要ならabandonedと新Intentで履歴を残す。

completionDefinitionは「何を示せばIntent全体の完了と言えるか」。Human入力からStrategistが解釈・測定方針をDecisionとして補足できるが、目的を縮小しない。不確実ならResearchする。

Intent完了はStrategistのcomplete_intent Decisionと根拠となるEvaluation / Evidenceを必要とする。最後のOutcome成功から自動でIntentを成功にしない。進行中Outcome・未解決ExecutionRequestがある間は完了不可。abandonedはHumanまたは事前方針に基づくStrategistのみ。

### Outcome

| 元 | 先 | 実行者・条件 |
|---|---|---|
| proposed | active | Strategist。active Intent、有効な成功条件、予算と制約、originDecisionが必要 |
| proposed | cancelled | Strategist。理由のDecision |
| active | evaluating | Evaluator。実行結果または独立した観測が到着し、評価を開始 |
| active / evaluating | cancelled | Strategist。根拠Decisionと未完了実行の停止要求を記録 |
| evaluating | achieved | Evaluator。最新Evaluationがachieved |
| evaluating | not_achieved | Evaluator。最新Evaluationがnot_achieved |
| evaluating | evaluating | Evaluator。insufficient_evidenceの評価を追記し再観測待ち |

終端（achieved / not_achieved / cancelled）から戻さない。達成後の回帰は新Outcomeとして扱う。進行中（active / evaluating）はIntentにつき最大1としDBで制約する。proposedは複数可。次のOutcomeはpriorOutcomeIdとoriginDecisionIdで接続し、前Outcomeの終端化後に活性化する。

blockはOutcome statusに増やさず、blockReason / blockedSinceを補助状態に持つ。nextObservationAtは未解決observation_requestsの最小dueAtから投影する。解消は対応するDecisionまたは有効な新Evaluationで記録する。

## Evaluationの集約規則

各criterionResultはcriterionId、result（pass / fail / unknown）、observedValue、evidenceIds、reasonを持つ。quantitativeの値・単位・環境・revision・観測期間・標本数を検証する。欠落・取得不能・適用範囲不一致・矛盾した証拠はunknown。

1. 有効なfailが1つでもあればnot_achieved。
2. failがなくunknownがあればinsufficient_evidence。
3. 全件passの場合だけachieved。

APIクライアント指定verdictは信用せず、サーバーが再計算する。空条件は成功にしない。定性判断はEvaluatorが根拠付きで提出し、サーバーは権限・必須証拠・整合性を検証する。サーバーが自然言語の真偽を保証できるとは扱わない。

Evaluation作成とOutcome更新は同一トランザクション。Evidenceの収集時刻と観測時刻を混同しない。証拠不足の間はExecutionRequestを再送するのでなく、Research・測定追加を要求する。最新EvaluationをUIに表示し、過去分も辿れる。

## LearningとActivity

Learningは第10の中心集約にしない。completed Research.findingsとEvaluation.learningsを出典付きで投影する。Activityは確定Command / 受信イベントの監査投影。Agentの思考全文や架空の活動を表示しない。

## Decisionの種別

propose_outcome / activate_outcome / cancel_outcome / next_outcome / request_research / request_observation / complete_intent / abandon_intent / pause_project / resume_project / archive_project / update_context。

次方向Decisionには根拠Evaluation、比較した選択肢、採用理由、次Outcomeの仮説を記す。ResearchやEvidenceがまだなければ「証拠なしの初期仮説」と明記し、存在しない参照を生成しない。
