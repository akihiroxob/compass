import type { Intent } from "../domain/Intent.ts";
import type { IntentRepository } from "../domain/IntentRepository.ts";
import type { DirectionProjectReader } from "./port/DirectionProjectReader.ts";
import { NotFoundError } from "@compass/shared";

export class ListIntentsUseCase {
  constructor(
    private readonly projectReader: DirectionProjectReader,
    private readonly intentRepository: IntentRepository,
  ) {}

  async execute(projectId: string): Promise<Intent[]> {
    if (!(await this.projectReader.exists(projectId))) {
      throw new NotFoundError(`Project ${projectId} was not found`);
    }
    return this.intentRepository.findByProject(projectId);
  }
}
