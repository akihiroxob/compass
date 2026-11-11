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
- AccessのOIDCログイン試行、Workspace Membershipの更新・失効、Project／Workspace Grant、Credentialの発行・rotationはD1実装済み。並行消費、最後のownerの保護、Grantの冪等性、Credentialのscope束縛、rotationの原子性、archive後の更新拒否をローカルD1で検証済み。
- 招待の発行・再発行・取消とAgent実行観測はD1実装済み。同時発行の一意性、期限切れ招待の置換、終了結果の競合、終了後の観測の冪等性をローカルD1で検証済み。
- AccessのHuman登録・Session作成／失効とD1用DIは実装済み。初期owner同時作成、招待受諾の競合、Session保存失敗時のロールバックを検証済み。共有HTTP入口とローカルD1で、ログイン・Workspace／Project作成・Grant・Credential発行／rotation・ログアウトを検証済み。
- DirectionのRuntime event配信・Ack記録はD1実装済み。attempt IDによる再送、失敗回数、受付記録のロールバック、未確定イベントを追い越さない再開cursorをローカルD1で検証済み。
- DirectionのIntent作成・版管理・放棄はD1実装済み。Activityとの一括保存、競合編集、意味変更理由、関連Outcome／Researchの取消を検証済み。共有HTTP入口でIntent操作とRuntime event参照をローカルD1へ接続して検証済み。
- OutcomeのTarget Project追加・解除・一覧はD1実装済み。同時追加／解除、Workspace境界、archive後の追加拒否と解除許可、SQL失敗時の保持、Project状態を含む一覧と共通HTTP経路を検証済み。
- Outcome本体の作成・更新・取消・一覧はD1実装済み。成功条件／課題／根拠参照／Activity／Runtime eventの一括保存、編集競合、評価計画ID保持、保存直前の根拠置換拒否、上限件数、共通HTTP経路を検証済み。読取も同じbatchから親・子・根拠を組み立てる。
- Intent Metricの定義・観測記録・時系列参照はD1実装済み。同時定義、観測後の単位変更禁止と競合保護、観測の同時訂正・遅延再送・複数期間の一括ロールバック、失敗／ゼロ値の区別、共有HTTP参照を検証済み。
- ResearchのRequest作成・結果／Synthesis登録・終了／取消・詳細／Brief参照はD1実装済み。再送、期限・予算、結果の順序、Synthesis置換の競合、根拠のWorkspace境界、Activity／Runtime event失敗時の一括ロールバック、100件超の結果読取、共通HTTP詳細参照を検証済み。保存計画・復元・Briefの規則はSQLiteと共有する。
- Direction Decisionの記録・追加Research・次Outcome作成・Intent完了はD1実装済み。保存計画をSQLiteと共有し、再送、評価の最新性／二重利用、保存直前の再評価、上限100 Finding参照、100件超の一覧、関連履歴の一括ロールバック、共通HTTP参照を検証済み。
- ADR Handoffの依頼・参照記録・一覧はD1実装済み。Project／Workspace境界、再送、参照済みRepositoryの削除保護、payload作成中のRepository／Workspace制約変更との競合、共通HTTP参照を検証済み。
- Outcome Executionの還流・参照とOutcome Evaluationの保存・参照はD1実装済み。cursorの単調性、Evidenceの重複／Project別上限、同時追加、保存失敗時の全体ロールバック、Target／Summary／Evidence／Project archiveの直前変更による評価拒否、再送、共通HTTP参照を検証済み。Execution保存計画とEvaluationの整形・再送判定はSQLiteと共有する。
- Intent Explanationの記録・参照とDirection全体のD1用DIは実装済み。説明の同時版管理、再送、根拠／関連Outcomeの境界、子要素の保存失敗時のロールバック、100件超の根拠解決、最新50版の参照、共通HTTP経路を検証済み。
- D1 migration配布SQLの生成コマンドは実装済み。共通SQLとD1専用SQLの内容・名前を維持し、WranglerのローカルD1へ明示適用・再実行・CHECK制約を検証済み。リモートDBへの適用は未実施。
- WorkのD1 Unit of WorkとDIは実装済み。既存の読取SQLへ計画中の変更を重ね、読取結果・更新・Change・Receipt・canonical Activityを同じbatchで検査・保存する。同時Claimと同時再送、期限切れ／更新／解放／再取得、自己レビュー／自己受入禁止、Grant失効、Receipt保存失敗、commit後の通信断と同じIDによる復旧、PR／PublicationのStore操作、100件超の参照、Human APIからTask作成→Agent Credential・MCPでClaim取得を検証済み。Collaborationの文書反映Taskとの共通計画と、PR／公開記録の外部Gatewayを通したD1検証は未完了。
- ActivityのD1 Unit of WorkとDIは実装済み。既存の保存値・読取SQLを共有し、参照先の状態とdedupe照合・追記を同じbatchで検査・保存する。同時再送の収束、入力違いの拒否、訂正、保存前の読取、失敗時の巻戻し、archive後の成功済み再送を検証済み。
- 未実装: CollaborationのD1 Repository／Unit of Work、資産bundle生成、Workers Bootstrap・起動・Wrangler設定、Google認証・Agent Credentialを通すWorkers上の通し検証、デプロイ文書。

D1原子的batchの前提検査は`database/d1/migrations/0000_d1_atomic_guards.sql`のCHECK制約を使う。前提不成立を例外にしてbatch全体を巻き戻し、成功時は検査行を同じbatchで削除する。D1専用migrationとして共通の初期schemaと一緒に配布する。`npm run db:prepare:d1`は配布物だけを生成し、DBへ適用しない。

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
