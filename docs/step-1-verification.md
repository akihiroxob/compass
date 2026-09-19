# Step 1 検証記録

検証日: 2026-09-19

## 自動検証

| Command | Result |
| --- | --- |
| `npm test` | 成功、8 tests |
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

1. `http://localhost:51743/`を開き、空状態から「Projectを作成」を選ぶ。
2. name、missionと任意項目を入力する。Principles、Constraints、Repositories、Resourcesは複数追加できる。
3. 作成後の詳細画面で入力内容を確認する。
4. 一覧へ戻り、cardにProject名、説明、Missionが表示されることを確認する。
5. browser幅を700px未満にし、form・詳細・cardが1 columnになることを確認する。
6. Tab / Shift+TabとEnterだけで入力、追加・削除、送信、画面遷移ができることを確認する。

## 未実施と既知の制限

- この実行環境では利用可能なbrowser接続が0件だったため、実ブラウザでの目視、keyboard操作、responsive表示の確認は未実施。CSS media query、label、標準HTML form control、focus表示は実装し、frontend typecheckとbuildは成功している。
- Project編集・削除・archiveはStep 1の範囲外。
- Intent、Outcome、Wacha実行状況は未実装で、画面には表示していない。
- 認証はまだ導入していない。trusted local環境での利用を前提とする。

Step 2は、上記手順によるユーザーの画面確認とIntent仕様の合意後に着手する。
