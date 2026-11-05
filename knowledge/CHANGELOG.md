# Knowledge Changelog

## 目的

`knowledge/` / `skills/` への変更と、その根拠になった提案・事象を追跡できるようにする。

`propose-knowledge-update` で出た提案を `apply-knowledge-update` で採否判断した結果は、必ずここに 1 エントリ残す。採用だけでなく、見送りも残す。見送り理由が残っていれば、同じ提案が再発したときに再検討の材料になる。

## 書式

新しいものを上に追加する。

```md
## YYYY-MM-DD

- 種別: adopted | rejected | deferred
- 対象: 変更した（または見送った）ファイルのパス
- 内容: 何を変えたか / 何を提案されたか（1〜3 行）
- 根拠: 元になった task ID・レビュー指摘・事象への参照
- 見送り理由: rejected / deferred の場合のみ
```

## 2026-11-05

- 種別: adopted
- 対象: knowledge/tips/github-workflow.md / skills/implement-task.md / skills/review-task.md / skills/accept-task.md
- 内容: PRのあるTaskのWorker（登録・再登録）、Reviewer（head固定・根拠コメント・必須check・merge・reviewed_taskの照合値）、Manager（merge commitでのAC確認・verification）の手順と照合失敗時の再確認を追加し、各Skillから参照する。
- 根拠: Task ded25ca7-af29-4189-aaa1-533ae98a91bc（UI-G2）、ADR 0005
