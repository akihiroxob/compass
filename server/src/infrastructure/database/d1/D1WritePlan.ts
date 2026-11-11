import { sql, type CompiledQuery, type KyselyPlugin, type PluginTransformQueryArgs, type PluginTransformResultArgs } from "kysely";
import type { D1Database } from "@cloudflare/workers-types";
import type { Database } from "../schema.ts";
import { createD1Database } from "./D1Dialect.ts";
import { D1ReadSet } from "./D1ReadSet.ts";
import { D1AtomicBatch } from "./D1AtomicBatch.ts";

type Table = keyof Database;
type Row = Record<string, unknown>;
export type D1PlanTables = Partial<Record<Table, { key: readonly string[]; rowIdColumn?: string }>>;
type Entry = { key: Row; row: Row | null; rowId: number };
type Overlay = { columns: string[]; entries: Map<string, Entry> };

const field = (name: string) => {
  if (!/^[a-z_][a-z_0-9]*$/.test(name)) throw new Error(`Unsupported planned SQL column: ${name}`);
  return name;
};
const referencedTables = (value: unknown, result = new Set<string>()): Set<string> => {
  if (Array.isArray(value)) { for (const child of value) referencedTables(child, result); return result; }
  if (!value || typeof value !== "object") return result;
  const node = value as { kind?: string; table?: { schema?: unknown; identifier?: { name: string } } };
  if (node.kind === "ValueNode") return result;
  if (node.kind === "TableNode" && !node.table?.schema && node.table?.identifier) result.add(node.table.identifier.name);
  for (const child of Object.values(value)) referencedTables(child, result);
  return result;
};

/**
 * callbackは保存計画だけを作る。通常のSELECTへCTEを加えてread-your-writesを提供し、
 * 実DBへの書込は、読取結果の再検査と同じnative batchで一度だけ行う。
 */
export class D1WritePlan implements KyselyPlugin {
  readonly reads = new D1ReadSet();
  readonly statements: CompiledQuery[] = [];
  private readonly compiler;
  readonly database;
  private readonly overlays = new Map<Table, Overlay>();
  private readonly rowIds = new Map<Table, number>();

  constructor(private readonly binding: D1Database, private readonly tables: D1PlanTables) {
    this.compiler = createD1Database(binding);
    this.database = createD1Database(binding, { readOnly: true, readExecutor: this.reads.execute }).withPlugin(this);
  }

  transformQuery({ node }: PluginTransformQueryArgs) {
    if (node.kind !== "SelectQueryNode" || !this.overlays.size) return node;
    const references = referencedTables(node);
    const expressions = [];
    for (const [table, overlay] of this.overlays) {
      if (!references.has(table)) continue;
      if (node.with?.expressions.some((expression) => expression.name.table.table.identifier.name === table)) throw new Error(`Planned table conflicts with query CTE: ${table}`);
      const entries = [...overlay.entries.values()];
      const keys = this.metadata(table).key;
      const columns = [...overlay.columns, "rowid"];
      const unchanged = sql.join(columns.map((column) => sql.ref(`base.${field(column)}`)));
      const keyMatch = sql.join(keys.map((key) => sql`${sql.ref(`base.${field(key)}`)} IS json_extract(changed.value, ${sql.lit(`$.${key}`)})`), sql` AND `);
      const changed = entries.filter(({ row }) => row !== null).map(({ row, rowId }) => ({ ...row, rowid: rowId }));
      const selected = sql.join(columns.map((column) => sql`json_extract(staged.value, ${sql.lit(`$.${field(column)}`)})`));
      const view = sql<Row>`SELECT ${unchanged} FROM ${sql.id("main", table)} AS base
        WHERE NOT EXISTS (SELECT 1 FROM json_each(${JSON.stringify(entries.map(({ key }) => key))}) AS changed WHERE ${keyMatch})
        UNION ALL SELECT ${selected} FROM json_each(${JSON.stringify(changed)}) AS staged`;
      const operation = this.compiler.with(table, () => sql<Row>`(${view})`).selectNoFrom(sql<number>`1`.as("unused")).toOperationNode();
      expressions.push(operation.with!.expressions[0]!);
    }
    if (!expressions.length) return node;
    return { ...node, with: { kind: "WithNode" as const, recursive: node.with?.recursive,
      expressions: [...expressions, ...node.with?.expressions ?? []] } };
  }

  async transformResult({ result }: PluginTransformResultArgs) {
    return { ...result, rows: result.rows.map((row) => { const { rowid: _rowid, ...record } = row; return record; }) };
  }

  async nextRowId(table: Table): Promise<number> {
    this.metadata(table);
    if (!this.rowIds.has(table)) {
      const result = await this.database.selectFrom(table).select(sql<number>`coalesce(max(rowid), 0)`.as("maximum")).executeTakeFirstOrThrow();
      this.rowIds.set(table, Number(result.maximum));
    }
    const next = this.rowIds.get(table)! + 1;
    this.rowIds.set(table, next);
    return next;
  }

