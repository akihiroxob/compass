import { ProjectRole } from "../../constants/ProjectRole.ts";
import type { RuntimeEventFetch } from "../../domain/model/RuntimeEventDelivery.ts";
import type { ProjectRepository } from "../../domain/repository/ProjectRepository.ts";
import type { RuntimeEventRepository } from "../../domain/repository/RuntimeEventRepository.ts";
import { parseRuntimeEventQuery } from "../../shared/runtimeEventSchema.ts";
import { NotFoundError } from "../error/NotFoundError.ts";
import type { Principal, ProjectAuthorizationService } from "../service/ProjectAuthorizationService.ts";

/**
 * 外部Runtimeが、自分（consumer）にとって未処理のイベントをcursor付きで取得する。
 * consumerはBearerから解決したPrincipalで、入力からは受け取らない。取得は読取専用のため、応答が失われても
 * 次の取得で同じイベントを返し、欠落しない（at-least-once）。重複した起動は、イベントの`id`と`ack`で防ぐ。
 * `nextCursor`は同じ周回のページ送り用で、再起動後の再開には未確定イベントを追い越さない`resumeCursor`を使う。
 * Agentの起動・polling間隔・backoffはRuntimeの責務で、Compassは持たない。
 */
export class FetchRuntimeEventsUseCase {
  constructor(
    private readonly authorization: ProjectAuthorizationService,
    private readonly projectRepository: ProjectRepository,
    private readonly runtimeEventRepository: RuntimeEventRepository,
  ) {}

  async execute(principal: Principal, projectId: string, input: unknown = {}): Promise<RuntimeEventFetch> {
    // 認可はProjectの存在確認より先。Grantを持たないPrincipalへProjectの存在有無を漏らさない。
    const consumerId = await this.authorization.requireRole(principal, projectId, ProjectRole.RUNTIME);
    const query = parseRuntimeEventQuery(input);
    if (!(await this.projectRepository.exists(projectId))) {
      throw new NotFoundError(`Project ${projectId} was not found`);
    }
    const events = await this.runtimeEventRepository.findPending(projectId, consumerId, query.afterCursor, query.limit);
    return {
      events,
      nextCursor: events.at(-1)?.cursor ?? query.afterCursor,
      resumeCursor: await this.runtimeEventRepository.findResumeCursor(projectId, consumerId),
    };
  }
}
