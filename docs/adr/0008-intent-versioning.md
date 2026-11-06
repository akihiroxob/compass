# ADR 0008: 目標（Intent）の版と変更履歴で根拠を保つ

- 状態: 承認
- 対象: Direction / Orchestrator / Server / Web UI

## 決定

Intentは保存のたびに増える`version`（作成時1）と、実現したい状態・達成条件（意味）が最後に変わった`meaningVersion`を持つ。版ごとの内容・変更主体・理由・意味変更の有無を追記専用の`intent_revision`に残す。Outcomeの意味を理由なしに変えることだけを求め、「Outcomeを持つIntentの意味は変更不可」という全面禁止は置かない。

- 更新（Web API `PATCH`・MCP `update_intent`）は編集の元にした`expectedVersion`を必須とする。現在版と異なる場合は何も変えず`CONFLICT`（`conflict: intent_version`・`currentVersion`）を返し、利用者・Agentは現在の内容を読み直して確認してから再実行する。古い画面・古い判断を現在版として保存しない。内容が変わらない保存は版を進めない。
- Outcomeを持つIntentの`desiredState` / `completionDefinition`を変えるときは`reason`を必須にする。変更主体は認可済みの入口が固定した主体（Humanは`human:{id}`・operator、Agentは各Principal・role）で、Agentの操作をHumanとして記録しない。
- Outcome・Direction Decision・Outcome Evaluationは作成時の`intentVersion`を保持し、後から現在版へ書き換えない。内容は`list_intent_revisions`（`GET .../intents/:intentId/revisions`）で元の版を参照できる。判断・Outcome作成は`intentVersion`を必須とし（省略を現在版へ付け替えない）、Outcomeの確認（`update_outcome`）の`intentVersion`は任意で、いずれも指定した版が現在版と異なれば`CONFLICT`にする。履歴の各版はタイトル・実現したい状態・達成条件をWeb UIの変更履歴から読める。
- `meaningVersion`が未完了（active）Outcomeの`intentVersion`より新しい場合、そのOutcomeは再計画対象になる。Orchestration Stateは`activeIntents[].version/meaningVersion`と`outcomes[].intentVersion/intentRevised`を返し、Orchestratorは意味の版ごとの安定key（`:intent_revised:<meaningVersion>`）でStrategistを起動する（判断済みのactive Outcomeも対象で、変更前の起動記録とkeyは衝突しない）。進行中のWorkは止めず、Task・Outcomeの状態を自動では変えない。StrategistはOutcomeを現在版で確認（`update_outcome`の`intentVersion`）、取消、作り直しのいずれかを判断する。
- 目標の終端（放棄・`intent_complete`）はOutcomeを`cancelled`にする（放棄）か変えない（完了）だけで、Outcome・Taskを無断で`achieved` / 完了にしない。放棄も任意の`expectedVersion`で古い画面を検知できる。一覧とOrchestration Stateは終端した目標をActiveに含めない。

## 保存と検証

新規DBのschemaに`intent.version` / `meaning_version`、`intent_revision`、`outcome.intent_version`、`direction_decision.intent_version`、`outcome_evaluation.intent_version`を持つ。旧DBへの列補完・データ移行は行わず、開発DBは再作成する。公開Web API・MCPで、2つのクライアントの競合、変更主体・理由、元の版の保持、再計画対象、終端操作を確認する（`server/tests/intentRevision.test.ts`）。Orchestratorのdispatch規則はadapter検証で、実CLI常駐運転の実証ではない。
