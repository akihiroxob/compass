# ADR 0003: Humanの所属と権限をWorkspaceへ集約する

- 状態: 承認（実装未完了）
- 対象: Access / Organization / Server / Web UI
- 関連: [ADR 0001](0001-workspace-project-boundary.md)のHuman Membershipに関する決定を更新する。WorkspaceとProjectの所有境界、Agentのscopeは維持する。

## 背景

Workspaceを一つのビジネス、そのProjectを関連するプロダクトとして利用する。Humanの参加とRoleをWorkspace・Projectでそれぞれ管理すると、参加・招待・権限変更の操作が細かくなり、Workspace内で仕事を横断して把握する利用体験に合わない。

## 決定

- Humanの所属とRoleはWorkspace Membershipを唯一の管理単位とする。Roleはowner / administrator / editor / viewerとし、Workspaceと配下のすべてのProjectへ同じRoleを適用する。
- Human向けのProject Membership、Project別Roleの上書き、Projectごとの参加・招待・取消・Owner付与は設けない。Workspaceでの権限変更・除外は、配下の全Projectへの次の操作にも反映する。
- Humanの招待はWorkspaceで行う。参加の成立時にWorkspace Membershipを付与し、配下Projectへの追加操作を要求しない。Workspaceへの参加に、Projectへの事前参加を要求しない。
- Workspaceを作成したHumanはWorkspace Ownerとなる。Project作成者へ別のOwner権限を付与しない。最後のWorkspace Ownerの降格・除外は禁止する。
- ProjectのHuman向け操作は、Serverが対象Projectの所属Workspaceを解決し、そのWorkspaceのMembershipと操作別Role水準を検証する。クライアントの申告したWorkspaceだけを信用しない。別Workspaceへの権限の流用は拒否する。
- 各操作に必要なRole水準、Taskの状態・Claim・自己レビュー／自己受入等の業務規則、対象のarchive規則は維持する。Humanの権限を統合しても、Workの所有先をWorkspaceへ移さない。
- AgentはPrincipal・activeRole・Workspace / Project scope別GrantとCredentialで認可する。HumanのMembershipをAgentのGrantとして扱わず、Workspace Agent GrantからProject Agent Grantを継承させない。
- Memberの招待・権限変更・除外の正規入口はHuman向けWeb UI / Web APIとする。管理操作をMCPへ無条件に公開しない。

## UI

- Member管理と権限のヘルプはWorkspace設定に集約する。Project設定にはHuman Memberの一覧・操作・権限の上書き入口を置かない。
- Memberの権限変更・除外ではWorkspaceと配下全Projectへの影響を示す。コメントと同様の任意の会話を、権限変更の成立として扱わない。
- Agent管理とHuman Member管理を分ける。Agentの担当Project・Roleの指定は維持する。

## 実装・検証の境界

このADRは認可モデルの決定であり、本体の実装完了を示さない。実装Taskでは以下を揃える。

1. Accessの保存・Repository・認可Service、Workspace招待・参加、OIDC / 初期Owner補完、Project作成時の処理をWorkspace Membershipに統一する。
2. Project・Work・Activity・相談・Repository / Resource・Project Agent Grant / Credential管理等のHuman向け公開入口を、対象Projectから所属Workspaceを解決する認可へ接続する。Workspace横断の一覧・検索にも適用する。
3. Project MembershipとProject招待の公開契約・UIを整理し、WorkspaceのRole変更・除外をProject側の保存済みRoleや古いクライアント状態で迂回できないようにする。
4. Role別の参照・更新・管理、別Workspaceの拒否、新規Projectへの権限適用、Role変更／除外後の拒否、最後のOwner保護、招待参加、archive、Agent scopeの非継承を検証する。

開発DBの再作成方針に従い、旧Project Membershipの移行・既存IDの保全・旧クライアント互換を必須にしない。開発用Wachaのデータは変更対象に含めない。
