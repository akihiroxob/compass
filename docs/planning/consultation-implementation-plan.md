# 人への相談・判断待ちの実装計画

人への相談・判断待ちの実装範囲と分割を示す。Wachaへの登録は実装完了を意味しない。製品コード・DB・設定・実行時のRole文書・正本仕様の変更は、登録した実装Taskで行う。

## 目的と対象

Agentが解決できない設計・要件の問題を相談として切り出し、HumanがCompassで会話・判断し、その結論が実行と文書へ反映されるまでを実装する。

今回含めるもの:

- Project / Workspace scopeの相談、横断した判断待ち一覧。
- 非同期のHuman / Agent会話、結論、根拠・関連Task・成果物参照。
- Task単位の相談待ち、Human回答後のAgent再判断、解決後の自動再開。
- 結論から仕様・Policy・ADR反映Taskへの引継ぎと反映済み参照。

ログ収集・自律修復、対話しながらのコード編集、Figma連携、汎用チャット基盤、WebSocket、メール・Slack通知は含めない。

## 運用原則

- 既存の権限・実行Policy内の実行は追加承認を求めない。
- 既存の要件・方針内の整理・運用判断はAgent間で進め、成果に対するHumanのフィードバックを受ける。
- 構造・技術選択についてAgent間で解消できない選択、要件・ルールの不足・矛盾を相談にする。通常の判断をすべてHuman待ちへ変換しない。
- 相談作成時に、何が決まれば進めるか、選択肢、影響、推奨をAgentが整理する。Serverは意味を判定せず、必要項目・権限・状態・版を検証する。
- 返信・結論の記録、Task再開、文書反映を区別する。会話が続いているだけで再開せず、ADR未反映だからという理由だけで一律に実装を止めない。

## 利用の流れ

1. Worker / Reviewer / Manager / Strategistが相談を作る。相談だけでも作成でき、Taskの停止を必須にしない。
2. 継続不能なTaskがある場合だけ、現在のClaimを持つAgentが、そのTaskに相談待ちを設定する。必要な成果物・再開情報を保存した後にClaimを解放する。
3. Humanは「判断待ち」の一覧から、質問・選択肢・推奨・影響・証拠を読み、返信する。返信は会話であり、常に最終決定とは限らない。
4. ProjectはManager、WorkspaceはStrategistが新しい返信を受けて再判断する。不足があれば同じ相談で質問を返す。解決していれば結論・根拠・適用範囲・反映先を記録する。
5. 解決によりTaskの相談待ちを解除し、Runtimeが必要な成果物・要件・PR/SHA・Claimを照合して元の段階から再開する。手動の`ralph resume`を通常経路にしない。
6. 必要な仕様・Policy・ADRは文書反映Taskへ渡し、Review・Acceptance後にRepository参照を登録する。

Humanが明確に方針を決めた場合に追加確認を要求しない。UIに「この方針で決定」を用意して構造化した結論を直接記録できるようにするが、通常の会話からAgentが結論を整理する経路も使える。両者の記録主体を偽らない。

## 所有するデータと境界

`packages/collaboration`を相談の所有Contextとして追加する案。最初のuse caseと実装を同時に追加し、空のpackageだけを先に作らない。

| 保存対象 | 最小の内容 |
| --- | --- |
| Consultation | scope、タイトル、判断したいこと、進めない理由、選択肢、推奨、影響、参照、状態、revision、起票者 |
| ConsultationMessage | 相談ID、Human/Agentの実際の発言者、本文、順序、時刻、requestId |
| ConsultationResolution | 結論、根拠、適用範囲、根拠のMessage ID/版、記録主体、判断の由来、反映先、requestId |
| Follow-up reference | 結論ID、仕様/Policy/ADR、反映担当Project/Repository、文書反映Task、path・commit SHA・PR URL、反映状態 |

- Project scopeは所属Workspace IDとProject IDを保持。Workspace scopeはWorkspace IDを保持しProject IDを持たない。参照先との所属を検証する。
- MessageとResolutionは追記を基本とし、Human発言をAgentが書き換えない。Humanの明示決定と、会話を根拠にAgentがまとめた結論を区別する。
- WorkはTaskの待機・再開を所有し、相談の会話・結論は複製しない。Direction DecisionはIntentに関する戦略判断のまま維持する。
- Repository上のADR・仕様本文は正本を複製せず、結論の要約と参照を保持する。

### 相談状態

| 状態 | 意味 |
| --- | --- |
| waiting_human | Humanへの質問があり、判断待ち一覧の主対象 |
| waiting_agent | Humanの新しい返信があり、Agentの整理・回答待ち |
| resolved | 根拠となる会話の版を指定した結論がある |
| canceled | 不要になった相談。理由を保持する |

作成は`waiting_human`、Human返信は`waiting_agent`、Agentの追加質問は`waiting_human`へ進む。結論確定と`resolved`を同一transactionで保存する。文書反映の状態は相談状態から分離する。

解決済みの相談へ新しい未処理質問を黙って追記しない。方針の変更・訂正は元の相談と結論を参照する新しい相談として追跡する。取消だけで待機Taskを自動再開せず、Managerが不要理由と継続方針を確認する。

