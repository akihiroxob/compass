import type { RuntimeEvent } from "../model/RuntimeEvent.ts";

export interface RuntimeEventRepository {
  /** 指定したProjectのイベントを、cursorが`afterCursor`より大きいものだけ昇順で最大`limit`件返す。別Projectのイベントは返さない。 */
  findAfter(projectId: string, afterCursor: number, limit: number): Promise<RuntimeEvent[]>;
}
