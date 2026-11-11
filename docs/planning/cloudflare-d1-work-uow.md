# Work用D1 Unit of Workの実装方針

未実装の設計・検証項目。現在のD1対応状況は[Workers + D1対応計画](cloudflare-d1.md)に記載する。

## 維持する契約

`WorkStore.transaction()`はApplicationが使うUnit of Workの境界とする。Task／Claimの規則、自己レビュー・自己受入禁止、Command Receiptの再送判定は既存Applicationへ残す。SQLite実装は維持する。

D1ではcallback内でDBへ逐次書き込まない。読取条件・更新SQL・履歴・Activityを計画し、最後に`D1AtomicBatch`で一括確定する。更新後の再読取は計画内の変更も反映して返す。例外時には計画を破棄する。D1 Dialectのcallback transaction拒否は維持する。

## 保存計画

- Work用の計画Storeを用意し、Story／Task／Claim／Comment／PR／Publication／Receipt／相談待機の変更を保持する。既存の読取SQLは可能な範囲で共有する。
- 保存前の読取には、同じSQLの結果が確定時にも一致することを検査する条件を付ける。空集合・集計・一覧の追加／削除も検出する。Grant、Project状態、Repository、Outcome Target、相談の準備状態も対象にする。
- 更新後の読取は、計画した追加・更新・削除を重ねる。単一行だけでなく、active Claim、一覧、件数、sort order、最新履歴、現在のPR等を検証する。
- Change cursorは返却値・Activityで使うため、確定前に採番する方法が必要。グローバルな最新cursorを条件にした採番を検証し、競合時は計画全体を作り直す。独自のJSロックは使わない。
- 計画中のDB接続から直接更新SQLを実行できないようにし、未対応メソッドが原子的保存を迂回しないことを確認する。
- 入れ子のUnit of Workは同じ計画へ参加する。Collaborationからの文書反映Task作成等も、同じbatchへ接続する。

## 再試行と成否

SQL前提条件の不成立だけを有限回再試行する。通信断や成否不明を競合扱いにしない。受付記録のある操作は同じrequest IDで再照合できる状態を維持する。callback内の外部Gateway操作を調査し、再試行で外部変更を重複させるものがあれば計画の外へ分離する。

## 必須の検証

1. Story／Task作成からClaim、更新、Comment、完了、Review、Acceptまでを、既存Applicationの同じ経路で通す。
2. 同時Claimは1件だけ成功し、期限切れ・更新・解放・再取得で所有権が崩れない。
3. 同じrequest IDの並行実行と再送は、更新・Change・Activityを重複させない。
4. 更新後の再読取、条件付き更新、複数行更新がSQLiteと一致する。
5. 保存直前のGrant失効、Project archive、Target解除、Claim変更を検出する。
6. Receipt／Change／Activityの保存失敗で、Task／Claim等も巻き戻る。
7. PR・公開記録の番号／受付順と、cursorの競合を検出する。
8. 複数Project・大量のStory／Task・D1のSQLパラメータ上限を検証し、全Workデータの毎回読込を前提にしない。
9. Collaboration・Activityとの同一batchを接続してから、Workers用DIへ組み込む。
