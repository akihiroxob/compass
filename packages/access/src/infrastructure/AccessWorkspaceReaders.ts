import type { WorkspaceStateReader } from "../application/port/WorkspaceStateReader.ts";
import type { AccessExecutor } from "./AccessProjectReaders.ts";

/**
 * Workspace（Organizationが所有）の状態を、Accessから渡した接続・transactionのまま読む実装。serverが配線する。
 * archive検査と書込を同じtransactionで行うため、Repositoryはtransactionごとに呼ぶ。
 */
export type AccessWorkspaceReaders = (executor: AccessExecutor) => WorkspaceStateReader;
