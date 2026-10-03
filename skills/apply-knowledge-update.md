---
name: apply-knowledge-update
description: propose-knowledge-update で出た提案を評価し、採用する場合は knowledge / skill ファイルへ反映して changelog に記録する。
status: active
version: 2
requiredKnowledge:
  - principles/development-principles.md
  - CHANGELOG.md
requiredTools:
  - compass:list_tasks
  - compass:list_task_comments
  - compass:issue_task
---

# apply-knowledge-update

## Purpose

`propose-knowledge-update` で task comment として出された提案を評価し、採用する場合は knowledge / skill の実ファイルへ反映し、採否にかかわらず `knowledge/CHANGELOG.md` に記録する。

この Skill の目的は、提案が comment 止まりで流れることを防ぎ、knowledge を「読まれるだけの文書」ではなく「運用で改善され続ける資産」にすることである。

## Steps

1. `list_tasks` と `list_task_comments` から、未処理の knowledge 更新提案を収集する。
2. 提案ごとに、次の採用基準で評価する。
3. 採用する場合は、対象の knowledge / skill ファイルを編集する task を `issue_task` で発行するか、自身が編集権限を持つ環境なら直接反映する。
4. skill を変更した場合は frontmatter の `version` を上げる。
5. 採用・見送りのいずれも、`knowledge/CHANGELOG.md` の書式でエントリを追加する。
6. 採否と理由、提案元Task IDを `knowledge/CHANGELOG.md` に記録し、Task Commentへの追記を前提にしない。

## 採用基準

次をすべて満たす提案だけを採用する。

- 再現性がある: 一度きりの事象ではなく、同種の状況で再発しうる。
- 行動に変換できる: 読んだ agent の次の行動が変わる。精神論ではない。
- 適用条件が書ける: いつ適用し、いつ適用しないかが言える。
- 既存と矛盾しない: 既存の principles / tips と矛盾する場合は、どちらを正とするか先に決める。

## 反映先の選び方

- 全 task に常に効く判断基準 → `knowledge/principles/`
- 特定の工程（task 記述、レビュー、検証など）の実務知 → `knowledge/tips/`
- 工程の手順そのものの変更 → `skills/*.md` の Steps / Checklist
- 単発の申し送りで十分なもの → knowledge 化せず task comment のままにする

迷ったら tips に置く。principles は増やすほど 1 件あたりの重みが下がるため、principles への追加は最も慎重に行う。

## Success Criteria

- 未処理の提案が「採用・見送り・保留」のいずれかに分類され、放置されていない。
- 採用された提案が実ファイルに反映され、CHANGELOG から根拠の task まで追跡できる。
- 見送った提案にも理由が残っている。

## Anti Patterns

- 提案を評価せずに全部取り込み、knowledge が肥大化して読まれなくなる。
- 反映だけして CHANGELOG に残さず、なぜそのルールがあるか誰も説明できなくなる。
- 既存 knowledge と矛盾する追記をして、agent によって参照する正が割れる。
- 見送りを記録せず、同じ提案の評価を何度も繰り返す。
