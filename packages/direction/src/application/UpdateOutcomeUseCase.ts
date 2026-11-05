import type { Outcome } from "../domain/Outcome.ts";
import type { OutcomeRepository } from "../domain/OutcomeRepository.ts";
import type { DirectionWorkspaceReader } from "./port/DirectionWorkspaceReader.ts";
import { parseUpdateOutcomeInput } from "./outcomeSchema.ts";
import { versionConflict } from "./intentVersionConflict.ts";
import { ConflictError, NotFoundError } from "@compass/shared";
import { WorkspaceArchivedError } from "@compass/organization";

/**
 * activeなOutcomeのtitle・hypothesis・課題（根拠・解決策の仮説）だけを更新する。
 * 成功条件・description・rationaleは作成時に固定され、入力に含まれた場合は黙って無視せず拒否する。
 * `expectedRevision`が現在の版と異なれば、古い版を前提にした更新として拒否する。
 */
export class UpdateOutcomeUseCase {
  constructor(
    private readonly workspaceReader: DirectionWorkspaceReader,
    private readonly outcomeRepository: OutcomeRepository,
  ) {}

  async execute(
    workspaceId: string,
    intentId: string,
    outcomeId: string,
    input: unknown,
  ): Promise<Outcome> {
    const { changes, fixedFields } = parseUpdateOutcomeInput(input);
    const workspace = await this.workspaceReader.findById(workspaceId);
    if (!workspace) throw new NotFoundError(`Workspace ${workspaceId} was not found`);
    // 固定項目の拒否はRepositoryへ進む前に行うため、archivedの拒否（409）をここでも先に返す。書込の本体はRepositoryのtransaction内で検査する。
    if (workspace.status === "archived") throw new WorkspaceArchivedError(workspaceId);
    if (fixedFields.length > 0) {
      throw new ConflictError(
        `Outcome ${outcomeId} has fields fixed at creation (${fixedFields.join(", ")}) that cannot be changed; ` +
          "cancel the Outcome and create a new one instead",
        { fixedFields: fixedFields.join(",") },
      );
    }
    const result = await this.outcomeRepository.update(workspaceId, intentId, outcomeId, changes);
    if (result.kind === "workspace_archived") throw new WorkspaceArchivedError(workspaceId);
    if (result.kind === "intent_not_found") {
      throw new NotFoundError(`Intent ${intentId} was not found in Workspace ${workspaceId}`);
    }
    if (result.kind === "outcome_not_found") {
      throw new NotFoundError(`Outcome ${outcomeId} was not found in Intent ${intentId}`);
    }
    if (result.kind === "stale_revision") {
      throw new ConflictError(
        `Outcome ${outcomeId} has been updated (current revision ${result.currentRevision}); reload it and apply the change again`,
        { conflict: "OUTCOME_STALE_REVISION", currentRevision: String(result.currentRevision) },
      );
    }
    if (result.kind === "not_active") {
      throw new ConflictError(`Outcome ${outcomeId} is ${result.status} and can no longer be edited`, {
        status: result.status,
      });
    }
    if (result.kind === "intent_version_conflict") throw versionConflict(intentId, result.currentVersion);
    return result.outcome;
  }
}
