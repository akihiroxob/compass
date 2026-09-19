# Codexへの初回実装指示

このリポジトリでcompassを0から実装してください。計画の提示だけで止まらず、READMEとdocsの仕様に従ってP0〜P4のローカルMVPを完成させてください。

compassはDirection Loop管理システムです。WachaはExecution Loop管理システムで、Runtime / Orchestratorは別責務です。過去に存在した「compassをAgent Runtimeとする案」は採用しません。過去資料は参考であり、今回の目的に不要な概念・抽象化・機能は切り捨ててください。

両製品を単体利用可能にしてください。compassはWachaなしで外部実行記録・証拠を登録してDirection Loopを扱え、Wachaはcompassなしでlocal Outcomeから実行できます。単体利用にfakeや開発scriptを必須にせず、Runtimeは外部責務のままにしてください。docs/standalone-and-integration.mdを必ず読んでください。

まずAGENTS.md、README.md、docs/architecture.md、domain-model.md、project-model.md、wacha-boundary.md、autonomy-and-roles.md、api-and-persistence.md、coding-rules.md、acceptance-tests.md、implementation-plan.mdを読んでください。既存コード・規約があれば優先し、空の場合はarchitectureの技術構成で着手してください。

中心概念はProject / Intent / Outcome / SuccessCriterion / Research / Evidence / Decision / Evaluationです。Projectは人が現場を把握する入口としてMission / Vision / Principles / Repositories / Resources / Active Intent / Active Outcomes / Recent Decisions / Learnings / Execution Summary / Activityを表示してください。

次を必ず守ってください。

- Intentは長寿命。毎周作り直さず、EvaluationとDecisionから次Outcomeへつなぐ。
- 実行開始後の成功条件を固定し、Evidenceによって成果を評価する。
- Wachaの実行完了をOutcome達成と扱わない。証拠不足はinsufficient_evidenceとする。
- Wachaにも実行用Outcomeがある前提で連携する。その追加実装はdocs/wacha-implementation-instructions.mdに分離されている。勝手に別リポジトリを改修せず、compass側はfake adapterと契約fixtureで進められるようにする。
- Agent起動・Run・schedulerをcompassに実装しない。外部Role向けCommand / Contextと永続イベントを提供する。
- 通常ループにHuman承認を組み込まない。Lv6は初回Intent以降の介入不要を最終目標とするが、fakeのデモをLv6達成とは報告しない。
- 冪等性、Project scope、同時更新、停止、予算、再起動後の復旧をテストする。

作業前に短い方針を日本語で示し、各段階の受け入れ条件を満たしながら進めてください。曖昧な実装細部は最小の選択を行い、重要な判断だけADRに残してください。APIや接続資格情報が未提供でも、外部依存のない段階を止めないでください。

P0〜P4完了後、P5〜P6に必要な既存接続が揃っていれば続けて検証してください。揃っていなければ不足情報と未接続箇所を具体的に残してください。新規cloneからの起動手順、.env.example、migration、seed、fakeデモ、関連テストを提供し、lint・型チェック・テスト・buildの結果と到達段階を報告してください。
