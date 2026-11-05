# ADR 0004: TaskのPRはServerがGitHubで確認した事実として保持する

- 状態: 承認
- 対象: Work / Server

## 背景

Repositoryを変更するTaskでは、Worker→Reviewer→Managerが同じPRとSHAを対象に判断する必要がある。既存の受入成果物（`accept_task`の`deliverables`の`pullRequestUrl`）は、Managerが確認した参照をそのまま保存するもので、ServerはGitHubに問い合わせない。この参照だけでは、PRが実在し、対象Repositoryに属し、openであったことを区別できない。GitHubは外部システムで、応答なし・失敗・応答の消失が起こる。

## 決定

- TaskのPRはWorkが所有する。Workerは現在のWork Claimで、Projectに登録したRepositoryとPR番号を指定して登録する。ServerがGitHubからPRを読み、そのRepositoryのopenでdraftでないPRだけを保存する。保存する値はGitHubで確認した番号・URL・state・head / base・mergeの事実と確認時刻とし、Agentの入力した値を事実として扱わない。
- 受入成果物の`pullRequestUrl`、CommentのURL等の参照は、GitHubで確認したPRとして扱わない。
- 同じGitHub PRは1つのTaskだけに属する。Taskの登録順の最後を現在のPRとし、現在のopen PRがある間は別のPRを登録しない。確認の履歴はChange Logに残し、canonical Activityにはしない。
- GitHubの読取は読取専用のportとadapterで行い、SQLiteのtransactionの外で実行する。Claim・状態・登録済みPRは保存時に再検査する。
- GitHubの応答は実行時に型を検証してから事実へ変換する。型不正・欠落した応答を既定値で補わず、GitHubを読めなかった場合と同じく扱う。
- 失敗を「GitHubを読めず何も保存していない（retryable）」と「確定した拒否（権限・存在・条件）」に分ける。通信断で結果が不明なら、同じ入力・`requestId`で再送する。受付記録があればGitHubを読まずに保存済みの結果を返す。
- GitHubの認証情報はServerの環境に置き、Tool入力・結果・記録へ出さない。

## 影響

- MCPは`register_task_pull_request`・`list_task_pull_requests`を公開する。Human向けのPR表示は別のUI Taskで同じapplication層へ接続する。
- 完了・レビュー・受入の際のPR / SHAの照合、CIの必要条件、Role手順への接続は[ADR 0005](0005-task-pull-request-transition-verification.md)で、この記録を前提に行う。
- 現行の契約は[実装状況](../implementation-status.md#executionの現行契約)に記す。
