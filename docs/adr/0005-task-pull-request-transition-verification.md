# ADR 0005: PRのあるTaskは完了・レビュー・受入でGitHubの事実を照合する

- 状態: 承認
- 対象: Work / Organization / Server / Role手順

## 背景

[ADR 0004](0004-task-pull-request-verification.md)で、TaskのPRはServerがGitHubで確認した事実として登録できるようになった。Worker→Reviewer→Managerが同じPR・SHAを対象に判断するには、状態遷移のたびにその事実を照合する必要がある。運用ではCIを設定しないRepositoryがあり、Worker・Reviewer・Managerが同じGitHubアカウント・tokenを共有することもある。GitHubの自己Approveはできないため、レビューの根拠に使えない。

CompassにはProject単位のGitHub workflow設定やTaskの完了方式（PR / 証跡）の区別がない。PRを作らないTask（調査・文書以外の運用・ローカルRepository）も同じWorkで扱う。

## 決定

- PRを登録したTaskを「PR運用のTask」とし、完了・レビュー・受入でGitHubの現在の事実を照合する。PRを登録していないTaskは従来の経路（照合なし・Managerの直接受入可）のままとする。Repositoryを変更するTaskでPRを登録することはRole手順で求め、Reviewerは登録のないPR運用をレビューで差し戻す。
- 照合の対象は現在のPR（登録順の最後）。GitHubの読取はSQLiteのtransactionの外で行い、保存時に現在のPR・Claim・状態を再検査する。base branchが登録時から変わったPRは照合しない。
- 完了（`complete_task`）: 現在のWork Claimで登録した、open・非draftのPRであること。現在のheadを記録し、以前のレビュー・受入の照合結果を消す。差し戻し後は同じPRを新しいWork Claimで再登録する。
- レビュー（`reviewed_task`）: Reviewerはレビューしたhead SHA（`expectedHeadSha`）とレビュー根拠のPRコメント（`reviewCommentId`）を渡す。PRがそのheadのままmergeされ、コメントが`<!-- compass-task-review: {"taskId","claimId","headSha","decision":"approve"} -->`の印で現在のTask・Review Claim・headを承認していることを照合する。コメントの作成者は照合しないため、同じGitHubアカウントでも根拠を残せる。GitHubのApproveは要求しない。mergeはReviewerがGitHubで行い、ServerはGitHubへ書き込まない。
- 必須CIはProject RepositoryのrequiredChecks（check run名・commit statusのcontext）で指定する。既定は空で、空ならCI結果を読まず必須にしない。指定があればレビューしたheadでそのcheckだけが成功していることを求める（同じ名前が複数あればすべて成功）。指定外のcheckの結果は条件にしない。requiredChecksはRepositoryの属性としてOrganizationが所有し、Project更新で省略した既存Repositoryは値を維持する。
- 受入（`accept_task`）: `reviewed_task`で照合したheadのままmergeされていること。Managerはmerge commitでACを確認し、照合したmerge SHAと根拠（`verification`）を渡す。現在のmerge SHAと一致する場合だけ受け入れ、merge SHAと根拠をPRの記録へ残す。Human operatorの受入はレビュー済みの現在のmerge SHAを記録する。PRのあるTaskは`in_review`から直接受入へ進めない。
- 照合の失敗は`error.details`に操作・Task・PR（Repository・番号・URL）・期待した / 実際のSHA・state・不足したcheck・再確認方法を返す。GitHubを読めない失敗（`GITHUB_UNAVAILABLE`、retryable）は最後に確認した事実を添え、何も記録しない。同じ`requestId`の再送は受付記録があればGitHubを読まずに記録済みの結果を返す。
- 状態遷移のChange（`TASK_COMPLETED`・`TASK_REVIEWED`・`TASK_ACCEPTED`）に照合したPRの事実（head / merge SHA・state）を残す。

## 影響

- MCPの`reviewed_task`は`expectedHeadSha`・`reviewCommentId`、`accept_task`は`verification`を任意入力に持つ。PRのあるTaskでは必須になる。`list_task_pull_requests`はレビュー・受入の照合結果も返す。
- Project RepositoryはrequiredChecksを持つ（Web API・MCPの`create_project` / `update_project`）。Web UIでの入力欄はProject設定のUIとして別に扱う。
- 製品Ralphは実行基盤を移植せず、起動したAgentがRole Contextの手順でPR作成・レビュー根拠のコメント・mergeを行う。現行の契約は[実装状況](../implementation-status.md#executionの現行契約)、手順は`knowledge/tips/github-workflow.md`に記す。
