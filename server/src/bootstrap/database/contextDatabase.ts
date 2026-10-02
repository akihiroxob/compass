import type { Kysely, Transaction } from "kysely";
import type { DirectionDatabase } from "@compass/direction";
import type { Database } from "./schema.ts";

/**
 * 単一SQLite fileの接続（またはtransaction）を、Directionが所有するtableだけの型で渡す。
 * 同じ接続・同じtransactionを共有し、型だけを狭める。Kyselyの型はDBについて不変なため、合成側（server）で変換する。
 */
export const asDirectionDatabase = (database: Kysely<Database> | Transaction<Database>): Kysely<DirectionDatabase> =>
  database as unknown as Kysely<DirectionDatabase>;

/** Directionが渡したtransactionを、server（Accessのtableを含む全table）の型へ戻す。同じtransactionのまま書く。 */
export const asApplicationTransaction = (transaction: Transaction<DirectionDatabase>): Transaction<Database> =>
  transaction as unknown as Transaction<Database>;
