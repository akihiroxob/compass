# Implementation Plan

## 進め方

P0 → P1 → P2 → P3 → P4をローカルMVPとして順に実装する。P5はWacha対応とRuntime接続が前提、P6は実環境での検証。画面だけ先に完成させて終了しない。各段階で受け入れ条件を満たしたら、外部依存のない次段階へ進む。

| 段階 | 作るもの・順序 | 受け入れ条件 | 今はやらないこと |
|---|---|---|---|
| P0 基盤 | 既存調査 → スタック固定 → アプリ・DB起動 → scripts / env → 最小CI | clean checkoutから起動、lint / typecheck / unit / buildが通る。選択理由と手順を記録 | 本番公開、Runtime選定 |
| P1 Project | migration → Project Command / Query → 登録・編集・Home枠 → seed | A01 / A14 / A15。必須全セクションと正しい空状態。再起動で保持 | Task編集、架空の活動表示 |
| P2 Direction | Intent → Outcome / Criterion → Research / Evidence / Decision / Evaluation → 詳細画面 | A02〜A04 / A07〜A09 / A15 / A16 / A20 / A21 / A23。状態と権限をAPIで強制 | 実Agent起動、成果率の独自スコア |
| P3 外部境界 | ExecutionGateway → outbox / inbox → fake Wacha → Summary → 停止・順序処理 | A05 / A06 / A12〜A14 / A17 / A18。固定版・再送・遅延を扱う | 未知のWacha APIの推測実装 |
| P4 LoopとMVP | 次方向Command → 観測要求・予算 → context API → standalone用入力フォーム・外部実行記録 → デモ → Home統合 | A10 / A11 / A19 / A22を含むA01〜A23とcompass側S01 / S02 / S05〜S07。単体操作とfake往復の両方で未達→次Outcome→評価を実演 | Lv6達成の宣言、外部Runtime自作 |
| P5 実接続 | Wacha Outcome対応 → 実API adapter → サービス認証 → 外部RuntimeとRole接続 | A24と境界試験、実Wachaとの往復、Role scopeと独立Run確認 | Wacha全面改修、永続的Human承認フロー |
| P6 Lv6検証 | 隔離環境で2周、証拠不足、障害復旧、予算停止の試験 | acceptance-testsのLv6条件と証跡。達成・未達を明示 | 実証なしの完全自律宣言 |

## P0で確定するもの

実装対象リポジトリ、既存規約、依存バージョン、DB起動方法、npm scripts、テストDB、認証の開発モード。技術選択に既定案があるため、空リポジトリなら細部の確認待ちは不要。

## P4の具体的な完成像

人がProjectを登録しIntentを置ける。外部Role用APIをfixtureで呼ぶとOutcomeがWacha fakeへ渡り、EvidenceとEvaluationが戻り、同じIntent内に次Outcomeが生まれる。HomeにMission、方向、実行概要、判断、学習、活動が表示され、各根拠に遷移できる。サーバー再起動後にも続けられる。

単体利用の受け入れ条件S01〜S07は[standalone-and-integration.md](standalone-and-integration.md)に定義する。Wachaのlocal Outcome実装はcompass P5の開始を待つ必要がなく、Wacha単体の独立した完了単位とする。

## Wachaとの作業分担

[Wacha指示書](wacha-implementation-instructions.md)を別リポジトリで実施する。compass P3はfakeで先行できる。両側でschema fixtureを合意するまで実HTTP adapterの完成を宣言しない。WachaのOutcome対応、既存Story移行、回帰テストはWacha側の完了条件である。

## 未提供の依存がある場合

Wacha実API・資格情報・Runtime接続先がなければ、P0〜P4と契約fixtureまでは進める。P5 / P6について不足している具体情報と作業を記録する。ダミーの成功で代用せず、依存と無関係な実装を止めない。

## 毎段階の終了記録

実装対象、schema / APIの差分、実行した検証と結果、動作確認手順、未実施事項を短く残す。新規cloneから手順を再現し、関連ドキュメントを更新する。公開・デプロイはこのキットの初期実装完了条件に含めない。
