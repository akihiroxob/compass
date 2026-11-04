# 合意UIの実装計画

## 位置づけ

合意した情報設計・画面を既存Compassへ接続するStory・Taskの計画と登録台帳。WachaのProject `45186ac4-9c0a-4bf5-8fb3-0f4ab9d4e7c3`を対象とする。登録・実装・受入は別であり、ここにあるTaskは実装済みを意味しない。

## 参照する設計

- 設計コミット: `cebd9d3b5e973966467bbd3cc513dcf5fca02bca`（GitHub mainへの共有・取得を確認済み）。
- [合意した情報設計](ux-user-scenarios.md) / [採用試作](prototypes/index.html) / [Human認可の決定](../adr/0003-workspace-human-membership.md)。
- 完了済みの25 Story・122 Taskを照合済み。既存の共通UI・相談・Work・Direction・Role実行を再利用し、受入済み案件を書き換えない。
- [登録内容](ui-redesign-registration.json)は起票の再送・結果照合用。状態はWachaを正とする。

## 実装の共通境界

共通方針:
- 対象Repository: /Users/aokayama/git/compass。Wachaは開発管理だけに利用し、製品の依存関係として再導入しない。
- 最新の合意資料 docs/planning/ux-user-scenarios.md と採用試作 docs/planning/prototypes/index.html、Architecture Handoff、ADR 0003を読む。試作は配置と導線の参照で、架空データ・HTMLの直配信・メモリだけの保存を製品へ移さない。
- 既存Hono / React・Vite / SQLite・Kyselyを維持。UIはFeature責務・公開入口・既存共通React部品・SCSS・token・Storybookを再利用する。Tailwindの新規導入・新規必須階層・独立した『成果』管理・OpenAI API／内蔵AIチャットは対象外。
- 独立した自分のWorktree/BranchでPRを作る。完了済みのStory/Taskを再実装しない。技術選定や実装詳細は既存Policy内でAgentが決め、根拠を記録する。要件自体の変更・ACの追加配分はManagerへ返す。
- 対象SHAの専用環境で公開API/MCP/UIから状態を準備し、必要な準備を同じPRで更新する。docs/browser-verification.mdのPolicyと対象revisionを照合する。運用DB・稼働中Task/Claimは触らず、SQL直書きや応答差替えを公開操作のACの代わりにしない。
- 前提Taskはaccepted（対象変更が統合済み）を待つ。番号・sortOrder・候補への表示は依存の成立を保証しない。受入を後続Taskへ丸投げせず、自分の対象SHAで記載ACを検証する。
- 関連テスト、npm run typecheck / lint / buildを実施し、UIではnpm run check:ui / catalog:buildと実ブラウザPC 1440px・SP 390pxの操作・保存画像を確認する。全チェックの無目的な反復はしない。失敗・skip・未検証は理由と対象SHA・環境・根拠を分けて報告する。
- 現行文書・公開契約・Role手順・検証準備を実装と揃える。正本には有効な現在仕様を記載し、過去案や変更履歴を追記しない。重要な設計判断はADRへ残す。
- GitHub requiredChecksは現在空でCI任意。ローカルの必要な検証と独立レビューは省略しない。受入済みTask／PRマージ／公開／Outcome効果は別の事実として扱う。

UI共通AC:
- 概要→対応待ち→Outcome→Activity→Agent管理→設定。Workspace/Project切替は概要へ戻る。SPは右のハンバーガーと右ドロワー。
- 共通Dialogは×・44px以上・読み上げ名・Escape・focus復帰。個別対象の操作はそのカード内、ページ全体操作はページ上部。冗長な説明・矢印・二段階の開閉を増やさない。
- 実データの空状態・権限不足・読込失敗・保存中／失敗・競合・多数件を区別し、未接続や不明をゼロや成功にしない。画面固有で本Taskに関係する状態を独立して確認する。

## StoryとTask

### UI-R01 WorkspaceのMember権限で配下の全Projectを利用できる

