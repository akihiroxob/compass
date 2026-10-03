---
name: design-review
description: 蓄積した設計の歪みシグナルを評価し、必要なら準備リファクタリングや再設計の Story / Task を起こす。
status: active
version: 2
requiredKnowledge:
  - principles/development-principles.md
  - tips/incremental-design.md
  - tips/story-splitting.md
requiredTools:
  - compass:list_tasks
  - compass:list_task_comments
  - compass:list_stories
  - compass:issue_story
  - compass:issue_task
  - compass:edit_task
  - compass:cancel_task
---

# design-review

## Purpose

worker / reviewer が記録した設計の歪みシグナル（`[design-strain]` task と task comment）を評価し、再設計するかを判断する。

弱い実行はセンサー、判断は manager に集約する。歪みの観測は誰でもできるが、「本当に再設計すべきか、どのスコープで」は判断密度が最も高い仕事であり、機会的な実行に委ねない。

## 実施タイミング

- Story を `complete_story` する時
- 同一領域に `[design-strain]` シグナルが 3 件たまった時
- worker から準備リファクタリングへの分割提案（変更駆動トリガー）が来た時

## Steps

1. `list_tasks` で `[design-strain]` の付いた task を収集し、対象領域ごとに束ねる。
2. 各シグナルの根拠（元 task、対象ファイル、観測事実）を `list_task_comments` で確認する。
3. `knowledge/tips/incremental-design.md` の「再設計しない条件」に照らし、対応不要のシグナルTaskは理由付きで `cancel_task` する。
4. 再設計するものは、スコープ・触らない範囲・壊してはいけない挙動・characterization テストの範囲を明記した Story を `issue_story` で起こし、task に分解する。
5. 変更駆動（準備リファクタリング）の提案は、①挙動不変のリファクタリング task ②本来の変更 task の 2 つに分割して発行し、①→②の順序を明記する。
6. 採用したシグナルTaskも、作成したStoryまたはTaskを理由に含めて `cancel_task` し、二重着手を防ぐ。保留は `edit_task` で判断に必要な条件をdescriptionへ追記する。

## 採用基準

次を満たすシグナルだけを再設計 Story にする。

- 変更が困難になっている具体的な証拠がある（歪んだ差分の実例、reject の反復、行数の推移）
- 次に予定される変更がその領域に触れる
- characterization テストで現行挙動を固定できる見込みがある

## Success Criteria

- 収集したシグナルが「Story 化 / 見送り / 保留」に分類され、放置されていない。
- 再設計 Story に、壊してはいけない挙動とテスト方針が書かれている。
- 見送り・保留の理由がシグナル元の task に返されている。

## Anti Patterns

- 美しさを理由に、変更困難の証拠がない再設計 Story を起こす。
- 振る舞い変更と構造変更を同一 task に混ぜて発行する。
- シグナルを溜めたまま判断せず、worker が歪んだ最小差分を積み続ける状態を放置する。
- 再設計の要否判断を worker の機会的判断に委ねる。
