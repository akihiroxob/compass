# Compass の全体像と Agent の動き

Compass の構成と、Human・Agent がどう協調するかを1つにまとめた入口文書。詳細な契約は各設計文書、実装済みかどうかは [実装状況](implementation-status.md) を正とする。設計の正本は [Architecture Handoff](../compass-codex-architecture-handoff.md) と [ADR](adr/)。

## Compass とは

Human が与えた方向（Mission・目標）から、複数の専門 Role を持つ Agent が調査・計画・実装・レビュー・受入・評価を進めるための Control Plane。状態の正本・認可・業務規則は Server が持ち、Agent の起動は Server の外の実行システムが行う。

## 概念モデル

```text
Workspace（戦略の境界: Mission / Vision / Principles / Constraints）
├─ Intent（Human が今実現したい状態）
│  └─ Outcome（観測可能な達成状態 + 固定の成功条件）
│     ├─ Target Project A ─ Story ─ Task
│     └─ Target Project B ─ Story ─ Task
└─ Project（実行の境界: Repository / Resource）
```

| 概念 | 意味 | scope |
| --- | --- | --- |
| Workspace | Mission を共有する戦略的な活動単位 | — |
| Intent | Human が現在実現したい状態（ビジネス目標） | Workspace |
| Outcome | Intent を具体化した観測可能な状態。成功条件は作成時に固定 | Workspace |
| Target Project | Outcome を担当する Project。Strategist が決める | Workspace → Project |
| Story | ある Project が Outcome に対して引き受ける仕事 | Project |
| Task | Story を実現する具体作業。Claim・Review・Acceptance を伴う | Project |
| Evaluation | 成功条件を Evidence で判定した記録。Task の受入とは別 | Workspace |

Task の受入は Outcome の達成を意味しない。達成は Evaluator の Evaluation と Strategist の判断で決まる。

## 実行システム

```text
        Human                         Agent / Runtime
          │ Web UI                        │ MCP
          ▼                               ▼
┌──────────────────── server ────────────────────┐
│  Web UI ・ /api ・ /mcp（同一 port）            │
│  application（Human 認可 / Role・scope 認可）   │
│  packages: organization direction work          │
│            activity access collaboration        │
│  DB: SQLite（Node） / D1（Workers）             │
│  Agent 資産: roles/ skills/ knowledge/ policies/│
└───────▲───────────────────────────▲────────────┘
        │ MCP（現在状態の読取り）    │ MCP（Task の確認）
   orchestrator                    ralph
   Workspace ごとの Batch          Project ごとの Loop
        │ 起動                       │ 起動
   strategist / researcher /        worker / reviewer
   evaluator / manager              （manager は任意）
```

| システム | 役割 | 持たないもの |
| --- | --- | --- |
| `server/` | 状態の正本、認可、業務規則、Role Context の配信、Web UI | Agent の起動、polling、retry |
| `orchestrator/` | 現在状態から、次に起動する専門 Role を決めて起動する | 知的判断（Role へ委譲）、状態の書込み |
| `ralph/` | Task の有無を確認し、Worker / Reviewer を1 Task ずつ起動する | Role の手順、Git・GitHub 操作、状態遷移の代行 |

3つは独立して実行・build・deploy する。Orchestrator と Ralph は Server と MCP だけで接続し、DB や package を直接使わない。Workers 配置では Server だけを Workers に置き、Orchestrator と Ralph は別プロセスから接続する（[Workers + D1への配置](cloudflare-deployment.md)）。

### Bounded Context

| package | 所有するもの |
| --- | --- |
| `organization` | Workspace・Project・Repository / Resource |
| `direction` | Intent・Outcome・成功条件・Research・Decision・Evaluation・Target Project |
| `work` | Story・Task・Claim・Comment・Review・Acceptance・Change Log・PR の確認・公開確認 |
| `collaboration` | Agent から Human への相談（会話・結論・応答 lease） |
| `activity` | 意味のある履歴（Workspace / Project scope） |
| `access` | Principal・Role Grant・Credential・Membership・Human 認証 |

依存方向は Infrastructure → Application → Domain。Context 間は server が渡す reader port で連携し、他 Context の table を直接読まない。Web API と MCP は同じ application 層へ委譲する。

## 主体と認可