Wacha Story: `a0fc49f0-778c-49ae-b038-362e89915cd5`

HumanがWorkspaceだけで参加・招待・Role変更・除外を管理し、配下Projectへ同じ権限を適用できる。

| Task | 内容 | 先行Task（accepted） | Wacha ID |
| --- | --- | --- | --- |
| A1 | HumanのProject操作を所属WorkspaceのMembershipで認可する | 設計コミットの共有 | `f6981424-b8d9-4d5c-af52-1699fa900695` |
| A2 | WorkspaceからHumanを招待し全Projectの利用へつなぐ | A1 | `77553441-526c-46bb-a046-af2ccc6f3046` |
| A3 | Member一覧と権限ヘルプを新しいWorkspace管理UIへ揃える | A2, N1 | `750acffc-4827-486e-81cb-13c3935674c4` |

### UI-R02 WorkspaceとProjectを作り合意したナビゲーションで行き来できる

Wacha Story: `e3af4511-4d33-4bdf-a2ad-9e5fcf608a5c`

新規作成から概要・設定・Project切替まで、PCとスマートフォンで同じ情報構造を使える。

| Task | 内容 | 先行Task（accepted） | Wacha ID |
| --- | --- | --- | --- |
| N1 | 共通Shellとモーダル・フォーム部品を合意した導線へ適用する | A1 | `ccd79187-860e-4d8d-bad7-85d16ad4cec1` |
| N2 | Workspace作成・設定からProject追加と空の概要を使えるようにする | N1, A2 | `62ab3cf8-ef00-45b8-a646-65c31c3b9fd9` |
| N3 | Project設定のRepository URL・Resource・archiveを実操作へ接続する | N2 | `d0dca73f-38ed-4822-927f-d266505b37a8` |

### UI-R03 ビジネス目標をUIと外部MCPから登録し複数目標を並行して進められる

Wacha Story: `401ebe88-bd34-4a16-8606-eba8f8583f6f`

Intentを構造化したビジネス目標として直接入力し、複数目標と学習による更新をAgentへ引き継げる。

| Task | 内容 | 先行Task（accepted） | Wacha ID |
| --- | --- | --- | --- |
| B1 | 構造化したIntentをWorkspaceのUIと認可済みMCPで登録・更新する | A1, N1 | `21272178-1813-45ab-8ef9-b50f949118b4` |
| B2 | 複数ビジネス目標とIntent単位のOrchestrator dispatchを成立させる | B1 | `991fb519-bded-470e-bf84-f426f028bd84` |
| B3 | 目標を見直したとき既存Outcome・評価の根拠と版を保持する | B2 | `b8f5022d-6602-4a60-9a40-4be0ccf30aed` |

### UI-R04 Outcomeの課題・解決策・評価計画を読み書きし目標をまたいで把握できる

Wacha Story: `012737a6-4abf-450e-a541-1da405ebd4a7`

新しい必須階層を増やさずOutcomeごとに課題・根拠・解決策・評価をまとめ、一覧から進捗と障害を辿れる。

| Task | 内容 | 先行Task（accepted） | Wacha ID |
| --- | --- | --- | --- |
| O1 | Outcomeに課題と解決策の仮説・根拠を関連付けUI／MCPで扱う | B2, N1 | `c7926b19-72d3-415f-8ab0-b0b88e7ee7e1` |
| O2 | 評価計画と実際の評価結果をOutcomeへ接続する | O1, B3 | `2494dd06-74a8-4da2-8762-45cf79e1fb47` |
| O3 | Outcome一覧・詳細で全Projectの進捗と問題を比較できるようにする | O2, N2 | `c711cae6-72b2-4cb6-904b-ae1caa7c78c6` |

### UI-R05 ビジネス目標への到達点と前回からの変化をWorkspaceで理解できる

Wacha Story: `60d9affc-29fe-4940-87c1-f11eb0864f97`

Workspace一覧から優先して見る対象を選び、目標の実測値・推移・根拠付きの説明を確認できる。

