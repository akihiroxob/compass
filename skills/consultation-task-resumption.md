---
name: consultation-task-resumption
description: Project相談の待機、Manager応答と保存済み実行の安全な再開。
status: active
version: 1
requiredKnowledge: []
requiredTools:
  - compass:create_consultation
  - compass:get_consultation
  - compass:acquire_consultation_lease
  - compass:reply_consultation
  - compass:resolve_consultation
  - compass:wait_for_consultation
  - compass:list_consultation_resumptions
  - compass:resume_consultation_task
  - compass:confirm_consultation_continuation
---

# consultation-task-resumption

## 相談と待機

- 通常の許可・既存の要件/方針内の判断は追加承認なしで進める。要件不足・矛盾やAgent間で解消できない設計判断だけを相談にする。
- `create_consultation`で何が決まれば進めるか、選択肢・推奨・影響・成果物参照を整理する。Taskを止めずに相談だけを作ってもよい。
- 継続不能なTaskだけ、現在のClaimで`wait_for_consultation`を呼ぶ。全ての待機相談ID、理由と`runtime`を渡す。会話本文をTaskへ複製しない。
- 呼出前に未commit変更・未追跡成果物・前回Contextを永続化する。`contextPath`は専用worktree内の`.compass-ralph/`等へ置き、Task/Claim/段階・PR/SHA・要件・検証ログの参照を残す。
- `runtime`は`worktreePath`・`contextPath`・`headSha`・`sourceFingerprint`・`pullRequest`（無ければnull）・`verificationRefs`。製品Ralphの`node ralph/runtime/consultation-context.mjs <runtime.json>`で現在版を読む。Context保存後に計算し、その後成果物を変更しない。
- Serverが待機関係と再開情報を保存し、statusを保持したままClaimを解放する。成功後はそのClaimで更新しない。Role全体のpause・Taskをtodoへ戻す操作・成果物の破棄は行わない。

## Human返信へのManagerの応答

- 起動Contextの相談ID/入力版を手掛かりに`get_consultation`で現在の会話を読む。現在の`revision`で`acquire_consultation_lease`を取り、応答/解決に`leaseId`・`expectedRevision`・一意な`requestId`を使う。
- 不足なら同じ相談へ`reply_consultation`で追加質問する。十分ならHuman発言を`basisMessageIds`に指定し、`resolve_consultation`で結論・根拠・適用範囲を整理する。明確なHuman回答に再承認を求めず、Humanの決定主体を偽装しない。
- 追加返信による古い版・lease失効は会話を再読込する。処理できない場合は失敗理由をRuntimeへ返し、返信を処理済みと扱わない。
- 取消だけでは再開しない。不要理由・継続方針を確認し、現在のTaskの`requirementVersion`と全相談の現在版で`confirm_consultation_continuation`を呼ぶ。要件変更も同じく現在内容を確認する。未解決相談の解決をこの操作で代替しない。

## 再開

- Runtimeは`list_consultation_resumptions`で現在状態を照合し、`ready`を対象にする。全相談の解決/取消確認と現在要件版の照合前には起動しない。
- 保存済みworktree/Contextを復元し、実際のPR・HEAD・未commit/未追跡成果物のfingerprintを照合して`resume_consultation_task`で元段階のClaimを再取得する。同じworktreeのOS lockを保持する。製品Ralphは保存時と同じ`projectRoot`の設定で自動pollingする。
- 新Agentは保存済みContext、全相談の結論、現在Task要件・PR/SHAを読む。旧blocked結果を再送せず、古い検証を現SHAの成功として扱わない。新しいClaimで通常のwork/review/acceptanceを続ける。
- 通信再送は同じ入力と`requestId`。失効Claimは更新しない。Runner停止・再起動時も旧Agentの終了・worktree lockを確認してから起動する。
- 成果物版が変わり照合が拒否された場合は、保存済み成果物を破棄せず、差分と再開失敗理由を報告する。
