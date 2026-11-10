import { AsyncLocalStorage } from "node:async_hooks";
import type { ActivityActor, ActivityActorContext } from "../../application/activityActor.ts";

/** 同じ非同期操作内のtransaction・Activity observerへ主体を伝えるNode実装。 */
export class NodeActivityActorContext implements ActivityActorContext {
  private readonly storage = new AsyncLocalStorage<ActivityActor>();

  current(): ActivityActor | null {
    return this.storage.getStore() ?? null;
  }

  run<T>(actor: ActivityActor, operation: () => Promise<T>): Promise<T> {
    return this.storage.run(actor, operation);
  }
}

/** Serverのcompositionとtransaction adapterで共有する実行Context。 */
export const activityActorContext: ActivityActorContext = new NodeActivityActorContext();
