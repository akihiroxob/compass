import { AsyncLocalStorage } from "node:async_hooks";

/** 状態変更を行った主体と、その立場。Directionの多くのrecordは操作者を保存しないため、canonical Activityへはここから渡す。 */
export type ActivityActor = { principalId: string; role: string };

/** 主体を特定できない操作（起動時の補完・保守CLI・Principalなしのtrusted-local呼出し）。 */
export const systemActivityActor: ActivityActor = { principalId: "system", role: "system" };

const storage = new AsyncLocalStorage<ActivityActor>();

/**
 * 認可済みの主体をこの操作の間だけ固定する。入口（MCP tool・Human向けWeb API）が認可の直後に呼び、
 * Direction状態変更のcanonical Activity生成（同じ非同期文脈のtransaction）が読む。認可の判断には使わない。
 */
export const withActivityActor = <T>(actor: ActivityActor, operation: () => Promise<T>): Promise<T> =>
  storage.run(actor, operation);

export const currentActivityActor = (): ActivityActor | null => storage.getStore() ?? null;
