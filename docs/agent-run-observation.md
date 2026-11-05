# Agent実行観測

AccessがPrincipal・activeRole・Workspace / Project scopeに紐づくrunを`agent_run`へ永続化する。Runnerが報告した事実であり、プロセスの生存保証・Activity・workflow checkpointには使わない。

## 記録と認可

MCP `record_agent_run`は`runId`・`scope: { kind, id }`・`source: ralph | orchestrator`・`event: started | observed | finished`を受け取る。開始には任意の`provider`・`workRef: { kind, id }`（task / intent / outcome / evaluation / research_request / consultation）、観測には`staleAfterSeconds`（30〜86400、既定1800）、終了には`result: succeeded | failed`と任意の`reason`を渡す。時刻はServerの受付時刻。

- Agent Credentialは発行scopeの自分のPrincipalだけ。`X-Compass-Active-Role`とそのscopeのGrantを要求する。
- Runtime Credentialは同じscopeの`agent:run:write`を要求する。入力の`principalId`・`role`のGrantも検査する。WorkspaceからProjectへ継承しない。
- 同じrun IDの開始と同じ終了結果の再送は変更なし（`recorded: false`）。別Principal・scope・Roleへの流用、終了結果の変更は`CONFLICT`。未開始の観測・終了は`NOT_FOUND`。
- `observed`は実行中だけ最終観測・期限を更新する。終了後の遅延観測は変更しない。reason・provider・作業参照内のCompass token／Bearer値は伏字にし、run IDにCompass tokenを含められない。

## 参照と表示

Humanの`GET /api/workspaces/:workspaceId/agent-runs`はWorkspace Membership viewer以上に公開する。Workspaceとactiveな所属Projectの、Principal・scope・Roleごとの最新runを返す。`?principalId=`はそのPrincipalの履歴を新しい開始順で最大20件返す。`asOf`はServerの読取時刻。`observation`は期限内の実行中`running`、観測途絶`stale`、正常終了`succeeded`、異常終了`failed`。

Agent一覧・詳細は期限内の実行中を優先し、無ければ最終観測が新しいrunを代表とする。正常終了は前回の終了の報告として「待機」、異常終了は「エラー」、途絶・報告なしは理由付きの「不明」、読込失敗は「取得不能」と表示する。実行観測・Projectを読み込めなかった場合は一覧・詳細に欠けを明示し、観測だけが残るPrincipalを含め、Agentの0件・不存在を断定しない。未接続をゼロ・停止・成功に置き換えない。詳細の履歴からRole・scope・run ID・報告元・作業参照・時刻・理由を確認できる。

## Runnerの接続

Ralphはprovider実行の前後で開始・終了を報告し、`observation.heartbeatSeconds`（10〜28800、既定300）ごとに観測、3間隔で観測途絶とする。通常のTask選択はAgent内なので開始時の作業参照は無く、相談再開の取得済みTaskだけを付ける。現在の作業（Claim）は別に表示する。強制終了で終了報告が無い場合は観測途絶になる。

Orchestratorは`workspaces[].agentPrincipals`にstrategist / researcher / evaluator、`workspaces[].projects[].agentPrincipals.manager`または`consultationProjects[].agentPrincipals.manager`に起動するPrincipalを設定する。対象scopeのRuntime Credentialへ`agent:run:write`を加える。Projectは自身の`tokenEnv`が必要。起動・終了とdispatchの作業参照を報告し、lease＋停止猶予＋60秒で観測途絶とする。Principal未設定はskip、報告失敗はOperational Logへ記録して実行を継続する。設定値は起動AgentのCredentialのPrincipalと合わせる。

制御可能なadapterによる検証は[ブラウザ検証](browser-verification.md#agent実行観測の専用検証)、製品部品の状態例はStorybook `Patterns/AgentExecution`。テストadapterの報告は実Providerの自律運転の実証とは区別する。
