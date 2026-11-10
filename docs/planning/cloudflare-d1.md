# Workers + D1対応計画

## 完了条件

Node＋SQLiteの開発起動・明示migration・業務規則を維持し、別のWorkers起動経路でWeb UI・API・MCPを提供する。D1用Repositoryは既存のDomain/Application契約を実装する。D1 migrationは明示実行とし、アプリ起動時に適用しない。認可・Claim・自己レビュー/自己受入禁止・受付記録・Activityとの一貫性を維持する。ローカルコミットまで実施し、Pushは改めて許可を得る。

## 保存処理

D1の`batch()`で、SQL前提条件・更新・関連履歴を一括確定する。事前の読取だけを根拠に更新せず、読んだ版・状態・認可などの必要条件をbatch内で再検査する。前提不成立時の再読取・業務判定はRepository/Applicationに置く。通信エラーを競合扱いで無条件再実行しない。Command Receiptのある操作は同じrequest IDで成否を照合する。

D1にcallback transactionはない。Node用のtransactionをno-opに置き換えたり、リクエストをJSのロックで直列化するだけで原子性を保証したりしない。D1専用Repositoryを追加し、SQLite実装は維持する。

## 実装状況

- 実装・単体検証済み: Agent資産の共通解析と埋め込みAdapter、HTTPへの静的配信注入、D1 Kysely Dialect、D1原子的batch基盤。
- D1ローカル検証済み: 共有初期schema、パラメータ保持・RETURNING、callback transactionの拒否、競合更新の排他、SQL失敗時のロールバック。
- Organization実装・ローカルD1検証済み: Workspace／Projectの作成・参照・更新・archive。作成者Membership、ProjectのADR参照保護、archive Activityを同じbatchへ配線する。Workersの起動経路は未接続。
- 未実装: Access・Direction・Work・Collaboration・ActivityのD1 Repository／Unit of Work、D1向けmigration配布コマンド、資産bundle生成、Workers Bootstrap・起動・Wrangler設定、Google認証・Agent Credentialを通すWorkers上の通し検証、デプロイ文書。

D1原子的batchの前提検査は`database/d1/atomic-guards.sql`のCHECK制約を使う。前提不成立を例外にしてbatch全体を巻き戻し、成功時は検査行を同じbatchで削除する。このSQLのデプロイ用migrationへの組込みは未実装。

## Repository対応の単位

1. Organization: Workspace・Project・子要素・作成者Membership・archive Activityの一括保存。
2. Access: Human登録・Session・OIDC attempt・Membership（最後のowner保護）・Grant・Credential・招待・Agent実行観測。
3. Direction: Intentの版、Outcome・Target、Research・Decision・ADR、評価・観測・Runtime eventとActivity。
4. Work / Collaboration / Activity: Claim・状態遷移・Command Receipt・相談のlease・待機解除・文書反映Task・訂正履歴を含む同一batchの設計。
5. Workers用DIでD1実装へ切替え、Node＋SQLiteと同じ業務シナリオを通す。

Contextをまたぐ書込みは個々にcommitせず、必要なSQLを所有Contextが組み立て、Serverが同じbatchへ配線する。D1用Repositoryを追加しただけでWorkers接続済みと扱わない。

## 参照

- [D1 Database API](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- [現行の実装状況](../implementation-status.md)