## 認可と担当Role

| 操作 | Project scope | Workspace scope |
| --- | --- | --- |
| Humanの参照 | viewer以上 | viewer以上 |
| Humanの返信 | editor以上 | editor以上 |
| Humanの方針決定・取消 | administrator以上 | administrator以上 |
| Agentの相談作成・参照・返信 | 許可されたProject Execution Role | 許可されたWorkspace Direction Role |
| Agentの結論整理・取消 | manager | strategist |

既存AccessのRoleとscopeの分離に合わせ、上記の新しい操作を権限表へ追加する。Humanの決定操作とAgentの結論整理は別入口にし、AgentがHumanの決定主体を指定して偽装できないようにする。

横断一覧でも各相談の所属権限を検証する。Project権限からWorkspaceの相談を、Workspace権限から未所属Projectの相談を参照できるようにはしない。権限のない関連先は本文や件数から漏らさない。

scopeは決定対象の所有で決める。複数Projectへ影響するだけでWorkspaceへ昇格させない。初期実装では、scopeをまたぐ自動転送・親子相談の連鎖は作らず、権限のある相談・成果への参照で連携する。

## API・MCP・UI

### application use case

相談の作成・一覧・詳細、Message追加、Humanの方針決定、Agentの結論整理、取消、Task待機の関連付け、反映Task/成果物参照の登録を追加する。Web APIとMCPの両方が同じapplicationへ委譲する。

Agent/Runtime向けMCPの操作案:

- create_consultation / list_consultations / get_consultation
- reply_consultation / resolve_consultation / cancel_consultation
- wait_for_consultation（現在のTask/Claimの所有と相談の整合を検査）
- link_consultation_followup / record_consultation_artifact
- 相談応答の実行権取得・更新・完了（Taskの作業Claimとは別の短いlease）

最終的なTool名は既存の公開命名規約に合わせる。Human専用の方針決定をMCPへ公開しない。

### 画面

- グローバルな「判断待ち」入口: 自分が閲覧できる相談を一覧。既定はHuman待ち。Project/Workspace、状態で絞る。
- 相談詳細: 質問・選択肢・推奨・影響・関連先を上段、会話と返信を下段に表示。
- 結論と反映状況: 結論、根拠、仕様/Policy/ADR反映Taskと成果物参照、元Taskの待機/再開を表示。
- Project / Workspace側の入口と、Task詳細の相談待ち表示。
- 非同期の返信とpollingで開始する。現在の共通部品・SCSSトークン・Feature境界を利用する。UI整理Storyの未完成部分へ循環依存させない。

## 待機・再開とRuntime

### Server / Work

- 相談待ちはTaskの補助状態とする。Taskの既存statusと、work/review/acceptanceのどの段階で待ったかを保持し、全てをtodoへ戻さない。
- 相談待ちのTaskを`availableFor`とClaim取得の両方で除外する。一覧だけを隠して直接Claimできる状態にはしない。
- 相談の結論、待機関係、元Taskの要件と成果の版から再開可能性を照合する。関連する未解決相談が複数ある場合はすべて確認する。
- collaborationとWorkはapplicationのportで連携し、互いのRepository/tableを直接読まない。相談解決から待機解除までの反映は冪等にし、途中停止時は現在状態から再照合できるようにする。

### Orchestrator

- Project Manager / Workspace Strategistに、対象相談ID・未処理の入力版を渡して起動する。
- TaskのClaimとは別に、相談IDと入力版の応答leaseをServerで取得する。同じ返信への多重回答・二重解決を防ぐ。
- 保存更新にはexpectedRevisionを使う。回答生成中にHumanが追加返信した場合、古い版で解決せず、新しい入力を読んで続行する。
- 試行・時間の上限は既存の実行制御を利用する。Agentが失敗してもHuman回答を処理済みにせず、未処理状態と失敗理由を表示する。

### Ralph / Agent実行

- 成果物・前回Context・相談ID・待機したTask/Claim/段階を保持する。相談待ちをRole全体のpauseへ変換しない。
- 解決後にWorkの候補と保存済み実行を照合し、必要ならClaimを再取得して再開する。人が保留ファイルを削除する方式にはしない。
- 保存済みの`blocked`結果をそのまま再送せず、相談の結論と現在の要件・PR/SHAを読んで再判断する。
- Compass製品側を正本とする実行契約を定義し、agent-foundation版の稼働Ralphには必要なadapterを接続する。Wacha開発Taskへの保留管理とCompass製品の相談機能を混同しない。

## ADR・仕様・Policyへの反映

