import type { Kysely, Transaction } from "kysely";
import type { DirectionDatabase } from "./schema.ts";

/**
 * Directionが書込と同じtransactionで読むProject（Organizationが所有）の状態。DirectionはOrganizationのtableを
 * 直接扱わず、serverが同じ接続・transactionで読む実装を渡す。
 */
export type DirectionProjectReaders = (executor: Kysely<DirectionDatabase> | Transaction<DirectionDatabase>) => {
  /** Projectがarchivedか。Projectが無い場合はfalse（存在の扱いは各操作に任せる）。 */
  isArchived(projectId: string): Promise<boolean>;
  /** Projectに登録されたRepository。他Projectのidは見つからない扱い。 */
  findRepository(projectId: string, repositoryId: string): Promise<{ id: string; name: string; url: string } | undefined>;
  /** Projectの所属WorkspaceのConstraints（正本）。並び順を保つ。 */
  findConstraints(projectId: string): Promise<string[]>;
};
