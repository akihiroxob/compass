# Work用D1 Unit of Workの実装方針

WorkのD1用保存計画と、残る結合検証の条件。基本のUnit of Work・DIは実装済みで、Collaborationからの文書反映Taskは同一計画へ接続済み。現在のD1対応状況は[Workers + D1対応計画](cloudflare-d1.md)に記載する。

## 維持する契約

`WorkStore.transaction()`はApplicationが使うUnit of Workの境界とする。Task／Claimの規則、自己レビュー・自己受入禁止、Command Receiptの再送判定は既存Applicationへ残す。SQLite実装は維持する。

D1ではcallback内でDBへ逐次書き込まない。読取条件・更新SQL・履歴・Activityを計画し、最後に`D1AtomicBatch`で一括確定する。更新後の再読取は計画内の変更も反映して返す。例外時には計画を破棄する。D1 Dialectのcallback transaction拒否は維持する。

## 保存計画

- `D1WorkStore`と`D1WritePlan`が、Story／Task／Claim／Comment／PR／Publication／Receipt／相談待機の変更を保持する。既存の`KyselyWorkStore`の読取SQLを共有し、変更したtableだけをCTEで重ねる。
- 保存前の読取には、同じSQLの結果が確定時にも一致することを検査する条件を付ける。空集合・集計・一覧の追加／削除も検出する。Grant、Project状態、Repository、Outcome Target、相談の準備状態も対象にする。
- 更新後の読取は、計画した追加・更新・削除を重ねる。単一行だけでなく、active Claim、一覧、件数、sort order、最新履歴、現在のPR等を検証する。
- Change cursorと計画中のrowidは、最新値をSQL条件で保護して採番する。競合時は計画全体を作り直す。独自のJSロックは使わない。
- 計画中のDB接続から直接更新SQLを実行できないようにし、未対応メソッドが原子的保存を迂回しないことを確認する。
- Work内の入れ子のUnit of Workは同じ計画へ参加する。Collaborationからの文書反映Task作成・Activityも同じbatchへ参加する。

## 再試行と成否

SQL前提条件の不成立だけを有限回再試行する。通信断や成否不明を競合扱いにしない。受付記録のある操作は同じrequest IDで再照合できる状態を維持する。callback内の外部Gateway操作を調査し、再試行で外部変更を重複させるものがあれば計画の外へ分離する。

## 検証条件

1. Story／Task作成からClaim、更新、Comment、完了、Review、Acceptまでを、既存Applicationの同じ経路で通す。
2. 同時Claimは1件だけ成功し、期限切れ・更新・解放・再取得で所有権が崩れない。
3. 同じrequest IDの並行実行と再送は、更新・Change・Activityを重複させない。
4. 更新後の再読取、条件付き更新、複数行更新がSQLiteと一致する。
5. 保存直前のGrant失効・Project archive・Outcome Target解除・Claim変更を検出する。
6. Receipt／Change／Activityの保存失敗で、Task／Claim等も巻き戻る。
7. PR・公開記録の番号／受付順と、cursorの競合を検出する。
8. 複数Project・大量のStory／Task・D1のSQLパラメータ上限を検証し、全Workデータの毎回読込を前提にしない。
9. Collaboration・Activityとの同一batchを接続してから、Workers用DIへ組み込む。

## 確認済みと残る検証

- ローカルD1で、更新後の再読取・JOIN・集計・条件付き更新・削除・入れ子、PR更新・Publicationの複合キー、100件超のID条件を確認済み。
- 既存ApplicationでWorker→Reviewer→Managerを通し、自己レビュー／自己受入拒否、同時Claim、同じrequest IDの同時再送、Claim更新・期限切れ・解放・再取得を確認済み。
- 保存直前のGrant失効・Project archive・Outcome Target解除、Receipt保存失敗の全体ロールバック、成否不明時の自動再試行禁止と同じIDでの復旧を確認済み。
- 異なる行を更新する並行計画でも、集計の前提が崩れた計画を拒否するwrite skew検証を実施済み。
- 共通HTTP／MCPでHumanのTask作成からAgent CredentialのClaim取得まで接続済み。配布bundleのworkerd上でPR登録・公開記録APIも接続済み。
- 100列の読取、200件・合計2.4MBのTaskの一括保存と読取、JSON化で2MBを超える改行本文の更新を確認済み。分割した読取検査でも途中の変更・末尾への追加を検出する。
- 検査用JSONと保存予定行のJSONは小分けにし、幅の広い行はjson_objectの引数数を抑え、大きい本文は生の値でも照合する。確定batch自体は分割しない。
- テスト用D1接続はSQL長・bind数・文字列値・json_object引数の公開上限を照合する。実環境のCPU・通信・invocation全体の上限や、任意サイズでの性能を保証する検証ではない。
