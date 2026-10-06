import type { Kysely, Transaction } from "kysely";
import type { DirectionDatabase } from "./schema.ts";

/** OrganizationのWorkspace状態を、Directionの書込と同じtransactionで読む。 */
export type DirectionWorkspaceReaders = (executor: Kysely<DirectionDatabase> | Transaction<DirectionDatabase>) => {
  isArchived(workspaceId: string): Promise<boolean>;
};
