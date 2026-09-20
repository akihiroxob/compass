# Role Policy

## 目的

この文書は、Compass の MCP における Principal と Project Role の共通運用を定義する。Role ごとの手順は `agent/<role>.md` を正とする。設計の詳細は `docs/step-4-strategist-role-design.md` を参照する。

現在配信している Role は `strategist` だけである。

## 基本方針

- Principal は `Authorization: Bearer <AgentName>` から得る。tool 入力の `role` や `principalId` を認証情報として使わない
- Role Grant は Principal と Project の組に永続化する。Grant は「この Principal がこの Project でその Role として振る舞ってよい」という認可の記録である
- Role は選択・切替する状態ではない。各 tool が必要な Role を、呼び出しごとに Grant で検査する
- Grant は Agent の起動、Run の所有、Agent の生存確認を意味しない。起動条件の監視と Agent の実行は外部 Runtime の責務であり、Compass は行わない
- Grant の発行・取消・一覧は MCP tool にない。Agent は自分の権限を増やせない。権限が足りないときは自己拡張を試みず、報告して停止する
- Role は Project 単位で判断する。別 Project の Grant は使えない

## 認証と信頼境界

- Bearer の値はそのまま Principal になる（trusted-local）。秘密の検証はなく、セキュリティ境界ではない
- `Authorization` が有るのに形式が不正な場合、`/mcp` は HTTP `401` で拒否する。anonymous へ黙って降格しない
- `get_role_instructions` は静的な文書の取得であり、Bearer も Grant も要らない

## エラー

| code | 意味 | Agent の動き |
| --- | --- | --- |
| `UNAUTHENTICATED` | Role が必要な tool を Bearer なしで呼んだ | Bearer を設定できないなら報告して停止する |
| `FORBIDDEN` | 対象 Project の Grant が無い（別 Project・取消済み・存在しない Project を区別しない） | 権限の自己拡張を試みず、報告して停止する |
| `VALIDATION_ERROR` | 入力が規則に反する | `issues` を読んで入力を直す |
| `NOT_FOUND` / `CONFLICT` | 対象が無い、または現在の状態で許されない | 状態を再取得して判断する |
| `INSTRUCTION_UNAVAILABLE` | Instruction ファイルを読めない | 推測で代替せず、報告して停止する |

## 通常フローと人の関与

- 通常フローに Human の確認・承認・画面操作を置かない。Agent は Instruction、Context、tool の結果だけで判断し、実行する
- Web UI は人が観察し、必要なら同じ処理を手で使う任意の入口である。Agent の完了条件にしない
- 情報が足りないときは、人への確認を工程にせず、不足を作業報告として明示する

## 実装状況の扱い

- 未実装の入力（Research、Evaluation、Evidence）を存在するものとして扱わない。`get_strategist_context` の `unavailable` に挙がる項目は特にそうである
- 実装済み・未接続・未検証を区別して報告する。模擬した実行を自律運転の実証として報告しない

## 変更履歴

Grant の変更と Outcome の変更は、保存された Project・Intent・Outcome と各 tool の応答で確認する。専用の Change Log や監査ログは現時点で無い。
