---
name: implement-task
description: 割り当てられた task を、既存構成・設計原則・実装品質を守りながらレビュー可能な状態まで実装する。
status: active
version: 6
requiredKnowledge:
  - principles/development-principles.md
  - principles/ai-native-ddd.md
  - principles/frontend-architecture.md
  - tips/task-writing.md
  - tips/verification.md
  - tips/self-review.md
  - tips/incremental-design.md
requiredTools:
  - compass:list_tasks
  - compass:claim_task
  - compass:add_task_comment
  - compass:complete_task
  - compass:release_claim
  - compass:issue_task
---

# implement-task

## Purpose

割り当てられた task を、既存構成・設計原則・実装品質を守りながらレビュー可能な状態まで実装する。

この Skill の最重要目的は、実装者が独自判断で構成を増やしすぎることを防ぎ、後続の reviewer / manager が判断しやすい最小差分を作ることである。

## Steps

1. `list_tasks` で対象 task の最新状態を確認し、`claim_task` で担当を確定する。
2. task の完了条件を `knowledge/tips/task-writing.md` に照らして再確認する。
3. `knowledge/principles/development-principles.md` を読み、変更範囲・最小差分・新規ファイル作成ルールを確認する。
4. `knowledge/principles/ai-native-ddd.md` を読み、domain / application / infrastructure / mcp / presentation の責務境界を確認する。
5. フロントエンドを変更する場合は、必ず `knowledge/principles/frontend-architecture.md` を確認する。
6. 既存の類似ファイル・類似ディレクトリ・類似コンポーネントを探し、再利用可否を判断する。
7. フロントエンドを変更する場合は、`components` `features` `app` 配下の類似画面・類似要素を最低 1 回探索する。
8. 実装前に FileChangePlan を作成し、再利用候補・採用可否・採用しない理由を必ず残す。非自明な変更では Markdown 形式の `add_task_comment` で共有する。
9. FileChangePlan の時点で最小差分が歪んだ差分になる場合（`knowledge/tips/incremental-design.md` の変更駆動トリガーに該当）は、実装に進まず、`add_task_comment` で状況を残し、必要な技術的follow-upを `issue_task` で登録してClaimを解放する。
10. FileChangePlan に沿って、最小差分で実装・テスト・リファクタリングを行う。
11. `knowledge/tips/verification.md` に従って検証を行い、実行内容と実際の結果を確認する。
12. `knowledge/tips/self-review.md` に従い、`complete_task` の前に reviewer の視点で自分の差分をセルフレビューする。
13. 実施内容・判断理由・再利用判断・検証結果・セルフレビューで気づいた点・未解決事項を Markdown 形式の `add_task_comment` で共有する。
14. レビュー可能と判断したら `complete_task` で `in_review` に進める。

## FileChangePlan

実装前に、少なくとも次を整理する。

```txt
変更目的:
- この task で達成すること

編集予定ファイル:
- path:
  理由:

再利用候補:
- path:
  採用可否:
  採用しない理由:

新規作成予定ファイル:
- path:
  理由:
  既存ファイルで代替できない理由:

触らない範囲:
- この task では変更しない領域

検証方法:
- 実行するテスト、または確認手順
```

## Implementation Rules

- 既存ファイルの編集を優先する。
- 既存コンポーネントや既存ファイルを探した結果は、再利用する場合も新規作成する場合も記録する。
- 新規ファイル・新規ディレクトリの作成は最小限にする。
- 新規ファイルを作る場合は、理由と配置根拠を説明できる状態にする。
- 新規ファイルや新規 component を作る場合は、既存ファイルで代替できない理由を明示する。
- フロントエンドでは `components` `features` `app` を探索せずに新規 UI を作らない。
- 同種 UI が 2 箇所目に出たら、共通化可否を必ず判断してコメントする。
- 再利用候補が見つからない場合は page 内で最小実装してよいが、次回同種要素が出た時点で切り出し可否を再判定する。
- 1 task で新規ファイルが 3 つ以上必要な場合は、実装を進める前に `add_task_comment` で FileChangePlan を共有する。
- コメント本文は Markdown 前提で書いてよいが、厳密な Markdown 構文検証に合わせる必要はない。
- 明示的に指示されていない限り、アーキテクチャ再構成・大規模リファクタリングを行わない。
- 構成に迷った場合は、新しい構成を作らず、既存の近い実装に合わせる。
- 判断できない場合は推測で進めず、前提・選択肢・懸念をコメントして確認する。
- `issue_task` は作業中に発見した技術的follow-upに限る。ユーザー要件やStoryの拡張、優先順位変更はmanagerへ返す。
- follow-up Taskには発見元Task、必要な理由、完了条件を記載し、現在のTaskへ混ぜて実装しない。
- 歪んだ最小差分（不自然な分岐追加、責務の合わない場所へのロジック押し込み、同じ修正の複数コピー）に気づいたら、そのまま実装せず技術的follow-upとして分離する。
- 設計の軋み（重複の 3 回目、ファイル肥大など）に気づいたが今回の task と無関係な場合は、`[design-strain]` を付けた単発 task として記録する（自分では直さない）。

## Success Criteria

- task の完了条件を満たす実装と検証結果が揃っている。
- `complete_task` 前にセルフレビューを行い、気づいた懸念がコメントに残っている、または解消されている。
- 変更理由・トレードオフ・確認手順がコメントで追跡できる。
- 新規ファイルや新規ディレクトリを作った場合、その必要性が説明されている。
- 既存探索の結果と、再利用する / しない判断理由がコメントまたは FileChangePlan で追跡できる。
- 既存構成・依存方向・命名規則に沿っている。
- reviewer が追加調査なしで確認を開始できる。

## Anti Patterns

- task を `claim` せずに作業を始め、担当状態が不整合になる。
- 完了条件を満たしていないのに `complete_task` へ進める。
- セルフレビューをせず、または型チェック/ビルド通過だけを検証扱いにして `complete_task` へ進める。
- 構造と喧嘩していると気づきながら、歪んだ最小差分を黙って積む。
- task のついでに「気づいたので」構造を変える（機会的リファクタリング）。
- 原則を無視して場当たり的に実装し、責務が崩壊する。
- 既存構成を確認せずに独自のディレクトリやファイル構成を作る。
- 再利用候補を調べた記録を残さずに、新規 component や新規ファイルを作る。
- Clean Architecture / DDD を理由に、不要な抽象・層・ファイルを増やす。
- フロントエンドで既存 feature を確認せず、新しい feature や共通コンポーネントを作る。
