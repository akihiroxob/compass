---
name: respond-consultation
description: Project相談（Manager）・Workspace相談（Strategist）でHumanの返信へ応答し、追加質問または結論を整理する。
status: active
version: 3
requiredKnowledge: []
requiredTools:
  - compass:create_consultation
  - compass:list_consultations
  - compass:get_consultation
  - compass:acquire_consultation_lease
  - compass:reply_consultation
  - compass:resolve_consultation
  - compass:cancel_consultation
  - compass:get_consultation_handoff_context
  - compass:request_consultation_followup
  - compass:record_consultation_artifact
---

# respond-consultation

## scopeと担当

- 相談のscopeは決定対象の所有で決める。Projectの要件・設計はProject相談（`projectId`）、WorkspaceのDirection（Intent・Outcome・優先順位）はWorkspace相談（`workspaceId`）。影響するProjectが多いことだけを理由にWorkspaceへ移さない。
- Project相談の応答・結論整理・取消はManager、Workspace相談はStrategist。Project GrantとWorkspace Grantは互いに継承しない。相談のtoolには`projectId`・`workspaceId`のどちらか一方だけを渡す。
- scopeをまたぐ転送・親子相談は作らない。別scopeの判断が必要なら、そのscopeで新しい相談を作り、権限のある相談・成果をrefsで参照する。Project相談をWorkspaceへ丸ごと移さない。
- 通常の許可・既存の要件/方針内の判断は相談にしない。作成時は何が決まれば進めるか、選択肢・推奨・影響・同じscopeの参照（Projectは`task`・`story`・`project_resource`、Workspaceは`intent`・`outcome`、両方`url`・`consultation`）を整理する。

## Humanの返信への応答

- 起動Contextの相談ID/入力版を手掛かりに`get_consultation`で現在の会話と`revision`を読む。現在の`revision`で`acquire_consultation_lease`を取り、応答/解決に`leaseId`・`expectedRevision`・一意な`requestId`を使う。
- 不足なら同じ相談へ`reply_consultation`で追加質問する。十分ならHuman発言を`basisMessageIds`に指定し、`resolve_consultation`で結論・根拠・適用範囲を整理する。明確なHuman回答に再承認を求めず、Humanの決定主体を偽装しない。
- 追加返信による古い版（`STALE_REVISION`）・lease失効（`LEASE_EXPIRED`）は会話を再読込して新しい入力へ応答する。処理できない場合は失敗理由をRuntimeへ返し、返信を処理済みと扱わない。
- 不要になった相談は理由付きで`cancel_consultation`する。Project相談の取消でTaskを再開する場合の確認は`consultation-task-resumption`に従う。
- Workspace相談の結論はStrategistがDirectionの判断（Outcome・Direction Decision）へ反映する。相談の結論だけでIntent・Outcomeを変更済みとみなさない。

## 結論の文書反映（反映担当ProjectのManager）

- 結論を仕様・Policy・ADRへ残す必要があるかをManagerが判断する。長く効く構造・技術選択で代替案とトレードオフを伴うものは`adr`、継続する要件は`specification`、運用ルールは`policy`。通常の実行許可・既存方針内の判断・一時的な確認・UI寸法等は文書化の依頼にしない。Humanへ追加の承認を求めない。
- 文書反映のtoolは反映担当Projectの`projectId`で呼ぶ。Workspace相談の結論は、所属Projectのmanagerが`workspaceId`も付けて`get_consultation_handoff_context`で結論を読み、そのProjectのRepositoryへの反映を依頼する（Workspace Grantは使わない）。StrategistはWorkを起票しない。どのProjectが反映するかは結論から判断し、関係しないProjectへ依頼しない。
- 必要なら`request_consultation_followup`で、反映担当Projectに登録された反映先`repositoryId`、`title`、`purpose`、`decision`（文書に書く決定内容）、`rationale`、`verification`（Reviewerが文書を確かめる方法）を渡す。文書の本文はRepositoryで書き、Compassへ複製しない。起票されたTaskは通常のWorker → Reviewer → Managerで扱う。
- 同じ結論・種類・Repositoryの依頼は同じTaskを返す。通信断後は同じ入力で再送してよい。内容を変える必要があれば既存のTaskを編集・差し戻し、別の依頼を重ねない。
- 元Taskは結論の成立だけで再開できる。文書を先に確定しないと元Taskを進められない場合だけ、`resumptionDependency`に理由を書く。文書反映Taskへ元Taskの受入を待たせない。
- 文書反映Taskを受け入れるManagerは、Reviewerの確認とRepositoryの実際の変更（受け入れたcommit・変更したpath・PR）を確かめ、`accept_task`の`deliverables`に受入成果物として残す。
- 受入後、`record_consultation_artifact`で受入成果物と同じRepository・path・完全なcommit SHA・PR URLを登録する。未受入のTask・別のRepository・関係のないTask・受入成果物に無いpath / commit / PRは登録できず、反映済みにならない。
