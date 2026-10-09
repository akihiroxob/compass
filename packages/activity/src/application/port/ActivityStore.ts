import type { ActivityScopeReader } from "./ActivityScopeReader.ts";
import type { Activity, ActivityEntityKind } from "../../domain/Activity.ts";

/** 保存するActivity。`cursor`は保存時に採番する。 */
export type NewActivity = Omit<Activity, "cursor"> & {
  /**
   * 再送・二重生成を1件に収束させるkey（全体で一意）。明示記録は`recorded:{principalId}:{requestId}`、
   * canonicalは生成元の状態変更（例: `work_change:{cursor}`）。
   */
  dedupeKey: string;
  /** 明示記録の検証済み入力のhash。同じkeyを別の内容で再利用したかを判定する。canonicalはnull。 */
  inputHash: string | null;
};

export type ActivityQuery = {
  /** これより後（昇順）。差分取得用。 */
  afterCursor?: number;
  /** これより前（降順）。新しい順のページング用。`afterCursor`と同時には使わない。 */
  beforeCursor?: number;
  limit: number;
  principalId?: string;
  role?: string;
  type?: string;
  /** このEntity（またはProject Resource）を参照するActivityだけ。 */
  ref?: { kind: ActivityEntityKind | "project_resource"; id: string };
};

/** Activityの保存。追記だけで、更新・削除は持たない。 */
export interface ActivityStore {
  /**
   * `dedupeKey`が未保存なら追記する。既に同じkeyがあれば追記せず、保存済みのActivityとそのhashを返す。
   * 呼び出し元の状態変更と同じtransactionで呼べば、状態変更とActivityは同時に確定・巻き戻る。
   */
  append(activity: NewActivity): Promise<{ activity: Activity; created: boolean; inputHash: string | null }>;
  find(activityId: string): Promise<Activity | null>;
  /** `dedupeKey`で保存済みのActivityとそのhash。未保存ならnull。 */
  findByDedupeKey(dedupeKey: string): Promise<{ activity: Activity; inputHash: string | null } | null>;
  /** `scope=project`で、`afterCursor`があれば`cursor`の昇順、なければ降順。 */
  listProject(projectId: string, query: ActivityQuery): Promise<Activity[]>;
  /** Workspace scopeのみ。同じWorkspaceに所属するProject Activityは含めない。 */
  listWorkspace(workspaceId: string, query: ActivityQuery): Promise<Activity[]>;
  maxWorkspaceCursor(workspaceId: string): Promise<number>;
  /** このActivityを訂正したActivity（`cursor`の昇順）。 */
  listCorrections(activityId: string): Promise<Activity[]>;
  /** Project（無ければ0）の最新cursor。 */
  maxProjectCursor(projectId: string): Promise<number>;
}

/** 明示記録のProject / Workspace状態・所属解決・参照検証とappendを同じtransactionで行う。 */
export interface ActivityUnitOfWork {
  execute<T>(work: (store: ActivityStore, scopes: ActivityScopeReader) => Promise<T>): Promise<T>;
}
