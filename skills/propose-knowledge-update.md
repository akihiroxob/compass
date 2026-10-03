---
name: propose-knowledge-update
description: 実装・レビューで得た学びを再利用可能な知識として整理し、knowledge 更新提案を作成する。
status: active
version: 3
requiredKnowledge:
  - principles/development-principles.md
  - tips/reviewing.md
requiredTools:
  - compass:list_tasks
  - compass:list_task_comments
  - compass:add_task_comment
  - compass:issue_task
---

# propose-knowledge-update

## Purpose

実装・レビューで得た学びを再利用可能な知識として整理し、knowledge 更新提案を作成する。

## Steps

1. `list_tasks` と `list_task_comments` から、再発しやすい課題や有効だった実践を抽出する。
2. `knowledge/principles/development-principles.md` と照合し、原則化できる内容を選別する。
3. `knowledge/tips/reviewing.md` の観点で、再現性・検証可能性・副作用を確認する。
4. 提案を「背景 / 提案内容 / 適用条件 / 期待効果 / リスク」の形式でまとめる。
5. 対象Taskの現在のClaimを所有している場合は、元になったtaskやレビュー指摘への参照を添えて `add_task_comment` で提案を共有する。Claimがない場合は、同じ内容を技術的follow-upとして `issue_task` で登録する。
6. 採用可否の判断に必要な追加検証項目があれば明記する。
7. 提案の採否判断と反映は manager が `apply-knowledge-update` で行う。過去の採否は `knowledge/CHANGELOG.md` にあるため、同種の見送り済み提案がないか先に確認する。

## Success Criteria

- 提案が具体的で、次回以降の行動に変換可能である。
- どの事象から得た知見か追跡できる。
- 原則との整合性と適用範囲が明確である。

## Anti Patterns

- 単発の事象を一般化しすぎて、適用条件がないルールを作る。
- 既存 knowledge と重複した提案を比較なしで出す。
- 根拠リンクや task 文脈を示さずに抽象論だけを追加する。
