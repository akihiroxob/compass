import type { Intent } from "../domain/Intent.ts";
import type { IntentRepository } from "../domain/IntentRepository.ts";
import type { DirectionWorkspaceReader } from "./port/DirectionWorkspaceReader.ts";
import type { DirectionActorPort } from "./port/DirectionActorPort.ts";
import { parseUpdateIntentInput } from "./intentSchema.ts";
import { versionConflict } from "./intentVersionConflict.ts";
import { ConflictError, NotFoundError, ValidationError } from "@compass/shared";
import { WorkspaceArchivedError } from "@compass/organization";

/**
 * Active中のIntentを、編集の元にした版（`expectedVersion`）が現在版と一致するときだけ更新する。
 * 保存のたびに版を進め、変更主体・理由を履歴に残す。Outcomeを持つIntentの意味を変える場合は理由を必須にし、
 * 既存のOutcome・判断・評価は作成時の版を参照したまま書き換えない。影響する未完了のOutcomeは再計画の対象になる。
 */
export class UpdateIntentUseCase {
  constructor(
    private readonly workspaceReader: DirectionWorkspaceReader,
    private readonly intentRepository: IntentRepository,
    private readonly actor: DirectionActorPort,
  ) {}

  async execute(workspaceId: string, intentId: string, input: unknown): Promise<Intent> {
    const parsed = parseUpdateIntentInput(input);
    if (!(await this.workspaceReader.findById(workspaceId))) {
      throw new NotFoundError(`Workspace ${workspaceId} was not found`);
    }
    const result = await this.intentRepository.update(workspaceId, intentId, parsed, this.actor.current());
    if (result.kind === "workspace_archived") throw new WorkspaceArchivedError(workspaceId);
    if (result.kind === "not_found") {
      throw new NotFoundError(`Intent ${intentId} was not found in Workspace ${workspaceId}`);
    }
    if (result.kind === "not_active") {
      throw new ConflictError(`Intent ${intentId} is ${result.status} and can no longer be edited`, {
        status: result.status,
      });
    }
    if (result.kind === "version_conflict") throw versionConflict(intentId, result.currentVersion);
    if (result.kind === "reason_required") {
      throw new ValidationError(
        `Intent ${intentId} has Outcomes, so a reason is required to change ${result.fields.join(" and ")}`,
        [{ path: "reason", message: "reason is required when changing the meaning of an Intent that has Outcomes" }],
      );
    }
    return result.intent;
  }
}
