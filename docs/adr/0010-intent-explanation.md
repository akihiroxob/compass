# ADR 0010: Agentの観測の説明を事実・仮説・提案に分けて根拠参照付きで記録する

- 状態: 承認
- 対象: Direction / Server（MCP・Web API・Web UI）/ Role

## 決定

Intent（ビジネス目標）の観測についてのAgentの説明を、Directionが所有する追記専用の`intent_explanation`として保存する。説明は観測項目・分析期間・前回の版・関連Outcomeを持ち、項目を`fact`（事実）・`hypothesis`（原因の仮説）・`proposal`（次の提案）に分ける。根拠は既存の記録（観測値・Research Finding / Synthesis・Outcome Evaluation・Direction Decision）のIDで参照し、本文・値は複製せず読み取り時に原記録から解決する。

事実は根拠を必須とし、仮説は先行する事実・確からしさ・確認方法を必須とし、提案は先行する事実・仮説を指す。観測値・Evaluationを事実の根拠にでき、Synthesis・Decisionは仮説・提案の根拠にする。根拠が訂正・置換・期限切れになっても説明は書き換えず、読み取りで根拠の状態と`basisOutdated`を示す。説明が無い場合や観測が未計測・取得失敗・古い場合は、説明を生成せずその状態を返す。

記録はStrategistのWorkspace Grantで認可し、参照はWorkspaceの参照者とHumanのWorkspace Membershipに公開する。説明の記録はIntent・Outcomeの状態を変えず、Agentの実稼働・施策の効果・目標の達成の証拠にしない。

## 理由

既存のResearch Synthesisは調査依頼に属し、Direction Decisionは判断の記録で、どちらも「観測した変化の事実・原因の仮説・提案」を観測項目・分析期間と結び付けて区別できない。これらを複製・拡張せず、IDで参照する薄い記録にすると、原記録の訂正や期限切れを説明の側から辿れ、二重管理を避けられる。仮説に確認方法を必須とし、因果の断定を表す項目種別を持たないことで、単純な前後差を効果として記録する経路を作らない。観測の説明は高頻度ではなく人が読む解釈のため、意味のある履歴のActivityへは投影しない。

## 保存と検証

新規DBのschemaに4 tableを追加し、旧DBへの移行は行わない。参照先は同じWorkspaceの記録だけを複合FKで参照し、観測値は観測項目への所属、評価・判断・Outcomeは同じIntentであることをRepositoryが書込と同一transactionで検査する。`server/tests/intentExplanation.test.ts`が公開入口で、再送・版・前回の変化、根拠の解決と`revised`・`expired`・`superseded`、種別ごとの必須・禁止規則、別Workspace・Role・未定義の観測項目・archived Workspaceの拒否、説明なし・未計測・取得失敗・古い観測の区別、再起動後の永続化を確認する。
