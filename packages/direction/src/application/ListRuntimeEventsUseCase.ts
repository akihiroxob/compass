import type { RuntimeEvent } from "../domain/RuntimeEvent.ts";
import type { DirectionWorkspaceReader } from "./port/DirectionWorkspaceReader.ts";
import type { RuntimeEventRepository } from "../domain/RuntimeEventRepository.ts";
import { parseRuntimeEventQuery } from "./runtimeEventSchema.ts";
import { NotFoundError } from "@compass/shared";

/**
 * Runtimeが起動条件を取得するための読取。Runtimeが`cursor`を保持して差分を取得する。
 * Compassはイベントの配送・polling・retry・timeoutを持たず、Agentも起動しない。
 */
export class ListRuntimeEventsUseCase {
  constructor(
    private readonly workspaceReader: DirectionWorkspaceReader,
    private readonly runtimeEventRepository: RuntimeEventRepository,
  ) {}

  async execute(workspaceId: string, input: unknown = {}): Promise<RuntimeEvent[]> {
    const query = parseRuntimeEventQuery(input);
    if (!(await this.workspaceReader.findById(workspaceId))) {
      throw new NotFoundError(`Workspace ${workspaceId} was not found`);
    }
    return this.runtimeEventRepository.findAfter(workspaceId, query.afterCursor, query.limit);
  }
}
