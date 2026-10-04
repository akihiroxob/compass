# Wacha Skillの配布方法に関する改善メモ

検討中の運用案。採用・実装済みの仕様ではない。

## 目的

Wachaの受入など、複数のMCP操作と製品判断を伴う手順を、CodexとClaudeが依頼時に発見しやすくする。MCPの`get_skill_context`を自発的に呼ぶことだけに手順の発見を依存させない。

## 提案する責務分担

| 置き場所 | 担うもの |
| --- | --- |
| Codex / ClaudeのSkill | 発火条件、MCP操作の順序、判断基準、確認できない場合の停止条件 |
| Wacha MCP | 現在のStory・Task・Comment・Change Log、Claim、受入・差戻しなどの認可付き操作 |
| Compassの文書 | Project固有の正本、実装状況、未確定事項 |

まず`accept-task`を対象にする。手順の本文はGitで一元管理し、Codexの`.agents/skills/`とClaudeの`.claude/skills/`へ配布する方法を決める。複製する場合は内容の差分を検査し、Wachaの`get_skill_context`にも同じ手順を残す期間は正本と更新方法を明示する。

## `accept-task`に必要な内容

- 発火条件: 「受入待ちを確認」「アクセプトを進める」「Taskを受け入れる」など。確認だけの依頼では、受入操作の指示があるかを区別する。
- 受入前の必須確認: 対象Taskと親Storyの完了条件、ユーザーの最新指示、`AGENTS.md`と主要設計資料、Worker / Reviewerの報告、関連する最新Change Log、実際の差分・動作。
- 判断: Task単体の充足と親Story・Project全体の整合を別々に評価する。Reviewer承認やテスト成功だけで受け入れない。親Storyの完了条件と現況文書が食い違う場合は、その場で受入を止めて扱いを決める。
- 操作: `list_tasks`、`list_stories`、`list_task_comments`、`list_changes`で証拠を集め、判断後に`claim_acceptance`、`accept_task`または理由と再受入条件を付けた`reject_task`を呼ぶ。判断を中断する場合はClaimを解放する。
- 結果報告: 受入・差戻ししたTask、根拠、未検証事項、親Storyの状態変化を区別して伝える。

## 導入と検証

1. Wacha側の既存`accept-task`とKnowledgeを基に、Codex・Claude共通の手順を作る。製品固有の現在値やTask IDはSkillに固定しない。
2. 両環境でSkillが一覧に現れることと、上記の間接的な依頼で発火することを確認する。明示呼出し時と「内容を確認」だけの依頼も試す。
3. 受入前に親Story・最新Change Logを読まない場合、または未接続・未検証を完了扱いする場合は失敗とする評価例を用意する。
4. Wacha MCPの認可・状態遷移検証は維持する。Skillは判断手順を補助し、サーバー側の強制を代替しない。

Codex / Claude双方で発見・実行を検証できた後、MCPからのSkill本文配信を続けるかを決める。
