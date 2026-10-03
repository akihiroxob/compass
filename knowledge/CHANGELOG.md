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