- Agentが反映要否と種別を判断する。通常の許可や確認をADRにしない。
- 文書反映が必要なら、結論ID・対象Repository・目的・必要な結論・検証方法を持つWork Taskを作る。同じ結論・反映先への起票は冪等にする。
- ADR反映TaskはRepositoryの規約に従い、通常のWorker→Reviewer→Managerで受け入れる。相談のためだけに別のPR/Review体系を追加しない。
- 完了したTask・Repository・path・commit SHA・PR URLを相談へ関連付け、反映待ち/反映済みを表示する。登録時に対象との整合を検証する。
- 原則として結論が成立すれば元Taskは再開可能。ADR反映前の再開を避ける必要がある場合だけ、結論にその理由と明示的な前提Taskを残す。文書反映Taskが元Taskの受入を待つ循環は作らない。
- 現在のDirectionのADR依頼はIntentのadr_candidate Decision起点に限定される。初期実装ではこの制約を壊さず、相談由来はWorkへの文書反映と相談の成果物参照で接続する。既存のRepository参照・検証処理は再利用し、架空のIntent/Direction Decisionを作って接続しない。

## 実装の分割案

1 Story内の5つの検証可能な増分とする。各Task本文に先行Taskの実IDと必要なAccepted状態を記載する。番号やsortOrderによるサーバーの依存制御は前提にしない。

| 増分 | 完成させる成果 | 受入境界 |
| --- | --- | --- |
| 01 Project相談の作成・会話・結論 | Collaboration保存、Access、Web/MCP、Projectの判断待ち一覧・詳細・返信・結論 | AgentがMCPで質問し、HumanがUIで返信し、Agentが結論を残せる。自動再開とWorkspace対応を先行ACにしない |
| 02 Taskの相談待ちと自動再開 | Work候補/Claim判定、Orchestrator応答起動、Runtimeの成果物保持・再開 | 同じTaskの二重取得を防ぎ、Human回答→Agent再判断→Task再開が手動resumeなしで通る |
| 03 Workspaceと横断一覧 | Workspace相談・Strategist応答、両scopeの検索・認可・関連先表示 | Project/Workspaceそれぞれの公開操作で相談を作れ、横断一覧で権限漏洩なく会話・解決できる |
| 04 文書反映Taskと成果物参照 | 結論から仕様/Policy/ADR Taskへのhandoff、通常Review、反映状況 | 設計相談→結論→ADRの受入→参照表示まで通る。元Taskとの依存循環がない |
| 05 統合検証と正本更新 | 全経路のブラウザ・認可・競合・通信失敗回帰、運用/Role/Skill整合 | Story全体の完了条件を統合SHAで独立確認する |

各増分で公開入口・認可・画面・検証まで閉じる。別Taskでしか作れない状態を先行TaskのACに置かない。通常の実行・運用判断を相談へ送らず進めるケースも検証する。

## 主な受入シナリオ

- ProjectのWorkerが設計相談でTaskを待機させ、HumanとManagerの会話・結論から自動再開する。
- 回答が不十分なら同じ相談で追加質問し、Taskを再開しない。
- Humanが明確に決めた内容について再承認を要求しない。Agentの結論整理をHumanの明示決定と偽装しない。
- WorkspaceのStrategist相談とProject相談を、Membershipの範囲内で横断閲覧・回答できる。
- 有効Claimがなくても相談待ちTaskを別Workerが取得できない。実行中に別相談の回答が来ても同じWorktreeを二重起動しない。
- 同時返信、古いrevisionでの解決、応答lease切れ、通信断後の再送・Runner再起動で会話・結論・反映Taskが重複しない。
- 取消・方針訂正・ADR反映待ちを区別し、元Taskの成果物を失わない。
- ADRがRepositoryに反映され、参照だけをCompassへ戻せる。仕様本文・会話全文をActivityへ二重保存しない。
- Desktop/狭い画面、空/処理中/失敗/権限不足の画面を実ブラウザで確認する。

## 確定と実装時に変更する場所

- `packages/collaboration`、`packages/work`、`packages/access`、`packages/activity`とserverのschema合成・application組立。
- `server`のWeb API・MCP・Role Context・Orchestration State・Web UI。
- `orchestrator/`、Compass製品側`ralph/`、移行に必要なagent-foundation側adapter。
- Role/Skill/Knowledge、統合Architecture Handoff、Context追加のADR、API・認可・実装状況・運用文書。

## Wacha登録先

Project: `45186ac4-9c0a-4bf5-8fb3-0f4ab9d4e7c3`。

Story: `92f8713f-cc83-4176-96ee-a204bfc2dab5`「Agentの相談をHumanの判断・Task再開・ADR反映へつなぐ」。

| Task | ID | 先行条件 |
| --- | --- | --- |
| 01 Project相談・会話・結論 | `9c32f90e-d2ba-4a17-9ef7-1f584abd8ec5` | このStory内の先行Taskなし |
| 02 Task待機・Agent再判断・自動再開 | `37a47089-2284-43ab-b101-b80cfe3224c9` | 01がAccepted、merge済み |
| 03 Workspace・横断一覧 | `d2c46d4c-6c6c-4a63-b960-f21334ea0602` | 02がAccepted、merge済み |
| 04 仕様・Policy・ADR反映 | `0eb6580c-b328-47f0-b02c-f08bbe6c9f8e` | 03がAccepted、merge済み |
| 05 統合検証・運用・Role手順 | `73f57715-d847-4f67-9e30-8f27025a02cb` | 04がAccepted、merge済み |

実行時のTask状態と実装結果はWachaで確認する。
