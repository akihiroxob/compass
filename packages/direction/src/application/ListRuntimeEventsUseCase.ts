import type { RuntimeEvent } from "../domain/RuntimeEvent.ts";
import type { ProjectRepository } from "../domain/ProjectRepository.ts";
import type { RuntimeEventRepository } from "../domain/RuntimeEventRepository.ts";
import { parseRuntimeEventQuery } from "./runtimeEventSchema.ts";
import { NotFoundError } from "@compass/shared";

/**
 * Runtimeが起動条件を取得するための読取。Runtimeが`cursor`を保持して差分を取得する。
 * Compassはイベントの配送・polling・retry・timeoutを持たず、Agentも起動しない。
 */
export class ListRuntimeEventsUseCase {
  constructor(
    private readonly projectRepository: ProjectRepository,
    private readonly runtimeEventRepository: RuntimeEventRepository,
  ) {}

  async execute(projectId: string, input: unknown = {}): Promise<RuntimeEvent[]> {
    const query = parseRuntimeEventQuery(input);
    if (!(await this.projectRepository.exists(projectId))) {
      throw new NotFoundError(`Project ${projectId} was not found`);
    }
    return this.runtimeEventRepository.findAfter(projectId, query.afterCursor, query.limit);
  }
}
