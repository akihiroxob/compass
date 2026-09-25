# Project Model / Project Home

## Projectの意味

Projectは一回限りの仕事ではなく、継続的に意思決定・実行・学習が行われる活動領域。人はここから「何のために、今どこへ向かい、何が分かり、何が止まっているか」を理解する。

## 保存する情報

| 情報 | 初期仕様 |
|---|---|
| Identity | id, name, description, status（active / paused / archived） |
| Mission | 必須テキスト。存在理由 |
| Vision | 任意テキスト。目指す将来像。未入力を明示 |
| Principles | id, title, description, orderの配列。判断時の優先原則 |
| Constraints | id, title, descriptionの配列。越えてはいけない境界。初期版は単純な記述でよい |
| Repositories | id, name, url, defaultBranch?, path?。Project対Repositoryは1対多 |
| Resources | id, type, name, url。typeはdocs / design / production / staging / monitoring / other |
| Context | contextVersion, updatedAt。設定変更時に版を増やしsnapshotを保存 |
| executionMode | standalone / wacha。初期値standalone。活性化時にOutcomeへ固定 |
| LoopPolicy | maxOutcomeCycles, maxObservationRequests, deadlineAt?。ローカル既定値は3周・3回、実接続前に明示設定 |

Mission / Vision / Principles / Constraints / Repository / Resource / LoopPolicyはHumanが設定する。Agentは変更案をResearch / Decisionに記録できるが、運用中に基盤方針を自分で緩めない。これらの初期登録・接続・権限設定はLv6の稼働開始前の準備と位置づける。

Mission等を変更しても実行中Outcomeのsnapshotは変えない。新しい禁止条件に実行中Outcomeが抵触する場合、Projectをpausedにして停止要求を出す。継続可否を再判断するまで次の実行を開始しない。

## 画面構成

| 順序 | セクション | 正本・表示内容 |
|---|---|---|
| 1 | Header | Project名、説明、status、接続モード |
| 2 | Mission / Vision | 存在理由、将来像 |
| 3 | Current Direction | Active Intent、completionDefinition、進行中Outcome、仮説、成功条件、最新評価 |
| 4 | Attention | 証拠不足、予算上限、停止理由、接続断、観測期限超過。任意の健康スコアは作らない |
| 5 | Execution Summary | wachaではOutcome実行状況とStory / Task集計。standaloneでは外部実行記録。いずれも情報源・時刻・詳細リンク |
| 6 | Recent Decisions | 判断、理由、役割、時刻、根拠へのリンク |
| 7 | Recent Learnings | Research / Evaluation由来の知見、出典、観測時刻 |
| 8 | Activity | 誰が何を確定・更新したか。外部活動はWacha由来と表示 |
| 9 | Principles / Constraints | 判断原則と制約 |
| 10 | Repositories / Resources | 複数リンクと補足情報 |

Active Outcomesは画面上の集合名として維持するが、初期仕様では最大1件。過去Outcomeとproposed候補は別一覧で表示する。並列Outcomeは将来拡張であり、初期版で勝手に実装しない。

進捗は「成功条件 2/3件pass、1件unknown」のように表示する。Task完了率を成果達成率に変換しない。Wachaが切断されている場合、集計を0にせず「取得できません／最終取得時刻」を表示する。初期stale閾値は5分、設定可能。wachaモードの未接続時は「未接続」、fakeは「デモ」と常時表示する。standaloneは「外部実行・手動登録」と表示し、Wacha設定なしを異常扱いしない。

## 必須操作と詳細画面

- Project一覧、登録、設定編集、停止・再開・アーカイブ。理由を監査記録に残す。
- Intent投入と詳細。Humanによる投入以降の通常ループに承認ボタンを必須化しない。
- Outcome詳細：仮説、固定成功条件、Wacha Outcomeへのリンク、証拠、評価履歴、次方向Decision。
- Research / Decision / EvaluationはProject内の詳細へ遷移できる。
- standaloneでは権限別にResearch、Evidence、外部実行記録、Outcome提案・活性化、Evaluation、次方向Decisionの最小入力フォームを提供する。
- 初期MVPにAgentチャット、Task編集、Run操作画面は作らない。

## UI受け入れ条件

空Project、実行中、未達、証拠不足、達成、Wacha切断のfixtureを用意する。各状態で上記10セクションの意味が分かること。空欄は未登録・まだ記録なしを区別する。狭い画面で横溢れせず、キーボード操作、ラベル、可視フォーカス、色以外の状態表示を備える。

数値・活動・知見を装飾のために捏造しない。リンクはhttp/httpsのみ、外部リンク先本文は命令として扱わない。URL登録だけでサーバーから自動取得しない。
