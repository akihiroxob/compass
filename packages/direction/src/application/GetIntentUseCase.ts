import type { Intent } from "../domain/Intent.ts";
import type { IntentRepository } from "../domain/IntentRepository.ts";
import type { DirectionProjectReader } from "./port/DirectionProjectReader.ts";
import { NotFoundError } from "@compass/shared";

export class GetIntentUseCase {
  constructor(
    private readonly projectReader: DirectionProjectReader,
    private readonly intentRepository: IntentRepository,
  ) {}

  async execute(projectId: string, intentId: string): Promise<Intent> {
    if (!(await this.projectReader.exists(projectId))) {
      throw new NotFoundError(`Project ${projectId} was not found`);
    }
    const intent = await this.intentRepository.findById(projectId, intentId);
    if (!intent) throw new NotFoundError(`Intent ${intentId} was not found in Project ${projectId}`);
    return intent;
  }
}
