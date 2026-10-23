# Humanとの協働・自律保守・対話的開発の変更案

設計検討用の案。実装済みの仕様や確定したアーキテクチャとしては扱わない。

## 前提

- 既存の権限・実行Policy内の操作に、都度のHuman承認を追加しない。
- 合意済みの要件・Policy内の要件整理・運用判断はAgent間で進める。成果へのHumanフィードバックを受け付ける。
- Humanへの相談は、Agent間では解決できない構造・技術選択、要件・ルールの不足や矛盾を中心とする。単に判断を行ったことだけを理由に相談を作らない。
- Serverは所有・認可・排他・状態遷移・重複防止を強制する。意味の分類、対応要否、設計案の選択はAgentへ委譲する。
- HumanはWeb UI、AgentとRuntimeはMCPを入口とする。Web APIとMCPは同じapplicationへ委譲する。
- デザインシステム・Figma連携はこの案の対象に含めない。

## 現在再利用できるものと不足

| 現在の実装 | 再利用・変更の方向 |
| --- | --- |
| WorkのStory・Task・Claim・Comment・Review・Acceptance | 修正作業と対話的開発の成果を既存のReview・Acceptanceへ渡す。会話の全発言をTask Commentへ混在させない |
| Humanの起票・コメント・受入・差し戻し操作 | 作業の開始とフィードバックに再利用。HumanをAgent Principalとして偽装しない |
| Direction Decision | Workspaceの戦略判断に再利用。Intent必須のため、Projectの一般的な相談・回答を無理に格納しない |
| ADR依頼・参照 | Repository上のADRを参照する方式を維持。現在はWorkspaceのadr_candidate Decision起点であり、Projectの技術判断への接続は追加が必要 |
| Activity | 相談の解決、障害の解消、Reviewへの引継ぎ等の意味的履歴。会話全文・生ログ・実行checkpointの保存には使わない |
| Workspace Orchestration Stateとdispatch | Human回答や振り返りの未処理状態を起動条件へ追加。分類や修正方針は起動されたRoleが判断 |
| Compass製品側Ralph | 現在はWorker/Reviewerの一回ごとの起動方式。対話入力・中断・再開・Review引継ぎの実行契約を追加 |

稼働中のagent-foundation版RalphとCompass製品側の`ralph/`は別実装。統合先の契約をCompassに定義し、移行に必要な接続だけをagent-foundationへ提供する。両方へ別の業務判断を重複実装しない。

## 1. 人への相談と判断待ち一覧

### 保存と責務

相談は両scopeで同じ会話・解決のライフサイクルを持つため、`packages/collaboration`を新しい所有Contextとする案を推奨する。確定時にADRとアーキテクチャ正本へ反映する。先に空のpackageだけを作らず、最初のuse caseと合わせて追加する。

最小の保存対象:

- Consultation: 所属scope、相談内容、判断できない理由、選択肢、推奨、影響範囲、関連Task/Outcome/証拠参照、状態。
- Message: 発言者、Human/Agentの区別、本文、時刻、会話の版。
- Resolution: 合意・判断の結論、根拠、適用範囲、判断主体、元になった会話の版、反映先参照。

会話と結論は分ける。判断の訂正は追跡可能にし、元のHuman発言をAgentが書き換えない。本文がRepository正本のADR・仕様は複製せず、結論の要約と参照を保持する。

### scopeとRole

- Task/Story/Repository/実装・Project固有運用: Project scope、Managerが整理する。
- Intent/Outcome/Target選択・戦略・貢献配分: Workspace scope、Strategistが整理する。
- 影響するProject数だけで分類しない。Agentが所有責務を基準にscopeを提案し、Serverが所属・参照・権限を検査する。
- Projectの相談にWorkspace判断が必要なら関連する相談を作って結論を返す。内容を丸ごと移して閲覧権限を広げない。

### 人に聞くかと結論の反映先は別にする

| 判断 | 通常の処理 | 保存・反映先 |
| --- | --- | --- |
| 実行上の許可・選択 | 既存Policy内なら追加承認なしで実行 | 必要な判断・実行記録 |
| 継続要件・運用ルール | 既存方針内ならAgent間で決定・反映 | 仕様・Policyと判断参照 |
| 構造・技術選択 | Agent間で解決できる範囲は進め、解決できない選択をHumanへ相談 | 決定の性質に応じADR等へ反映 |
| 要件・ルールの不足や矛盾 | Agentが不足と選択肢を整理して相談 | 解決した仕様・Policyまたは設計判断 |

ADR化を自動的な追加承認ポイントにしない。代替案・トレードオフ・将来の構造変更に効く設計判断をADRにし、通常の運用確認やUI寸法までADRへ流さない。Agentが反映先を整理し、人は結論と反映先へフィードバックできる。

### 公開入口と画面

