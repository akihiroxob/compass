/**
 * Projectがarchivedのため書込を拒否した結果。Project配下の書込（Intent・Outcome等）は、
 * 各Repositoryが書込と同一transactionでProjectの状態を検査してこの結果を返す。
 */
export type ProjectArchivedResult = { kind: "project_archived" };
