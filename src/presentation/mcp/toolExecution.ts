import { ConflictError } from "../../application/error/ConflictError.ts";
import { CoordinationError } from "../../application/error/CoordinationError.ts";
import { ForbiddenError } from "../../application/error/ForbiddenError.ts";
import { InstructionUnavailableError } from "../../application/error/InstructionUnavailableError.ts";
import { NotFoundError } from "../../application/error/NotFoundError.ts";
import { UnauthenticatedError } from "../../application/error/UnauthenticatedError.ts";
import { ValidationError } from "../../application/error/ValidationError.ts";

export const result = (value: unknown, message?: string) => {
  const plainValue = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  return {
    content: [{ type: "text" as const, text: message ?? JSON.stringify(plainValue, null, 2) }],
    structuredContent: plainValue,
  };
};

/**
 * toolの実行結果を、成功はstructuredContent、想定内のエラーは`{ error: { code, message } }`（isError）にする。
 * Execution（旧Wacha）のCoordinationErrorは、旧Wachaの契約どおり`retryable`を含め、本文を`CODE: message`にする。
 */
export const execute = async (operation: () => Promise<unknown>) => {
  try {
    return result(await operation());
  } catch (error) {
    if (error instanceof CoordinationError) {
      return { ...result({ error: error.toJSON() }, `${error.code}: ${error.message}`), isError: true };
    }
    if (
      error instanceof ValidationError ||
      error instanceof NotFoundError ||
      error instanceof ConflictError ||
      error instanceof ForbiddenError ||
      error instanceof UnauthenticatedError ||
      error instanceof InstructionUnavailableError
    ) {
      return {
        ...result({
          error: {
            code: error.code,
            message: error.message,
            ...(error instanceof ValidationError ? { issues: error.issues } : {}),
            ...(error instanceof ConflictError || error instanceof ForbiddenError ? error.details : {}),
          },
        }),
        isError: true,
      };
    }
    throw error;
  }
};
