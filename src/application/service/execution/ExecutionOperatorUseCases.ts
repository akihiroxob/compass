import { parseTaskCommentInput, parseTaskReasonInput } from "../../../shared/executionOperatorSchema.ts";
import { ConflictError } from "../../error/ConflictError.ts";
import { CoordinationError } from "../../error/CoordinationError.ts";
import { ValidationError } from "../../error/ValidationError.ts";
import type { TaskCoordinationService } from "./TaskCoordinationService.ts";

type ExecutionOperator = Pick<
  TaskCoordinationService,
  "acceptTaskAsOperator" | "rejectTaskAsOperator" | "cancelTaskAsOperator" | "addTaskCommentAsOperator"
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
