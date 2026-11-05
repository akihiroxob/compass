# ADR 0005: Agentの実行観測をRoleの割当・作業権と分離する

- 状態: 承認
- 対象: Access / Server / Ralph / Orchestrator / Web UI

## 決定

Principal・activeRole・scopeに紐づくRunnerの実行観測をAccessの`agent_run`に永続化する。Grant・Credential・Claimからプロセスの生存を推測しない。開始・最終観測・終了（成功／失敗）だけを扱い、外部agent-foundationの全面集約は行わない。

Agent自身はそのCredentialのscopeとactiveRole、Orchestratorは対象scopeのRuntime Credential `agent:run:write`で報告する。どちらも指定PrincipalのRole GrantをServerで検証する。run IDは一意とし、別Principal・Role・scopeへの上書きを拒否する。時刻はServer時計、認証情報は伏字にする。

Humanは所属Workspaceとactiveな所属Projectの観測をWeb API・Agent一覧／詳細で読む。期限内の報告・途絶・正常／異常終了・観測なし・取得不能を区別し、時刻・理由・run／作業参照を根拠として出す。正常終了の「待機」は前回の終了を示すもので、待機プロセスの生存保証ではない。

## 理由と影響

Grantは担当権限、Credentialは接続資格、Claimは期限付き作業権であり、どれもRunnerが実行している証拠にはならない。runは意味のある業務履歴とは別の観測なのでActivityへ書かず、workflow checkpointにも流用しない。報告失敗でAgent実行を停止せず、未接続や途絶をUIの不明として扱う。Runnerの強制終了で終了報告が欠けても、期限後に作業中と断定し続けない。

観測だけが残るPrincipalも根拠へ辿れるようにし、Grant取消・Credential失効で履歴を消さない。テストadapterの自己申告は実Providerによる自律運転の実証と区別する。詳細契約とRunner設定は[Agent実行観測](../agent-run-observation.md)を正本とする。
