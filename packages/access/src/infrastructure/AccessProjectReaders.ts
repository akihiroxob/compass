import type { Kysely, Transaction } from "kysely";
import type { ProjectStateReader } from "../application/port/ProjectStateReader.ts";
import type { AccessDatabase } from "./schema.ts";

export type AccessExecutor = Kysely<AccessDatabase> | Transaction<AccessDatabase>;

/**
 * Project（Directionが所有）の状態を、Accessから渡した接続・transactionのまま読む実装。serverが配線する。
 * archive検査と書込を同じtransactionで行うため、Repositoryはtransactionごとに呼ぶ。
 */
export type AccessProjectReaders = (executor: AccessExecutor) => ProjectStateReader;
