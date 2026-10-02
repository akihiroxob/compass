import {
  parseCreateTaskInput,
  parseEditTaskInput,
  parseStoryInput,
  parseTaskCommentInput,
  parseTaskReasonInput,
} from "./executionOperatorSchema.ts";
import { ConflictError, ValidationError } from "@compass/shared";
import { CoordinationError } from "./error/CoordinationError.ts";
import type { TaskCoordinationService } from "./TaskCoordinationService.ts";

type ExecutionOperator = Pick<
  TaskCoordinationService,
  | "acceptTaskAsOperator"
  | "rejectTaskAsOperator"
  | "cancelTaskAsOperator"
  | "addTaskCommentAsOperator"
  | "issueStoryAsOperator"
  | "editStoryAsOperator"
  | "issueTaskAsOperator"
  | "editTaskAsOperator"
>;

/**
 * Human向けWeb APIのCoordinationErrorを、既存のHTTP対応（400 / 409）へ変換する。状態の競合（Claim中・不正な状態）は
 * `409 CONFLICT`で、`conflict`に旧Wachaのコードを残す。Task・Claim・Change Logは変更されていない。
 */
const translate = async <T>(run: () => Promise<T>): Promise<T> => {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof CoordinationError)) throw error;
    if (error.code === "INVALID_INPUT") throw new ValidationError(error.message);
    throw new ConflictError(error.message, { conflict: error.code });
  }
};

/**
 * Human operatorのTask介入（Task 46。U3）。認可（Membershipのeditor以上）は入口が済ませ、`operatorPrincipalId`は
 * 入口がHumanから導出する。状態遷移・Change Logの規則はExecution serviceに1つだけ置く。
 */
export class AcceptExecutionTaskUseCase {
  constructor(private readonly execution: ExecutionOperator) {}

  execute(projectId: string, operatorPrincipalId: string, taskId: string) {
    return translate(() => this.execution.acceptTaskAsOperator(operatorPrincipalId, projectId, taskId));
  }
}

export class RejectExecutionTaskUseCase {
  constructor(private readonly execution: ExecutionOperator) {}

  execute(projectId: string, operatorPrincipalId: string, taskId: string, input: unknown) {
    const { reason } = parseTaskReasonInput(input);
    return translate(() => this.execution.rejectTaskAsOperator(operatorPrincipalId, projectId, taskId, reason));
  }
}

export class CancelExecutionTaskUseCase {
  constructor(private readonly execution: ExecutionOperator) {}

  execute(projectId: string, operatorPrincipalId: string, taskId: string, input: unknown) {
    const { reason } = parseTaskReasonInput(input);
    return translate(() => this.execution.cancelTaskAsOperator(operatorPrincipalId, projectId, taskId, reason));
  }
}

export class AddExecutionTaskCommentUseCase {
  constructor(private readonly execution: ExecutionOperator) {}

  execute(projectId: string, operatorPrincipalId: string, taskId: string, input: unknown) {
    const { body } = parseTaskCommentInput(input);
    return translate(() => this.execution.addTaskCommentAsOperator(operatorPrincipalId, projectId, taskId, body));
  }
}

/**
 * Human operatorのStory・Task手動起票・編集（Task 47。U4）。認可（Membershipの`execution.plan`）は入口が済ませる。
 * Outcomeの相関ID・`taskKey`は入力で受け付けず、handoffのStory・Taskへの変更はExecution serviceが拒否する。
 */
export class CreateExecutionStoryUseCase {
  constructor(private readonly execution: ExecutionOperator) {}

  execute(projectId: string, operatorPrincipalId: string, input: unknown) {
    const values = parseStoryInput(input);
    return translate(() => this.execution.issueStoryAsOperator(operatorPrincipalId, projectId, values));
  }
}

export class EditExecutionStoryUseCase {
  constructor(private readonly execution: ExecutionOperator) {}

  execute(projectId: string, operatorPrincipalId: string, storyId: string, input: unknown) {
    const values = parseStoryInput(input);
    return translate(() => this.execution.editStoryAsOperator(operatorPrincipalId, projectId, storyId, values));
  }
}

export class CreateExecutionTaskUseCase {
  constructor(private readonly execution: ExecutionOperator) {}

  execute(projectId: string, operatorPrincipalId: string, input: unknown) {
    const values = parseCreateTaskInput(input);
    return translate(() => this.execution.issueTaskAsOperator(operatorPrincipalId, projectId, values));
  }
}

export class EditExecutionTaskUseCase {
  constructor(private readonly execution: ExecutionOperator) {}

  execute(projectId: string, operatorPrincipalId: string, taskId: string, input: unknown) {
    const values = parseEditTaskInput(input);
    return translate(() => this.execution.editTaskAsOperator(operatorPrincipalId, projectId, taskId, values));
  }
}
