---
name: decompose-story
description: Story を、実装・レビュー・受け入れまで進めやすい独立した task 群に分解する。
status: active
version: 3
requiredKnowledge:
  - tips/story-splitting.md
  - tips/task-writing.md
requiredTools:
  - compass:list_stories
  - compass:list_tasks
  - compass:issue_task
  - compass:edit_task
---

# decompose-story

## Purpose

Story を、実装・レビュー・受け入れまで進めやすい独立した task 群に分解する。

## Steps

1. 対象 Story の目的・完了条件・制約を整理する。
2. `knowledge/tips/story-splitting.md` に従って、縦切りで最小提供価値単位に分割する。
3. 既存 task と重複しないように `list_tasks` で現状を確認する。
4. 各 task を `knowledge/tips/task-writing.md` の形式に合わせて記述する。
5. task 間の依存関係と並行実行可能性を明示する。
6. 必要な task を `issue_task` で登録し、Story と task の対応を確認する。
7. 着手すべき順序に意図がある場合は、`edit_task` の `sortOrder`（小さいほど優先）で順序を明示する。順序はworkerの選択材料であり、先頭TaskのClaimを強制しない。

## Success Criteria

- Story の完了に必要な task が過不足なく列挙されている。
- 各 task が単独で着手可能な粒度で、完了条件が明確である。
- 重複 task がなく、依存関係が説明可能である。

## Anti Patterns

- レイヤ別（DB 実装だけ、UI 実装だけ）に分割して価値提供が見えない task を作る。
- 「調査する」「対応する」など完了条件が曖昧な task 名・説明にする。
- 既存 task を確認せず同じ内容を再発行する。
