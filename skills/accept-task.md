---
name: accept-task
description: manager が Task の成果を要件と Project 全体の整合性に照らして最終受入し、Accept または Reject を判断する。
status: active
version: 1
requiredKnowledge:
  - tips/acceptance.md
  - tips/task-writing.md
  - tips/verification.md
requiredTools:
  - compass:list_stories
  - compass:list_tasks
  - compass:list_task_comments
  - compass:list_changes
  - compass:claim_acceptance
  - compass:renew_claim
  - compass:release_claim
  - compass:add_task_comment
  - compass:accept_task
  - compass:reject_task
---

# accept-task

## Purpose

Task 単体の完了報告だけでなく、人と合意した要求、親 Story、Project の正本資料、実際の成果を照合し、最終受入を判断する。

reviewer の実装レビューを追認するのではなく、「この成果を製品へ取り込んでよいか」を manager の責務として独立に判定する。

## Steps

1. `list_tasks` を `availableFor: "acceptance"` で取得し、対象 Task を選ぶ。
2. 親 Story、Task、worker / reviewer コメント、関連する Change Log を確認する。
3. Project の `AGENTS.md` と、Story・Taskが参照する主要な設計資料を確認する。
4. 一意な `requestId` で `claim_acceptance` を呼び、`claimId` を保持する。
5. `knowledge/tips/acceptance.md` に従い、Task の完了条件とシステム全体の整合性を分けて検証する。
6. 判断根拠と確認した証拠を整理する。補足を残す必要があれば `add_task_comment` を使う。
7. 両方を満たす場合だけ `accept_task` を呼ぶ。不足があれば、期待との差分と再受入条件を reason に含めて `reject_task` を呼ぶ。
8. 判断材料が取得できず判定を中断する場合は、理由を添えて `release_claim` を呼ぶ。

## Success Criteria

- Accept / Reject の判断が、Task、親 Story、Project の正本資料、実際の成果から追跡できる。
- テスト成功、Reviewer 承認、模擬実行のいずれか一つだけを根拠に Accept していない。
- Reject の場合、修正すべき差分と再受入条件が実行可能な形で示されている。

## Anti Patterns

- Reviewer が通したことだけを理由に Accept する。
- Task の局所的な完了条件だけを見て、親 Story や Project 全体との矛盾を見落とす。
- Project 固有の責務や用語を推測し、正本資料を確認せずに判定する。
- 「後続 Task で直す予定」という未確定な説明だけで、現在の不整合を許容する。
- 判断できていない状態で Claim を保持し続ける。
