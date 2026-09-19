# Coding Rules

## 小さく一貫した実装

- 既存設計を優先し、空ならarchitectureの構成を使う。抽象化は外部境界と永続化境界に限る。
- ドメイン用語をそのまま型名にする。Goal / Job / Work等への曖昧な言い換えを増やさない。
- TypeScript strict。any、型assertionで外部入力を信用する実装を避け、境界でスキーマ検証する。
- 状態はunion / enumで定義し、許可遷移を一箇所に置く。UIに別の業務状態機械を作らない。
- ClockとID生成を差し替え可能にして、時間・再送・並列テストを決定的にする。
- DB更新・監査・outboxを同じtransactionで行う。外部呼び出しはcommit後。
- DB migrationは履歴に残し、起動時に勝手に本番schemaを破壊しない。
- Secretは環境変数等から読む。.env.exampleは名前とダミー値だけ。ログにtoken・機密本文を出さない。
- 外部本文をHTMLとして無検証で表示しない。Evidence URLから任意コードを実行しない。

## テストと検証

unit: Criterion判定、状態遷移、予算、権限。integration: 実PostgreSQLの制約、トランザクション、同時操作、再起動相当の再読込。contract: fake / HTTP adapter、イベント版、重複と順序。e2e: Project登録からHomeで評価・次Outcomeを確認する流れ。

スナップショットの量やカバレッジ率を目的にしない。acceptance-testsの業務条件を証明する。失敗再現テストを先に置いてから修正する。ドキュメントだけの変更に無意味なアプリテストを追加しない。

空リポジトリでは以下のscriptsを提供する。具体的な内部コマンドは選んだ互換バージョンに合わせる。

```sh
npm ci
npm run db:migrate
npm run db:seed
npm run dev
npm run lint
npm run typecheck
npm run test:unit
npm run test:integration
npm run test:contract
npm run test:e2e
npm run build
npm run demo:direction-loop
```

最初の依存導入だけnpm installを使い、以後はlockfileで再現する。integration / e2eは専用テストDBを使い、seed・resetが本番DBへ向かう場合は実行を拒否する。必要なDB起動手順と環境変数は実装後READMEに記載する。

## 差分とADR

1段階ごとにレビュー可能な差分にする。依存追加・DB変更・責務変更には理由を残す。ADRはdocs/decisions/に番号・問題・決定・代替・影響を記す。全ての小さなUI選択にADRは不要。

実装終了時には型チェック・lint・関連テスト・buildを実行し、コマンド・成否・未実行理由を報告する。fakeによる成功を実サービスの検証成功として書かない。