| Task | 内容 | 先行Task（accepted） | Wacha ID |
| --- | --- | --- | --- |
| M1 | 目標の観測値と時系列を根拠付きで記録・参照する最小契約を提供する | B2 | `a736b825-8124-4edf-ab0a-b6da6120f050` |
| M2 | 事実・原因仮説・次の提案を根拠に結び付けて記録・表示する | M1, O2 | `4a63fba0-158d-4c69-abd7-35bb8ae5978c` |
| M3 | Workspace一覧・概要と目標詳細を実データの俯瞰と日次推移へ揃える | M2, O3, N2 | `fd75f15b-814d-4d1a-9cc6-4210392a0c24` |

### UI-R06 Projectの目的・進捗・全Story／Taskを把握し必要な介入ができる

Wacha Story: `e7686349-29bf-4c33-bc74-d813ee5a69c4`

Outcomeを事前に選ばず全仕事を検索し、Storyの受入条件とTaskの活動・コメント・関連PR・Human操作を確認できる。

| Task | 内容 | 先行Task（accepted） | Wacha ID |
| --- | --- | --- | --- |
| W1 | Project概要と全OutcomeのStory／Task一覧を多件数で閲覧できるようにする | N2, O3 | `36746ab0-73f1-4526-831f-0ae966f57464` |
| W2 | Story／Taskの手動起票・編集を対象に沿った導線へ揃える | W1 | `2ea66107-dd09-4de2-ae4f-1b9cd3ea1df9` |
| W3 | Task詳細の関連PR・活動履歴・コメントとHuman操作を接続する | W2, G1, G2 | `113ef76c-f187-449a-ace6-d9bc4daf76dd` |

### UI-R07 TaskとGitHub PR・対象SHA・レビュー・受入を整合させる

Wacha Story: `b7f1b5b9-d16a-4934-825d-89ac35fe8e97`

現行WachaのPR/SHA整合性をCompassの実行管理へ取り込み、CIなし・同一GitHubアカウントでも品質確認と受入を行える。

| Task | 内容 | 先行Task（accepted） | Wacha ID |
| --- | --- | --- | --- |
| G1 | TaskへのPR登録・一覧と検証済みSHAを公開契約で扱う | A1 | `c5c4ca3f-4b93-49ff-9a25-7715fa14ab5f` |
| G2 | PR／SHA照合を作業完了・レビュー・受入とRole手順へ接続する | G1 | `ded25ca7-af29-4189-aaa1-533ae98a91bc` |

### UI-R08 Workspaceの対応待ちから経緯を確認して回答できる

Wacha Story: `30d46072-1c0d-417d-a3cb-4025e7a5b3d5`

人の対応が必要な相談だけをWorkspaceで把握し、要約から経緯・回答・Agentの再開を辿れる。

| Task | 内容 | 先行Task（accepted） | Wacha ID |
| --- | --- | --- | --- |
| C1 | 対応待ち一覧・詳細・回答を既存相談の排他と自動再開へ接続する | A2, N1 | `298c6ec1-a5cb-4e03-8fbe-0d945ffc36ef` |

### UI-R09 Workspaceの全業務活動を検索し対象の詳細へ辿れる

Wacha Story: `3e37eea4-523d-4f9a-8e31-15d6ab4250b2`

Workspaceと全Projectの意味ある活動を一覧し、コメントや技術ログを混ぜず経緯を確認できる。

| Task | 内容 | 先行Task（accepted） | Wacha ID |
| --- | --- | --- | --- |
| L1 | Workspaceと全Projectの業務活動を重複なく横断取得する | A1, B2 | `74f816e7-44c9-45de-b9eb-cf0882ce0c8a` |
| L2 | Activity一覧・詳細を横断検索と原記録への導線に揃える | L1, N1 | `891379d0-ddf7-465e-b887-2a3e09c262f6` |

### UI-R10 Workspace内のAgentの担当と観測された実行状態を把握できる