  async insert<T extends object>(table: Table, input: T): Promise<T> {
    const row = { ...input } as Row;
    const metadata = this.metadata(table);
    const key = this.key(table, row), encoded = JSON.stringify(key);
    const pending = this.overlays.get(table)?.entries.get(encoded);
    if (pending?.row) throw new Error(`Duplicate planned ${table} record`);
    if (!pending) {
      const existing = this.compiler.selectFrom(table).select(sql<number>`1`.as("found")).where(this.predicate(key));
      this.reads.guards.push(sql`SELECT 1 WHERE NOT EXISTS ${existing}`.compile(this.compiler));
    }
    const rowId = metadata.rowIdColumn ? Number(row[metadata.rowIdColumn]) : await this.nextRowId(table);
    if (!Number.isSafeInteger(rowId) || rowId <= 0) throw new Error(`Invalid planned rowid for ${table}`);
    const values = metadata.rowIdColumn ? row : { ...row, rowid: rowId };
    const columns = Object.keys(values).map(field);
    this.statements.push(sql`INSERT INTO ${sql.id("main", table)} (${sql.join(columns.map((column) => sql.id(column)))}) VALUES (${sql.join(columns.map((column) => sql`${values[column]}`))})`.compile(this.compiler));
    this.stage(table, key, row, rowId);
    return structuredClone(input);
  }

  async update<T extends object>(table: Table, key: Row, patch: T, required: Row = {}): Promise<Row | null> {
    const existing = await this.find(table, key);
    if (!existing || Object.entries(required).some(([column, value]) => existing.row[column] !== value)) return null;
    const changes = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
    if (!Object.keys(changes).length) return existing.row;
    for (const column of this.metadata(table).key) if (column in changes && changes[column] !== existing.row[column]) throw new Error("Planned updates cannot change primary keys");
    const row = { ...existing.row, ...changes };
    this.statements.push(sql`UPDATE ${sql.id("main", table)} SET ${sql.join(Object.entries(changes).map(([column, value]) => sql`${sql.id(field(column))} = ${value}`))} WHERE ${this.predicate(key)}`.compile(this.compiler));
    this.stage(table, this.key(table, row), row, existing.rowId);
    return structuredClone(row);
  }

  async upsert<T extends object>(table: Table, input: T): Promise<void> {
    const key = this.key(table, input as Row);
    if (await this.find(table, key)) await this.update(table, key, input);
    else await this.insert(table, input);
  }

  async delete(table: Table, key: Row): Promise<void> {
    const existing = await this.find(table, key);
    if (!existing) return;
    this.statements.push(sql`DELETE FROM ${sql.id("main", table)} WHERE ${this.predicate(key)}`.compile(this.compiler));
    this.stage(table, this.key(table, existing.row), null, existing.rowId, Object.keys(existing.row));
  }

  add(...statements: CompiledQuery[]) { this.statements.push(...statements); }
  async commit() { await new D1AtomicBatch(this.binding).execute(this.reads.guards, this.statements.length ? this.statements : [sql`SELECT 1`.compile(this.compiler)]); }
  async dispose() { await Promise.all([this.database.destroy(), this.compiler.destroy()]); }

  private metadata(table: Table) { const metadata = this.tables[table]; if (!metadata) throw new Error(`Table is not owned by this D1 plan: ${table}`); return metadata; }
  private key(table: Table, row: Row): Row {
    return Object.fromEntries(this.metadata(table).key.map((column) => {
      if (!(column in row)) throw new Error(`Missing planned primary key ${table}.${column}`);
      return [column, row[column]];
    }));
  }
  private predicate(key: Row) { return sql<boolean>`${sql.join(Object.entries(key).map(([column, value]) => sql`${sql.id(field(column))} IS ${value}`), sql` AND `)}`; }
  private async find(table: Table, key: Row) {
    this.metadata(table);
    const row = await this.database.selectFrom(table).selectAll().select(sql<number>`rowid`.as("__plan_rowid")).where(this.predicate(key)).executeTakeFirst();
    if (!row) return null;
    const { __plan_rowid, ...values } = row;
    return { row: values as Row, rowId: Number(__plan_rowid) };
  }
  private stage(table: Table, key: Row, row: Row | null, rowId: number, columns = Object.keys(row!)) {
    const overlay = this.overlays.get(table) ?? { columns, entries: new Map<string, Entry>() };
    if (row && (overlay.columns.length !== columns.length || !columns.every((column) => overlay.columns.includes(column)))) throw new Error(`Inconsistent planned columns for ${table}`);
    overlay.entries.set(JSON.stringify(key), { key, row: row ? structuredClone(row) : null, rowId });
    this.overlays.set(table, overlay);
  }
}