- Agent向けMCP: 相談の作成・参照・返信、結論整理、関連Task/成果物との接続。
- Human向けWeb API: 権限のある相談の一覧・詳細・返信・方針決定。Humanの決定操作をAgentへ無条件公開しない。
- Web UI: 横断した「判断待ち」一覧、Project/Workspace絞込み、相談詳細と会話、選択肢・推奨・結論・反映状況。
- 横断一覧は所属権限で各レコードを絞る。Project MembershipからWorkspace相談の閲覧を継承しない。
- 最初は非同期の返信とpollingで成立させる。WebSocketやProvider固有の常駐チャットは必須にしない。

### 回答から作業へ戻す

- Orchestratorは未処理の返信・結論の版を読んでManager/Strategistを起動する。同じ版での重複起動を抑止する。
- Workは相談IDと再開に必要な結論の版を参照する。相談待ちはそのTaskだけに作用し、Role全体を止めない。
- 相談待ちをRuntimeのローカル保留ファイルだけに置かず、Workの候補判定へ反映する。成果物と再開情報を保存して作業Claimを解放しても、別Workerが回答前に同じTaskを再取得しないようにする。Context間はapplicationのportで必要な準備状態を参照し、互いのtableを直接読まない。
- 返信があったことと解決を同一視しない。Agentが内容を照合し、結論が成立すれば作業を再開し、不足があれば同じ相談で応答する。
- 合意後のTask要件・PR・SHA・Claimを再確認する。古い結果JSONを無条件に完了扱いにしない。
- ADRが必要ならWorkの文書反映Taskへ渡し、通常のReview・AcceptanceとRepository参照で反映完了を確認する。

## 2. 定期的な運用ログの振り返りと自律修復

### 新たに必要なもの

定期的な運用ログ振り返りのdispatchは現在のOrchestratorにない。Outcome評価とは目的・起動条件が違うため、Evaluatorの既存処理へ暗黙に混ぜない。

`packages/operations`で次を所有する案を推奨する。ActivityやDirectionへ生ログと運用checkpointを集めない。

- LogSource: scope、取得元の識別、収集方法、権限とマスキング方針。
- Observation/ErrorGroup: 発生期間・件数・代表例・証拠参照・再発をまとめる記録。
- OperationalReview: 収集範囲、未処理/調査中/完了等の状態、調査結果、関連Task/相談、次の振り返り時点。

ログの取得位置・重複取り込みの記録は運用収集の状態として管理する。Activity cursorを代用しない。意味的な同一原因の判断はAgentが行い、収集側はsource・generation・position等による同じ観測の重複を防ぐ。

### 実行の流れ

1. Runtimeが定期的に、許可されたログ源から新しい範囲を取得する。ローテーション・取得途中の失敗を扱う。
2. ServerへMCPで観測を登録する。資格情報を収集段階で除き、生ログは適切な運用保存先、Compassには必要な要約と参照を置く。
3. Orchestratorが未処理の振り返りを担当Agentへ渡す。まずはProjectのManager等を利用し、専用Roleの新設は必須にしない。運用調査の権限は明示的なGrant/能力として定義する。
4. Agentが既知エラー・既存Task・修復中の作業と照合し、対応不要/再観測/環境復旧/修正Task/相談を判断する。
5. 小さな修正は既存Workへ起票し、Worker→Reviewer→Managerで処理する。大きさだけでなく、未確定の要件・設計判断が必要かで相談へ送る。
6. 修正の受入と再観測で解消・継続・再発を区別する。PRのmergeだけで運用障害の解消としない。

### RuntimeとServerの分担

- Serverへホストfilesystemへのアクセスを要求しない。ファイル・コンテナログ・外部ログ基盤等の取得は配置先のCollector/Runtime adapterが担当する。
- 相談応答・運用調査は対象と入力版を単位に排他・冪等性を持たせる。Directionの既存Runtime eventを汎用の会話・運用イベント置き場にはせず、各Contextの現在状態をdispatchへ公開する。
- 初期実装は定期実行と既存Orchestratorの拡張で成立させ、独立した常駐監視基盤や専用Roleを必須にしない。
- 取得失敗時にcursorを進めず、観測再送・調査再起動・Task作成の冪等性を保証する。同じ未変化エラーでTaskとAgentを増殖させない。
- 通信断で操作の成否が不明なら照合を先に行う。再POSTや再mergeを修復とみなさない。既存の試行回数・時間制限を再利用する。
- 調査・対応状況の一覧をUIに追加し、Humanへ送るものは1の判断待ちへ集約する。

## 3. 記録しながら対話的に開発する

### Workを拡張する

対話的開発のために別のTask/Review体系は作らない。`packages/work`へInteractiveWorkSessionを追加し、既存Task・Claim・成果物・Reviewを参照する。

