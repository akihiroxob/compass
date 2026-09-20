import { ConflictError } from "../../application/error/ConflictError.ts";
import { NotFoundError } from "../../application/error/NotFoundError.ts";
import { ValidationError } from "../../application/error/ValidationError.ts";
import type { ApplicationServices } from "../../createApplicationServices.ts";

export const cliUsage = [
  "Usage:",
  "  npm run cli -- grant  <projectId> <AgentName> <role>",
  "  npm run cli -- revoke <projectId> <AgentName> <role>",
  "  npm run cli -- grants <projectId>",
  "roles: strategist",
].join("\n");

export type CliResult = { stdout: string; stderr: string; exitCode: 0 | 1 | 2 };

const success = (body: unknown): CliResult => ({ stdout: JSON.stringify(body), stderr: "", exitCode: 0 });

const usageError = (message: string): CliResult => ({ stdout: "", stderr: `${message}\n${cliUsage}`, exitCode: 2 });

const failure = (error: unknown): CliResult => {
  const body =
    error instanceof ValidationError
      ? { code: error.code, message: error.message, issues: error.issues }
      : error instanceof NotFoundError || error instanceof ConflictError
        ? { code: error.code, message: error.message }
        : { code: "INTERNAL_ERROR", message: error instanceof Error ? error.message : String(error) };
  return { stdout: "", stderr: JSON.stringify({ error: body }), exitCode: 1 };
};

/**
 * Web APIと同じUse Caseを呼ぶCLI。標準出力はAPIと同じ形のJSON、失敗は標準エラーの`{ error }`。
 * 終了コード: 成功0（存在しないGrantの取消も0）、検証・存在などの失敗1、引数の不足・未知のコマンド2。
 */
export const runCli = async (argv: string[], services: ApplicationServices): Promise<CliResult> => {
  const [command, ...args] = argv;
  try {
    switch (command) {
      case "grant": {
        const [projectId, principalId, role, ...extra] = args;
        if (projectId === undefined || principalId === undefined || role === undefined || extra.length) {
          return usageError("grant requires <projectId> <AgentName> <role>");
        }
        const { grant, created } = await services.grantProjectRoleUseCase.execute(projectId, { principalId, role });
        return success({ grant, created });
      }
      case "revoke": {
        const [projectId, principalId, role, ...extra] = args;
        if (projectId === undefined || principalId === undefined || role === undefined || extra.length) {
          return usageError("revoke requires <projectId> <AgentName> <role>");
        }
        return success({ revoked: await services.revokeProjectRoleUseCase.execute(projectId, { principalId, role }) });
      }
      case "grants": {
        const [projectId, ...extra] = args;
        if (projectId === undefined || extra.length) return usageError("grants requires <projectId>");
        return success({ grants: await services.listProjectGrantsUseCase.execute(projectId) });
      }
      default:
        return usageError(command === undefined ? "a command is required" : `unknown command: ${command}`);
    }
  } catch (error) {
    return failure(error);
  }
};
