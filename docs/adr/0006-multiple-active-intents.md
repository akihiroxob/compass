# ADR 0006: 複数のActive Intentを独立して進める

- 状態: 承認
- 対象: Direction / Orchestrator / Server / Web UI

## 決定

Workspaceは複数のビジネス目標を同時に扱う。Active Intentの件数制約を設けず、作成時に他のIntentを変更しない。Intentの終端・関連Outcome・Researchの取消は対象Intentだけに作用する。

Orchestration Stateは`activeIntents`と、`intentId`を持つOutcomeを返す。Orchestratorは全Active Intentを個別に判定し、関連Research・評価・Targetの状態を他目標と混ぜない。dispatch keyによる重複抑止・再計画・Workspace/ProjectのActor scopeを維持し、起動対象のIntent IDをAgentへ渡す。Researchの要否はStrategistが判断する。

Strategist Contextは`intentId`で明示選択する。省略はActive Intentが0〜1件の場合だけとし、複数件から先頭を暗黙に選ばない。Outcome・判断・Research・評価のWorkspaceとIntentの参照整合性を既存のapplication/repositoryで強制する。Role・Credentialの認可単位はWorkspace/Projectで、Intent単位の新たなGrantを導入しない。

## 保存と検証

新規DBのschemaから単一Activeの部分一意indexを除く。既存開発DBは再作成方針に従い、互換・旧DB移行を要件としない。公開入口で複数登録・再読込・別Workspace拒否を確認し、adapterのdispatch検証と実CLI常駐運転の実証を区別する。
