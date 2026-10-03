# Project画面の情報設計と視覚方針

Story「CompassのUIを整理し、進行状況とAgentの担当が分かる体験にする」の後続Task（04〜05）が画面判断に使う案。実装済みの仕様ではない。実装したTaskで現行文書へ反映し、この文書から該当箇所を除く。

## 前提

- 技術構成（Hono / React・Vite / 既存CSS）とWeb APIを変えない。DB・公開APIの追加を前提にしない。
- 導線の表示判定は既存の`canOperate`（`humanProjectPermissions`）と`useProjectOperation`を使い、拒否は常にServerが行う。
- Activityをworkflow checkpointやAgent heartbeatとして使わない。

## 利用者と場面

| 利用者 | 主な場面 | 必要な情報 |
| --- | --- | --- |
| viewer | 状況の確認 | 現在地、担当中のTask、履歴 |
| editor | 方向の更新、受入・差戻し | 上記に加え、Intent・Outcomeの不足、受入待ちのTask |
| administrator | Agentの準備 | 上記に加え、Role未割当、Credential未発行 |
| owner | Memberとライフサイクルの管理 | 上記に加え、Member・招待・アーカイブ |

Desktopは作業中の常時確認と管理設定、スマートフォンは外出先での状況確認と受入判断を想定する。スマートフォンでも概要は1画面程度で読み終え、管理設定へ2操作以内で到達できるようにする。

## 情報の優先順位

1. **現在地**: Direction（Intent・Outcome）→ Work（Story・Task）→ 評価のどこにいるか。
2. **次の行動**: 自分の権限で今できること。できない場合は誰に依頼するか。
3. **担当中のAgent**: 期限内のClaimを持つAgentとTask。
4. **日常閲覧**: 方向の詳細、Story・Task一覧、最近の変更、Activity、Research。
5. **管理設定**: Role割当、Credential、Member、Projectの編集・アーカイブ。

## 画面構成

viewの分割・概要（現在地・次の行動・Claim保持中）・設定のAgent一覧はTask 03で実装した。現行仕様は [implementation-status.md](../implementation-status.md) の「Project詳細（Web UI）」を参照する。

## Role・稼働状態の区別

| 状態 | 情報源 | 表示語 | 表示してはいけない意味 |
| --- | --- | --- | --- |
| Role割当 | `grants` | 割当済み | Agentが起動している |
| Credential | `credentials` | 発行済み・取消済み | Agentが接続している |
| Claim保持 | `execution`の`activeClaim` | Claim保持中（期限 …） | プロセスが動作中 |
| 期限切れClaim | `reclaimable` | 再取得待ち | 担当中 |
| プロセス稼働 | 現在Web UIに信頼できる情報源が無い | 表示しない | — |

プロセス稼働を表示する場合は、Orchestrator等の運用情報の契約を別Taskで設計してからにする。Activity・Change Logの最終時刻を稼働の代わりにしない。

## 空・読込・失敗の状態

- 読込中・失敗・未登録を必ず区別する。失敗には再読込の手段を付ける。
- 未登録には、権限に応じた次の行動を1つだけ添える。実行できない利用者には依頼先を示し、押せないボタンを出さない。
- 未定義のURLには404画面を出し、Project一覧と直前の画面へ戻れるようにする（Task 05）。
- 内部ID・相関IDは`code`で表示し、折り返せるようにする。本文の主情報にはしない。

## 用語

- Entity名（Project・Intent・Outcome・Story・Task・Claim・Activity）は英語のまま使う。状態・操作・viewの名前は日本語にする。
- 状態ラベルは既存の`taskStatusLabels`・`storyStatusLabels`・`outcomeLoopStage`を正とし、画面ごとに言い換えない。
- Agent名は`principalId`をそのまま表示し、Humanは`describePrincipal`で表示名にする。
- 「稼働」「起動」「接続」は、それを直接観測できる情報があるときだけ使う。

## 視覚方針

### 状態色

既存の配色（背景`#f4f1eb`、文字`#24221f`、アクセント`#a2462d`）を基調に、意味ごとのCSS変数を定義して各画面で共有する。

| 意味 | 用途 | 方針 |
| --- | --- | --- |
| 要対応 | 受入待ち、差戻し、あなたの操作 | アクセント（`#a2462d`）の塗りbadge |
| 待機 | 未着手、Agentの担当待ち | 塗りの無い枠線badge |
| 進行中 | 作業中、レビュー待ち、Claim保持中 | 落ち着いた青系の塗りbadge |
| 完了 | 受入済み、評価で達成 | 緑系の淡い背景 |
| 終了・控えめ | 取消、過去のIntent | 既存の`muted` |
| 警告・失敗 | 読込失敗、再取得待ち（期限切れ）、危険な操作 | 既存の`error`・`danger` |

色だけに頼らず、必ずラベル文字を併記する。文字と背景はWCAG AAのコントラスト比を満たす。

### タイポグラフィ・余白

- 見出しはGeorgia、本文はsystem sansを維持する。Project詳細のh1は現行（最大5.6rem）より小さくし、概要がファーストビューに入るようにする。
- 件数・時刻は`font-variant-numeric: tabular-nums`、IDは等幅にする。
- section間の余白とcardの角丸は既存の値を基準に統一し、新しいcard種別を増やさない。

### 動き

- view切替、行の展開、状態badgeの変化に150〜200ms程度のfade・高さ変化を使う。理解を助けない装飾的な動きは入れない。
- Agentの稼働を連想させる点滅・脈動・回転を、Claim保持やRole割当の表示に使わない。期限のカウントダウンもしない。
- `prefers-reduced-motion: reduce`ではtransition・transformを無効にする。
- keyboard focusは既存の`outline`を全操作要素で見えるようにし、view切替でfocusを失わない。

## 後続Taskの受入観点

- **04**: 状態色・タイポグラフィ・動きが上記の方針に沿い、`prefers-reduced-motion`・keyboard focus・コントラストを確認する。
- **05**: 空・読込・失敗・404が上記の方針に沿い、権限と接続状況に応じた案内を出す。
