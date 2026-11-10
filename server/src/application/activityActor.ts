/** 状態変更を行った主体と、その立場。Directionの多くのrecordは操作者を保存しないため、canonical Activityへはここから渡す。 */
export type ActivityActor = { principalId: string; role: string };

/** 主体を特定できない操作（起動時の補完・保守CLI・Principalなしのtrusted-local呼出し）。 */
export const systemActivityActor: ActivityActor = { principalId: "system", role: "system" };

/** 認可済み主体を操作中だけ保持する実行Context。認可判断には使用しない。 */
export interface ActivityActorContext {
  current(): ActivityActor | null;
  run<T>(actor: ActivityActor, operation: () => Promise<T>): Promise<T>;
}