| 主体 | 入口 | 認可の根拠 |
| --- | --- | --- |
| Human | Web UI（Web API） | Workspace Membership（viewer / editor / administrator / owner）。配下の全 Project に同じ Role |
| Agent | MCP | Agent Credential + Role Grant。Workspace Role は Workspace Grant、Project Role は Project Grant。互いに継承しない |
| Runtime（Orchestrator 等） | MCP・一部 Web API | Runtime Credential の scope（Workspace 用と Project 用は別） |

- Principal と Role は分離する。1回の実行では `X-Compass-Active-Role` で activeRole を1つに固定し、Server がその Role の Grant だけで認可する。
- 自己レビュー・自己受入の禁止、Claim の所有・期限、状態遷移は Work が Principal 単位で強制する。Role を切り替えても回避できない。
- Human の明示決定など Human 専用の操作は MCP へ公開しない。

詳細は [Human認証・Membership・Credential](step-6-human-auth-design.md) と [実装状況の Access](implementation-status.md#accessの現行契約)。

## Role

| Role | scope | 起動元 | 責務 | 決めないこと |
| --- | --- | --- | --- | --- |
| strategist | Workspace | Orchestrator | Intent と Evaluation から次の Outcome・Target Project・Research の要否・Intent の完了を判断する | 実行方法 |
| researcher | Workspace | Orchestrator | Research Request に Finding・Evidence 参照・Synthesis を残す | Outcome、方向の判断 |
| evaluator | Workspace | Orchestrator | 成功条件を Evidence で1件ずつ判定し Evaluation を残す | Outcome の定義、実行結果 |
| manager | Project | Orchestrator | Outcome を Story・Task に分解し、成果を受入・差し戻す | Outcome・成功条件 |
| worker | Project | Ralph | Task を Claim して実装し、レビュー可能にする | 受入 |
| reviewer | Project | Ralph | 完了した Task を確認し、受入判断へ進められるか判定する | 最終受入 |

Role の本文は `roles/`、再利用手順は `skills/`、共通 Policy は `policies/`、共通知識は `knowledge/` に置き、Git で管理する。

### 実行時の Agent

Agent は保存された定義ファイルではなく、実行時に次から構成される。

```text
Principal + activeRole
  + Role Definition + Policy + Skill + Knowledge   … Git 管理の資産
  + Workspace / Project の Context・最近の Activity … Server の現在状態
  + Tools（MCP）
```

起動された Agent は、Workspace Role なら `get_workspace_role_context`、Project Role なら `get_role_context` を最初に呼び、その内容に従う。Orchestrator と Ralph は対象（Workspace ID・Project ID・Role・対象 ID）だけを渡し、手順を複製しない。契約は [実装状況の Role / Skill Context](implementation-status.md#role--skill-contextの現行契約)。

## Agent の動き

### 方向から評価までの流れ

```text
Human: Intent を登録
   │
   ▼
strategist ──（調査が必要）──▶ researcher ──▶ strategist
   │ Outcome と成功条件を決め、Target Project を設定
   ▼
manager（Target Project ごと）: Story・Task に分解
   │
   ▼
worker ─▶ reviewer ─▶ 受入（manager または Human）      … Task ごとに反復
   │
   ▼
Execution Evidence を Outcome へ還流（Project Runtime Credential）
   │ 全 Target が評価可能
   ▼
evaluator: 成功条件を判定（met / not_met / insufficient_evidence）
   │
   ▼
strategist: 次の Outcome・追加 Research・Intent の完了を判断
```

### Orchestrator の起動規則

Orchestrator は周回ごとに `get_workspace_orchestration_state` で現在状態を読み、状態判定だけで起動対象を決める。Activity や event の cursor を進行の記録に使わない。

| 現在状態 | 起動する Role |
| --- | --- |
| 未終了の Research Request がある | researcher |
| 判断待ちの Evaluation がある | strategist |
| 進行中の Outcome に Target が無い／archived Target に未完了が残る／根拠にした Intent の意味が変わった | strategist |
| active な Target Project に Outcome の Story・Task が無い | その Project の manager |
| 全 Target から還流済みで評価可能 | evaluator |
| 上記の無い Active Intent（作成直後を含む） | strategist |
| 応答待ちの相談（Project / Workspace） | manager / strategist |

同じ状態への重複起動は dispatch key と起動記録で抑止する。起動記録は正本ではなく、失っても現在状態から判断をやり直せる。全規則と再試行は [orchestrator/README.md](../orchestrator/README.md)。

### Ralph のループと Task の状態

```text
todo ──claim──▶ doing ──complete──▶ in_review ──reviewed──▶ wait_accept ──accept──▶ accepted
                  ▲                     │                        │
                  └──── 再 Claim ── rejected ◀──── reject ───────┘
（todo / doing からは cancel で canceled）
```

- Ralph は `list_tasks` の `availableFor` で対象の有無を確認し、Agent を1 Task ずつ使い捨てで起動する。`auto` の順は Reviewer → Worker。
- Worker と Reviewer は別 Principal・別 Credential で接続する。Agent には自分の Role の token だけが渡る。
- Ralph は Claim を保持しない。Agent が停止した Task は Claim の期限後に再取得される。
- PR を作る Task では、Agent が Role Context の手順で push・PR 作成・登録・merge を行い、Server が GitHub 上の事実（head・merge SHA・必須 CI・レビュー根拠）を照合する（[ADR 0004](adr/0004-task-pull-request-verification.md)・[ADR 0005](adr/0005-task-pull-request-transition-verification.md)）。

詳細は [ralph/README.md](../ralph/README.md)。

### 相談（Agent から Human へ）

Agent が既存の要件・方針・権限で決められない問題は、相談として Human へ問う。

```text
Agent: create_consultation（Task は相談待ちにできる）
   ▼
Human: Web UI の「対応待ち」で返信・明示決定
   ▼
manager（Project 相談）/ strategist（Workspace 相談）: 結論を整理
   ▼
待機していた Task を再開。必要なら結論を仕様・ADR へ反映する Task を起票
```

契約は [相談](consultation-design.md) と [ADR 0002](adr/0002-collaboration-context.md)。

## Human の関与点

| 層 | Human ができること | Agent との関係 |
| --- | --- | --- |
| Mission・Intent | Web UI で登録・編集・放棄 | 保存しても Agent との対話は始まらない。Orchestrator が Strategist を起動する |
| Outcome | Web UI で作成・編集 | 通常は Strategist が決める |
| Story・Task | Web UI で起票・編集、受入・差し戻し | 通常は Manager が分解し、Worker / Reviewer が処理する |
| 実装 | なし | Agent 実行中に指示を差し込む入口は無い |
| 全層 | 相談への返信・明示決定 | Agent が必要なときに問う非同期の協調 |

## 記録の3層

| 層 | 目的 | 保存先 |
| --- | --- | --- |
| Operational Log | プロセスの動作・障害調査 | 各実行システムのログ |
| Change Log | Work の状態変更の機械的な記録 | DB（Work） |
| Activity | 意味のある履歴。Agent の文脈復元に使う | DB（Activity） |

Activity を workflow の checkpoint にしない。Repository や Docs が正本の成果物は参照だけを保持し、本文を二重管理しない。

## Compass 自身の開発に使う道具

次は Compass を開発するための道具で、製品の実行時依存ではない。

| 道具 | 用途 |
| --- | --- |
| `.mcp.json` の Wacha（`localhost:51743`） | Compass 開発の Story・Task 管理 |
| agent-foundation の Ralph（`.ralph/` の設定・実行記録） | Compass 開発の Worker / Reviewer / Manager の実行。GitHub 連携・実ブラウザ検証・復旧を含む |
| `apm.yml` で配布される Skill・hook | 開発 Agent 向けの共通手順 |

製品側の `ralph/` は agent-foundation の Ralph とは別実装で、機能範囲も異なる。

## 接続されていない箇所

設計上の流れのうち、同梱の実行システムが自動では行わない、または実 Agent で未検証の箇所。詳細は [実装状況の未実装・未接続・未検証](implementation-status.md#未実装未接続未検証)。

- 通常 Task の受入の起動: Orchestrator と製品の `ralph/` の `auto` は Manager の受入を起動しない。受入は Human の Web UI 操作か、別途起動した Manager が行う。開発で使う agent-foundation の Ralph は受入まで起動する。
- Execution Evidence の還流: Project Runtime Credential を持つ Runtime の操作で、Orchestrator は行わない。
- 実 Agent による Workspace Direction（Intent → Strategist → Researcher → Manager → Evaluator）の通し運転と、常駐した継続運転は未検証。結合テストの起動先は fixture。
- Intent の観測値の自動取得、説明の自動生成は未接続。
- 複数ホストでの Orchestrator の重複抑止は無い。
