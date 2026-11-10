/** 一つのマイグレーションと、その適用を行う永続化境界。 */
export type Migration = { name: string; sql: string };

export interface MigrationSource {
  load(): Promise<Migration[]>;
}

export interface MigrationRepository {
  /** 適用履歴を照合し、未適用分を順に原子的に適用して名前を返す。 */
  apply(migrations: Migration[]): Promise<string[]>;
}

export class MigrateDatabaseUseCase {
  constructor(private readonly source: MigrationSource, private readonly repository: MigrationRepository) {}

  async execute(): Promise<string[]> {
    const migrations = await this.source.load();
    return this.repository.apply(migrations);
  }
}
