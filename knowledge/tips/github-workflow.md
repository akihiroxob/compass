# GitHubのPRを使うTaskの進め方

Repositoryを変更するTaskでは、Taskごとにbranch・PRを作り、Compassに登録したPRとSHAを対象にWorker→Reviewer→Managerが判断する。PRを登録したTaskは、完了・レビュー・受入のたびにServerがGitHubの現在の事実を照合する（ADR 0005）。PRを登録していないTaskは照合されない。Repositoryを変更したのにPRを登録しない運用はしない。

GitHubのアカウントとCompassのPrincipalは別の概念である。Worker・Reviewer・Managerが同じGitHubアカウント・tokenを使ってもよいが、Compassでは別Principalで操作し、自己レビュー・自己受入はできない。GitHubのApproveは使わない。

## Worker

1. Projectに登録したGitHub Repository（Storyに`repository`があればそれ）でbranchを作り、実装・検証・文書更新を行う。
2. open・非draftのPRを作り、現在のWork Claimで`register_task_pull_request`する。PRを更新したら、完了前に同じPRを再登録してもよい。
3. 実装と検証結果を`add_task_comment`し、`complete_task`する。Serverは現在のWork Claimで登録したopenのPRかを確認し、現在のheadを記録する。
4. Reviewerに差し戻された場合は同じopen PRを修正し、新しいWork Claimで同じPRを再登録してから完了する。Managerに差し戻された場合（merge済み）は、最新の統合先branchから新しいPRを作って登録する。

## Reviewer

1. `list_task_pull_requests`の`current`のPRとhead SHAを確認し、そのheadの差分と検証結果をレビューする。ローカルの未送信commitを根拠にしない。
2. Repositoryの`requiredChecks`（`get_project`の`repositories[]`）を確認する。空ならCIは必須ではない。指定があれば、レビューしたheadでそのcheckだけが成功していることを確認する。CIの未完了・失敗を成功として扱わない。
3. 承認するときは、判定と根拠を書いたPRコメントに次の印を入れて投稿する（作成者がWorkerと同じGitHubアカウントでもよい）。

   ```text
   <!-- compass-task-review: {"taskId":"<Task ID>","claimId":"<現在のReview Claim ID>","headSha":"<レビューした40桁のhead SHA>","decision":"approve"} -->
   ```

4. GitHubでPRをmergeする。レビューしたheadと異なるheadをmergeしない（例: `gh pr merge <number> --merge --match-head-commit <head SHA>`）。
5. `reviewed_task`に`expectedHeadSha`（レビューしたhead）と`reviewCommentId`（4のコメントID）を渡す。Serverはmerge・head・コメント・必須checkを照合する。
6. mergeに失敗した（競合・branch保護）、レビュー後に新しいheadがpushされた、CIが失敗した場合は、`reviewed_task`へ進めない。Workerの修正が必要なら`reject_task`で差し戻し、修正後の新しいheadを改めてレビューする。古いhead・古いReview Claimのコメントを流用しない。

## Manager

1. `list_task_pull_requests`の`current`で、レビュー済みhead（`reviewedHeadSha`）とmerge SHA（`mergeSha`）を確認する。
2. merge commitを対象にTaskのACと統合後の動作を確認する。Reviewerの承認やmerge済みであることだけを根拠にしない。
3. `accept_task`の`verification`に、確認したmerge SHAとACごとの根拠（`evidence`）を渡す。Serverはレビュー済みheadのmerge SHAと一致する場合だけ受け入れる。
4. PRのあるTaskは`in_review`から直接受け入れられない。Reviewerのレビューを待つ。

## 照合の失敗と再確認

- 照合に失敗した結果は`error.details`に、操作（`operation`）・Task・PR・期待した / 実際のSHA・state・不足したcheck・再確認方法（`recheck`）を持つ。`recheck`に従って次の操作を選び、包括的な文言だけで停止しない。
- `GITHUB_UNAVAILABLE`（retryable）はGitHubを読めず何も記録していない。復旧後に同じ入力・同じ`requestId`で再送する。応答が失われた場合も同じ`requestId`で再送すれば、記録済みならGitHubを読まずに同じ結果が返る。すでにmerge済みのPRを再mergeしない。
- `GITHUB_ACCESS_DENIED`・`PULL_REQUEST_NOT_FOUND`は再送で解消しない。Repository・PR番号・ServerのGitHub設定を確認し、解消できなければ理由を残して`reject_task`または`release_claim`する。
- 受入済みのTask・PRのmerge・公開・Outcomeの効果は別の事実として扱う。
