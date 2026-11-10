# AI Native DDD

## 目的と適用

業務の意味と不変条件をコードに表し、人とAgentが変更の影響を理解しながら継続的に改善できる設計を作る。DDDとClean Architectureを基盤とし、利用者の要件、Project固有の設計・Policy、既存の整合した構造を踏まえて適用する。Projectが別の方針を明示した場合はそれに従う。

Story・Task・設計文書・判断記録とコードを対応付け、業務用語と責務を一貫させる。関連部分に構造上の不整合があれば既存配置をそのまま踏襲せず、変更後の全体が保守しやすくなるよう整える。必要な範囲変更はManagerと調整する。差分の小ささやファイル数より、責務・依存方向・理解しやすさを優先する。

## 戦略的な境界

業務能力と用語の意味が異なる領域をBounded Contextとして区別する。Contextごとにモデルと不変条件の所有者を定め、他Contextは公開された契約や必要な参照を通じて利用する。別ContextのEntityを複製して所有したり、共通ディレクトリに業務概念を無秩序に集めたりしない。複数Contextの一貫性や処理の境界が必要なら明示して設計する。

## 戦術DDD

- **Entity**: 識別子とライフサイクルを持つ業務概念を表す。状態遷移や自身で守れる不変条件を、生成・操作の境界で検証する。単なるDB行やAPI応答の写しにしない。
- **Value Object**: 値の意味、妥当性、等価性を表す。識別子、期間、金額などで誤用や重複検証を防げる場合に使い、可能な限り不変にする。
- **Aggregate**: 同時に成立すべき不変条件とトランザクションの境界から決める。外部の変更はAggregate Rootの操作を通し、他Aggregateは必要な識別子で参照する。読み取りの都合だけで巨大なAggregateを作らない。
- **Domain Service**: 特定のEntityやValue Objectに自然に置けない業務判断・計算を表す。アプリケーションの操作手順やDBアクセスをDomain Serviceに混ぜない。
- **Repository**: DomainまたはApplicationが必要とする永続化の契約を内側に置き、DB固有の実装をInfrastructureに置く。Aggregateや操作の境界を反映し、永続化技術をDomainへ漏らさない。
- **Domain Event**: 業務上意味のある出来事をContext間の連携などに必要な場合に表す。配送方式とログをDomain Eventそのものと混同しない。

すべてをclassにする必要はない。型、関数、classのいずれでも、業務上の制約が明確で不正な状態を作りにくい形を選ぶ。用語やファイルの数を増やすためにモデルを作らない。

## 層と依存方向

- **Domain**: Entity、Value Object、Aggregate、業務判断、不変条件。DB・HTTP・フレームワーク・環境変数などの外部技術に依存しない。
- **Application**: Use Caseの順序、認可やトランザクションの適用、Domainと外部Portの協調を扱う。業務判断をDomainから重複実装しない。
- **Infrastructure**: Repositoryや外部Gatewayの実装、DB・外部API・ファイルとの接続。内側の契約を実装する。
- **Presentation / MCP**: 入力を受けて認証・入力変換しApplicationに委譲し、結果を応答に変換する。業務ルールを入口ごとに複製しない。
- **Bootstrap**: 設定を読み、InfrastructureとUse Caseを生成・注入し、実行入口を組み立てる。業務判断を置かない。大きくなる場合はContextや責務ごとに組み立てを分ける。

依存方向は外側から内側へ向ける。RepositoryやGatewayのインターフェースは、Domainの契約ならDomain、Use Case固有の入出力ならApplicationのPortに置く。Infrastructureが内側の型を参照し、DomainやApplicationが具体的なDB・外部SDKに依存しない。トランザクションとContext間の一貫性は必要な一単位として扱い、個別RepositoryのDIだけで自動的に保証されると考えない。

## デフォルトのディレクトリ構成

Project固有の構成が未指定の場合、実行単位を分け、その内部で責務と業務領域を表す。これは配置の出発点であり、空のディレクトリを先に作らない。単一サーバーなら単一の`src/`、独立してbuild・deployする実行単位が複数ある場合は、モノレポ内でそれぞれを分ける。

```text
<実行単位>/src/
  domain/
    <業務領域>/       # 領域が複数ある場合
      model/          # Entity・Value Object・Aggregate
      service/        # Domain Service
      repository/     # Domainが必要とする契約
  application/
    usecase/<業務領域>/
    port/             # Use Case固有の外部契約
  infrastructure/
    database/         # 接続・schema・migrationとの接続
    repository/       # Repositoryの技術別実装
    gateway/          # 外部サービスの実装
  presentation/       # HTTP等の入口
  mcp/                # Agent向け入口がある場合
  bootstrap/          # 依存の組み立て・起動
```

関連するModel・Service・Repositoryを業務領域でまとめるか、Model・Service等を先に分けるかは、Project内で一貫させる。Contextを独立したpackageとして管理する場合は、各packageに必要な層を置き、実行単位のbootstrapで組み立てる。実行・配備境界がないことだけを理由に`apps/`やpackageを先に増やさない。

React UIはfeature単位の責務と共通コンポーネントを優先し、サーバーのDomain層をそのまま画面へ持ち込まない。UIの詳細は`principles/frontend-architecture.md`に従う。

## 変更・レビュー時の判断

1. 用語、利用シナリオ、所有Context、不変条件、既存の公開契約を確認する。
2. 変更する業務ルールと、それを守るEntity・Value Object・Aggregate・Domain Serviceを検討する。
3. Use Caseの手順、必要なPort、トランザクションと並行操作の境界を決める。
4. 実装の重複や肥大、境界違反、変更の連鎖があれば、関連範囲の構造を必要な粒度で整理する。大きな変更が必要ならStory／Taskを適切に分割する。
5. 業務上の正常・異常・競合と永続化後の整合性を、変更に見合う方法で確認する。レビューでは名前や配置だけでなく、不変条件がすべての入口から守られるかを確認する。

小さな変更を理由にDomainへ外部技術を持ち込んだり、既存の不整合を固定したりしない。一方、今の要件に根拠のない抽象・空の層・将来用の拡張点は作らない。
