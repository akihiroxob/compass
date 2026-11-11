# Workers + D1対応の変更説明

この文書は今回の変更をレビューするための資料。配置方法の正本は[Workers + D1への配置](../cloudflare-deployment.md)、対応範囲と確認状況は[対応計画](cloudflare-d1.md)を参照する。

## 何ができるようになったか

CompassのWeb UI・Web API・MCPをCloudflare Workersで動かし、DBとしてD1を使うための実装を追加した。普段のローカル開発で使うNode＋SQLiteは維持している。Ralph・OrchestratorをWorkersへ移す変更ではなく、両者が接続するServerの配置先を追加する変更になる。

HumanはGoogle認証でログインし、Agent／RuntimeはCompassで発行したCredentialで接続する。Role・Skill・Knowledge・Policyは、そのときデプロイした内容を配信する。

## なぜRepositoryの追加だけで済まなかったか

SQLiteでは「読む→業務判断→複数の更新」を一つのtransactionで実行できる。D1は同じ形式のcallback transactionを提供しないため、DBの接続先だけを変えると、同時Claimや相談・Taskの一括作成で整合性を失う。

そこで、既存のDomain／Applicationの判断を使いながら、D1側では「読んだ条件が変わっていないことの検査」と「関連する更新」を一つのbatchで確定するようにした。途中の保存に失敗した場合は全体を巻き戻す。単にtransactionを無効化したり、Worker内のロックだけで排他したりする方式にはしていない。

## 主な変更

| 対象 | 内容 | 利用者への意味 |
| --- | --- | --- |
| 起動 | Node用とWorkers用の起動処理を分離し、WorkersではD1実装を注入 | ローカル開発を残してリモート配置できる |
| Organization | Workspace・Project・所属・archiveのD1保存 | 組織情報と関連履歴が途中まで保存されない |
| Access | Human登録・Session・Googleログイン試行・Membership・Grant・Credential・招待のD1保存 | 同時操作でも最後のowner保護・一度限りの処理・scope認可を維持 |
| Direction | Intent・Outcome・Target・Research・Decision・ADR・評価・観測・Runtime eventのD1保存 | 子要素・履歴・Activityを含めて一貫して記録 |
| Work | Task・Story・Claim・PR・公開記録・ReceiptのD1保存 | 同時Claimを防ぎ、通信断後も同じIDで結果を照合できる |
| Collaboration | 相談・応答lease・結論・文書反映依頼・成果物参照のD1保存 | 相談から作るTaskやActivityをまとめて確定 |
| Activity | 明示記録・訂正・重複防止をD1へ接続 | 同じ送信の再試行で記録が増殖しない |
| 文書配信 | Agent向けMarkdownをbuild時にbundleへ同梱 | filesystemやGitの実行に依存せず、配置した文書を返す |
| migration | 共通SQLとD1用SQLからWrangler向け配布物を生成し、明示コマンドで適用 | 起動が勝手にDB構造を変更しない |
| 実行互換性 | Workersのfetch呼出形式・redirect指定・静的配信を調整 | Google認証・GitHub照合・SPA配信を実ランタイムで動作させる |

D1専用Adapterは主に`server/src/infrastructure/repository/d1/`、接続・batch基盤は`server/src/infrastructure/database/d1/`、配線は`server/src/bootstrap/d1*Infrastructure.ts`に置いている。Contextをまたぐ保存計画の合成はServerが担当し、業務判断は既存Applicationに残している。

## 承認コマンドで行ったこと

- テスト用のHTTPサーバー・workerd・ローカルD1を起動し、テスト終了後に停止した。
- Web UIとWorkerをビルドした。Wranglerのdry-runはアップロードしない検査。
- `db:migrate:d1:local`で、Repository内の`.wrangler/`にあるローカルD1へSQLを適用した。既存のNode開発用SQLiteやリモートD1への適用ではない。
- 関連テスト・型チェック・lintを実行した。
- 意味のある単位でローカルコミットした。

ローカルのサーバー起動とGit管理領域への書込みがsandboxの制限対象になるため、検証・コミットの際にも実行承認が必要になった。

これらの承認はCloudflare本番への配置やGitHubへのPushではない。Push・remote migration・実デプロイ・実Googleアカウントでのログインは実施していない。

## 確認した重要な動作

- 同じTaskへ同時にClaimしても所有者は一人になる。
- 同じrequest IDの再送・同時送信でTask／Claim／Activityを重複生成しない。
- Claimの期限切れ・更新・解放・再取得と、自己レビュー／自己受入禁止を維持する。
- 保存直前のGrant失効・Project archive・Outcome Target解除を検出する。
- Receiptや相談の保存を故意に失敗させると、関連するTask・Claim・Change・Activityも巻き戻る。
- commit後に通信断した場合、無条件に書き直さず同じrequest IDで受付済み結果へ戻れる。
- 相談の同時返信・古い版の応答拒否・応答leaseの排他／期限／更新・解決／取消を維持する。
- Workspace相談の明示引継ぎと、受入済みWorkの証跡に一致する成果物参照だけを保存する。
- migration未適用で起動してもschemaを自動作成しない。
- 実際の配布bundleをworkerdで実行し、UI、署名付きOIDC fixtureによるログイン、Human API、Credential発行、MCPのClaim・PR登録・Role Context取得、Runtime Credentialの公開記録APIと再送を確認した。

Google・GitHubの通信先は自動テスト用fixture。実サービスとの接続確認やエージェントの自律運転の実証とは分けている。

## 検証結果

| 検証 | 結果 |
| --- | --- |
| Server全テスト（Node・SQLite・D1・HTTP・MCPを含む） | 765件成功、失敗0・skip0 |
| Workパッケージの業務規則・GitHub adapter | 61件成功 |
| Repository横断の結合テスト（migration・Workersを含む） | 30件成功 |
| 公開記録APIの検証を追加した後のWorkers bundle通しテスト | 成功 |
| 全workspaceと保守CLIの型チェック | 成功 |
| lint・UI構造検査 | 成功 |
| Workers／Web UIのbuild | 成功。UIのchunkサイズ警告あり |
| Wrangler設定によるローカルD1への明示migration | 成功 |

## 主なローカルコミット

| Commit | 内容 |
| --- | --- |
| `c67b87d` | D1 migrationの配布準備 |
| `957cce5` | 読取前提を検査するD1保存計画 |
| `143d334` | WorkのD1一括保存 |
| `1a6c333` | ActivityのD1保存 |
| `e62479b` | 相談・文書反映Taskの共通保存 |
| `7804bf6` | Workspace引継ぎ・保存直前競合の回帰テスト |
| `8af9d41` | Workers起動・資産bundle・実ランタイム検証 |

Organization・Access・Directionの各D1対応は、この前のコミット群に分けている。全体の対象は上の「主な変更」の表を参照する。

## 配置するために残っているもの

1. CloudflareのD1を作成し、`wrangler.jsonc`の仮IDを実IDへ置き換える。
2. 公開origin・Google OAuthクライアント・初期owner email・Secretを設定する。
3. remote migrationを明示適用する。
4. mainを対象とするWorkers Buildsを接続し、配置後の実環境でログインとMCP操作を確認する。

大量データ・大きい本文でのD1上限は、通常操作の正しさとは別の負荷検証になる。ローカルworkerdでの成功だけで実環境の容量・時間・課金上限まで保証したとは扱わない。
