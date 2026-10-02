# Intentの現行仕様

IntentはHumanが現在実現したい状態。Projectの継続的な存在理由であるMissionと区別する。型は [Intent.ts](../src/domain/model/Intent.ts)、入力規則は [intentSchema.ts](../src/shared/intentSchema.ts)。

## 項目と状態

`projectId`、必須の`title`（100文字まで）・`desiredState`（2,000文字まで）、任意の`completionDefinition`（2,000文字まで）、`status`、`abandonedReason`、ID・作成更新日時を持つ。

状態は`active` / `achieved` / `abandoned`。Project内のActive Intentは最大1件で、DBの部分一意indexでも強制する。作成時はactive。Humanの放棄はabandonedへ遷移する。Strategistの根拠付き`intent_complete`判断でachievedへ遷移する。終端からの復帰操作はない。

## 更新と操作

activeの間だけ部分更新できる。Outcomeを持つIntentはtitleのみ変更でき、desiredState / completionDefinitionを変更できない。archived Projectでは書込を拒否する。

HumanはProject詳細から作成し、Intent詳細から編集・放棄する。Web APIは`/api/projects/:projectId/intents`とその詳細・更新・`abandon`。変更にはeditor以上のMembershipが必要。remote modeのMCPにはHuman用の作成・更新・放棄toolを公開しない。

## Researchとの接続

現在の実装はIntent作成と同じtransactionでInitial Research RequestとRuntime eventを保存する。Agentの実起動は未接続。

確定したDirectionフローはStrategistがResearchの必要性を判断する方式であり、現行の自動Request作成からの変更は [Wacha向け移行計画](architecture-migration-plan.md) で扱う。