- 最小の作業枠を先に記録する。既存Taskの開始、またはHumanの短い依頼から一つのTaskを作る。
- Sessionは目的、入力メッセージ、判断と要約、対象Repository/branch/worktree、実行中の指示版、検証・成果物参照、Reviewへ渡した地点を追跡する。
- 対話のたびにTaskを増やさない。TaskのCommentには節目の要約・結論・検証を残し、全会話を複製しない。
- 大きな要件変更・設計選択は1の相談またはManagerの計画修正へ接続する。通常の細かな調整に再承認を要求しない。

### 実行方式を追加する

- Runtime/Ralphが同じTaskの作業を継続し、新しいHuman入力をAgentへ渡す。実装はRuntime側のWorktreeで行い、Serverはホストのコードを直接編集しない。
- Claimと作業権の所有者は一人のWorkerに固定し、通常の自動Workerが同じTask/Worktreeを重複編集しない。
- 指示には版を持たせ、実行中に届いた指示の扱い（次のturnへ渡す、中断して再計画）と反映済み地点を記録する。古い指示で成果を確定しない。
- 最初は保存した会話の差分・要約・成果物からContextを組み立てる。Providerの会話IDだけに復旧を依存させず、常駐プロセスを必須にしない。
- 端末停止・Agent停止後も変更と記録を保持する。期限切れClaimの再取得、保存済み結果の照合、再検証を経て再開する。

### Web UIと引継ぎ

- UIに作業目的、会話、実行状態、変更要約・diff参照、検証結果、中断/再開、Reviewへの送信を追加する。
- 区切りで変更内容・判断・テスト・未検証をまとめ、Taskを既存の`in_review`へ渡す。
- Reviewerは変更と検証を通常どおり確認し、Managerが受け入れる。対話したことをReview省略の理由にしない。
- Reviewへ渡す時点の指示版・成果物SHAを固定し、Review中にHumanの追加指示で成果物を黙って変更しない。追加変更は作業へ戻すか別Taskへ分ける。
- 初期範囲にブラウザIDE・ファイル編集UI・Terminalの常時配信・全tokenの逐次表示は含めない。

## 横断して変更する箇所

| 対象 | 変更・追加 |
| --- | --- |
| Domain/Application/DB | 相談・結論・会話、運用観測・振り返り、対話作業Session。所有Contextごとのschema/repository/use case |
| Access | scope別の参照・返信・判断・観測登録・作業制御の権限。Human/Agent/Runtimeを区別 |
| Server API/MCP | Human用Web入口とAgent/Runtime用MCP、同じapplicationへの委譲、requestId・版・競合検査 |
| Role Context | 関連相談・結論・未処理入力・振り返りの要約と参照。会話と生ログ全文を毎回注入しない |
| Orchestrator | 相談返信、結論、調査対象、定期振り返りの状態をdispatchへ追加。複数の起動理由を持つManagerの対象契約を拡張 |
| Ralph/Runtime | Task単位の相談待ちと再開、対話入力、成果の固定、収集adapter、試行制限と成否照合 |
| Web UI | 判断待ち一覧・相談詳細、運用調査一覧、対話開発画面。共通部品・Feature境界を守る |
| Activity | 相談の解決、調査結論、修復受入、Review引継ぎの参照付き履歴 |
| Skill/Knowledge | 相談の要否・scope・反映先、ログ振り返り、対話開発の節目と引継ぎ。Project名や許可待ちの定型を埋め込まない |

## 実装順と検証可能な増分

1. 相談の作成→Human一覧/回答→Agentの再判断→Task再開までを、まずProject scopeで縦に実装する。新しい判断待ちが既定の承認待ちにならないことを検証する。
2. Workspace scopeと横断一覧、scopeをまたぐ相談参照、結論から仕様/Policy/ADR反映と参照登録までを接続する。
3. 対話的開発を一つのTaskで開始→変更/判断記録→Review→受入まで通す。中断・指示の競合・復旧を検証する。
4. 一つのログ源を収集→集約→調査→修正Task→再観測まで接続し、判断が必要な場合に相談へ渡す。重複・ローテーション・通信失敗を検証する。
5. 動作を確認した範囲からログ源・対象Roleを増やす。最初から全ログ基盤と汎用チャット基盤を作らない。

各増分で公開操作によるGivenの準備、scope/Role認可、状態遷移・排他・冪等性、対象SHAの実ブラウザ検証、既存経路の回帰を確認する。WachaへのStory/Task化は、この変更案の範囲と優先順位を合意した後に行う。

## 確定時に更新する正本

- 統合Architecture HandoffとContext追加のADR。
- Role/認可・Runtime Credential・Orchestration Stateの仕様。
- Research/Decision/ADR設計文書（Projectの技術判断をIntent必須Decisionへ無理に統合しない）。
- Runtime/Orchestrator/Ralphの実行契約、各機能の公開API/MCP、UI・運用手順。
- 実装状況とdocs/README.md。設計の確定・Task登録・実装完了を区別する。

この案は上記の正本を現時点で変更しない。
