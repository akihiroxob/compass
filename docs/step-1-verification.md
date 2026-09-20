# Step 1 検証記録

検証日: 2026-09-19

## 自動検証

| Command | Result |
| --- | --- |
| `npm test` | 成功、16 tests |
| `npm run typecheck` | 成功 |
| `npm run lint` | 成功（現時点ではserver/frontendのTypeScript検査） |
| `npm run build` | 成功、React SPAを`public/`へ生成 |
| `git diff --check` | 成功 |
| `npm audit` | 0 vulnerabilities |

テストでは次を確認した。

- Project aggregateの全項目、子要素順序、同じIDがSQLiteのclose/reopen後も保持される
- 空のname / mission、不正URLを共通validationが拒否する
- 存在しないProjectを`NOT_FOUND`として区別する
- Web APIで作成したProjectをMCPから参照できる
- MCPで作成したProjectをWeb APIから参照できる
- MCPのtool一覧と正常・異常応答
- フロントエンドのエラー分類（入力エラー / not found / その他）。issue pathの項目名・行番号への対応、500・非JSON応答・接続失敗を入力エラーにしないこと

## production起動と再起動

次の構成で`npm start`を実行した。

```bash
PORT=51998 \
COMPASS_DB_PATH=/tmp/compass-step1-verification-20260919-a.db \
npm start
```

1. `POST /api/projects`から、すべてのProject項目を持つProjectを作成した。
2. 返却されたIDは`de340b6c-74cb-4ae3-aacb-1f262a301a6a`だった。
3. serverを停止し、同じcommandとDB pathで再起動した。
4. `GET /api/projects/:id`が同じID・内容・子要素IDを返した。
5. MCP `get_project`も同じ内容を`structuredContent`として返した。
6. `/projects/:id`がSPAのHTMLを返した。

これにより、Web / API / MCPの同時提供と、process再起動をまたぐSQLite永続化を確認した。

## 画面確認手順

```bash
npm install
npm start
```

1. `http://localhost:51800/`を開き、空状態から「Projectを作成」を選ぶ。
2. name、missionと任意項目を入力する。Principles、Constraints、Repositories、Resourcesは複数追加できる。
3. 作成後の詳細画面で入力内容を確認する。
4. 空白だけのProject名や、空のPrinciples行を追加したまま送信し、エラー一覧に項目名・行番号と理由が表示され、該当入力が強調されることを確認する。
5. 一覧へ戻り、cardにProject名、説明、Missionが表示されることを確認する。
6. browser幅を700px未満にし、form・詳細・cardが1 columnになることを確認する。
7. Tab / Shift+TabとEnterだけで入力、追加・削除、送信、画面遷移ができることを確認する。

## Project編集の検証

検証日: 2026-09-20（Task 11）

| Command | Result |
| --- | --- |
| `npm test` | 成功、27 tests（編集で追加: use case 7、Web API/MCP 2、フォーム初期値 2） |
| `npm run typecheck` | 成功 |
| `npm run lint` | 成功（TypeScript検査） |
| `npm run build` | 成功 |
| `git diff --check` | 成功 |

`npm audit`は依存関係を変更していないため再実行していない。

テストでは次を確認した。

- 更新後もProject IDと`createdAt`が変わらず、DBのclose/reopen後も保持される
- 未指定項目は変更されず、`null`・空文字でdescription / visionだけがクリアされる。配列は`[]`で全削除できる
- Repository / Resourceは既存`id`で行が維持され、追加・修正・削除・並べ替えが保存される
- 他Projectの子`id`を指定しても奪わず、新しい行として追加し、他Projectを変更しない
- 空白のname、空のmission、不正URL・file URL、空のPrinciple、`id`重複、件数超過、更新項目なし、null・配列bodyを拒否し、既存データを変更しない
- 存在しないIDは`NOT_FOUND`、入力違反は`VALIDATION_ERROR`（項目path付き）で区別される
- 子要素の保存に失敗した更新は、親の項目・Principles・Repositoriesを含め何も変更しない（trigger で強制した失敗の rollback）
- Web API `PATCH`の更新がMCP `get_project`に、MCP `update_project`の更新がWeb APIに反映され、両者が同じ入力規則と404を返す。不正JSON・空bodyは400
- 編集フォームの初期値が、未設定を空欄にし、子要素の`id`を保持し、元のProjectと配列を共有しない

production起動（`PORT=51997`、一時DB）で、`POST` → `PATCH`（Web）→ `update_project`（MCP）→ 不正`PATCH`（400）→ `/projects/:id/edit`（SPAとして200）→ サーバー再起動 → `GET`の順に確認した。更新内容、クリアした値、維持されたRepositoryの`id`が再起動後も保持されていた。検証用サーバーは自分が起動したPIDだけを停止した。

### 編集の画面確認手順

1. `npm start`で起動し、詳細画面の「Projectを編集」を選ぶ。既存の値と複数の子要素がフォームに入っていることを確認する。
2. 名前・Mission・Principlesを修正し、Repositoriesを1件削除・1件追加して「変更を保存」する。詳細へ戻り、一覧・詳細に反映されていることを確認する。
3. 説明・Visionを空にして保存し、詳細で「未設定」になることを確認する。
4. 編集中に「キャンセル」を選び、詳細が保存済みの内容のままであることを確認する。
5. Project名を空白だけにする、Principlesの空行を残す、Repositoryのurlを不正にして保存し、項目名・行番号付きのエラーと該当入力の強調を確認する。
6. server停止中などで保存に失敗させ、「保存に失敗しました」の表示と入力内容の維持を確認する。存在しないIDの`/projects/<id>/edit`で「Projectが見つかりません」が出ることを確認する。
7. Tab / Shift+TabとEnterだけで、編集・行の追加削除・保存・キャンセルができること、700px未満で1 columnになることを確認する。

## 未実施と既知の制限

- 実ブラウザでの目視、keyboard操作、responsive表示の確認は、作成・編集画面とも未実施（Step 1の検証時と、Task 11の実装時のどちらも、この実行環境から実ブラウザを操作していない）。編集画面のフォーカス移動・`aria-invalid`・focus表示も、実装とtypecheck/buildのみで、画面上では未確認。CSS media query、label、標準HTML form control、focus表示は実装し、frontend typecheckとbuildは成功している。
- Project削除・archiveはStep 1の範囲外（archiveの設計は[step-5-project-archive-design.md](step-5-project-archive-design.md)で確定済み、実装は未着手。物理削除は作らない）。編集は追加機能として実装済み（上記「Project編集の検証」）。同時編集の検出（楽観ロック）はなく、後から保存した内容が反映される。
- Intent、Outcome、Wacha実行状況は未実装で、画面には表示していない。
- 認証はまだ導入していない。trusted local環境での利用を前提とする。

Step 2（Intent）は、ユーザーの画面確認や仕様合意を待たずに、[docs/step-2-intent-design.md](step-2-intent-design.md)の初期仕様で着手し、実装済み（検証結果は同文書）。上記の未実施項目は別の検証事項として残し、完成後のフィードバックに応じて修正する。
