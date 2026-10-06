import type { RuntimeEventFetch } from "../domain/RuntimeEventDelivery.ts";
import type { DirectionWorkspaceReader } from "./port/DirectionWorkspaceReader.ts";
import type { RuntimeEventRepository } from "../domain/RuntimeEventRepository.ts";
import { parseRuntimeEventQuery } from "./runtimeEventSchema.ts";
import { NotFoundError } from "@compass/shared";

/**
 * 外部Runtimeが、自分（consumer）にとって未処理のイベントをcursor付きで取得する。
 * consumerはBearerから解決したPrincipalで、入力からは受け取らない。取得は読取専用のため、応答が失われても
 * 次の取得で同じイベントを返し、欠落しない（at-least-once）。重複した起動は、イベントの`id`と`ack`で防ぐ。
 * `nextCursor`は同じ周回のページ送り用で、再起動後の再開には未確定イベントを追い越さない`resumeCursor`を使う。
 * Agentの起動・polling間隔・backoffはRuntimeの責務で、Compassは持たない。
 */
export class FetchRuntimeEventsUseCase {
  constructor(
    private readonly workspaceReader: DirectionWorkspaceReader,
    private readonly runtimeEventRepository: RuntimeEventRepository,
  ) {}

  async execute(consumerId: string, workspaceId: string, input: unknown = {}): Promise<RuntimeEventFetch> {
    // 公開入口で認可済みの主体・scopeを受け取る。
    const query = parseRuntimeEventQuery(input);
    if (!(await this.workspaceReader.findById(workspaceId))) {
      throw new NotFoundError(`Workspace ${workspaceId} was not found`);
    }
    const events = await this.runtimeEventRepository.findPending(workspaceId, consumerId, query.afterCursor, query.limit);
    return {
      events,
      nextCursor: events.at(-1)?.cursor ?? query.afterCursor,
      resumeCursor: await this.runtimeEventRepository.findResumeCursor(workspaceId, consumerId),
    };
  }
}