Wacha Story: `018399ed-3010-4a00-ac7e-067fd8cb407e`

PrincipalのRole・担当Project・Credentialと、実際の実行観測を区別して一覧・詳細で管理できる。

| Task | 内容 | 先行Task（accepted） | Wacha ID |
| --- | --- | --- | --- |
| E1 | Workspace内のAgent一覧・詳細とPrincipal／Credential管理をまとめる | A1, N1 | `baee1d25-197c-4b57-acb7-b7467cd9aac4` |
| E2 | Ralph／Orchestratorの実行観測をAgent一覧へ接続する | E1 | `016e84c9-55ad-4b64-bb27-d967a3143533` |

### UI-R11 Projectの開発受入と公開の履歴を分けて追跡できる

Wacha Story: `bbea395e-e581-40df-8940-4eb5e4e96128`

何を提供したかを細かく残し、開発受入と公開確認とOutcomeの効果を区別して辿れる。

| Task | 内容 | 先行Task（accepted） | Wacha ID |
| --- | --- | --- | --- |
| P1 | 開発受入と公開確認を別の根拠として記録・取得する | G2 | `49333237-a6fa-4a2b-9e33-570b5d837d89` |
| P2 | リリース履歴の一覧・詳細を開発と公開の状態へ接続する | P1, N1 | `a92eb97d-fdd6-4f55-96be-ad61a64a4439` |

### UI-R12 合意した主要導線を実データ・実認可で通して受入できる

Wacha Story: `8e5e423a-1c25-4c1d-9ef0-3f91ddc19b9d`

既存機能を落とさず、初回利用から目標・開発・判断・活動・管理まで一貫して使えることを確認できる。

| Task | 内容 | 先行Task（accepted） | Wacha ID |
| --- | --- | --- | --- |
| Z1 | 新UIと業務契約の統合回帰・実ブラウザ確認・文書整合を完了する | A3, N3, M3, W3, G2, C1, L2, E2, P2 | `69133039-0f94-46c1-aff8-51f02da668f1` |

## 最初に実行できるTask

A1 `f6981424-b8d9-4d5c-af52-1699fa900695`が追加の依存Taskなしで開始できる。受入後、A2・N1・G1へ分岐する。全Taskの前提はWacha本文の実IDと必要状態を読む。

## 実行・検証の順序

- Taskの依存は本文の実IDと必要状態で確認し、`.ralph/config.json`の`taskDependencies`へ登録する。全先行Taskのacceptedを確認してからWorkerを起動する。番号・sortOrderは依存制御ではない。
- 依存定義は[登録内容](ui-redesign-registration.json)の各Taskの`deps`と`registration.tasks`の実IDに対応する。依存変更時は本文・登録内容・実行設定を揃える。Ralph以外のクライアントに、このローカル設定によるClaim制御は適用されない。
- 各Roleは対象SHAの専用プレビューで検証し、画像・操作記録・配信assetはClaim別の`.ralph/verification/<claimId>/browser/`へ絶対pathで保存する。ReviewerはWorkerの証跡が不足する場合も専用環境で再確認できる。採用試作のpreviewは`docs/planning/prototypes/`を参照する。
- 依存グラフは循環なし。並列に進められる枝は、同じファイルや公開契約の競合を確認して選ぶ。
- すべてのTaskにGivenの準備方法と独立に観測できるGherkin ACを置く。先行Taskの受入に後続UIを要求しない。
- 実行時は対象SHAの公開入口で準備する。専用の表示fixtureが必要なら同じPRで更新し、管理操作のACをDB直接変更やmock成功で代替しない。
- 各Storyの最後の配下TaskがStory内の統合条件を確認し、Z1が全体を通した受入を確認する。各Task自身の受入をZ1まで延期しない。

## 登録状況

12 Story・28 TaskをWachaへ登録済み。本文・所属Story・依存ID・優先順位・completionModeを読み戻して照合済み。実装・受入は未完了。

