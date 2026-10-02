import type { Kysely, Transaction } from "kysely";
import type { AccessDatabase } from "@compass/access";
import type { DirectionDatabase } from "@compass/direction";
import type { WorkDatabase } from "@compass/work";
import type { Database } from "./schema.ts";

/** serverまたは各Contextの型で持つ接続・transaction（Transactionは同じ型のKyselyでもある）。 */
type AnyDatabase = Kysely<Database> | Kysely<DirectionDatabase> | Kysely<WorkDatabase> | Kysely<AccessDatabase>;

/**
 * 単一SQLite fileの接続（またはtransaction）を、各Contextが所有するtableだけの型で渡す。
 * 同じ接続・同じtransactionを共有し、型だけを狭める。Kyselyの型はDBについて不変なため、合成側（server）で変換する。
 */
export const asDirectionDatabase = (database: AnyDatabase): Kysely<DirectionDatabase> =>
  database as unknown as Kysely<DirectionDatabase>;

export const asWorkDatabase = (database: AnyDatabase): Kysely<WorkDatabase> => database as unknown as Kysely<WorkDatabase>;

export const asAccessDatabase = (database: AnyDatabase): Kysely<AccessDatabase> =>
  database as unknown as Kysely<AccessDatabase>;

/** Contextが渡した接続・transactionを、server（全table）の型へ戻す。同じ接続・transactionのまま読み書きする。 */
export const asApplicationDatabase = (database: AnyDatabase): Kysely<Database> => database as unknown as Kysely<Database>;

/** Directionが渡したtransactionを、Accessのtableの型へ変える。同じtransactionのまま書く。 */
export const asAccessTransaction = (transaction: Transaction<DirectionDatabase>): Transaction<AccessDatabase> =>
  transaction as unknown as Transaction<AccessDatabase>;
