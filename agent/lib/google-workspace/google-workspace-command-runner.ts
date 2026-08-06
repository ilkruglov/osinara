/**
 * Exact-process Google Workspace CLI runner.
 *
 * Exports:
 * - `runGoogleWorkspaceCommand`: delegates exact argv to isolated one-shot runner compute.
 *
 * The child receives one reviewed argv array, one workspace cwd, and one credential profile. There
 * are no retries; timeout, output bounds, and non-zero exits become stable Russian application errors.
 */
import type { ToolContext } from "eve/tools";

import {
  GOOGLE_WORKSPACE_COMMAND_TIMEOUT_MS,
  SANDBOX_RUNNER_BASE_URL,
} from "../../config.js";
import { AppError } from "../app-error.js";
import { SandboxRunnerClient } from "../sandbox-runner/runner-client.js";
import type { GoogleIntegrationAuthorization } from "./google-integration-contract.js";

export interface GoogleWorkspaceCommandResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

const runner = new SandboxRunnerClient(SANDBOX_RUNNER_BASE_URL);

export async function runGoogleWorkspaceCommand(
  argv: readonly string[],
  auth: GoogleIntegrationAuthorization,
  accessToken: string,
  ctx: Pick<ToolContext, "abortSignal">,
): Promise<GoogleWorkspaceCommandResult> {
  let result;
  try {
    result = await runner.runGoogleWorkspace({
      accessToken,
      argv: [...argv],
      timeoutMs: GOOGLE_WORKSPACE_COMMAND_TIMEOUT_MS,
      workspaceId: auth.workspaceId,
    }, ctx.abortSignal);
  } catch (error) {
    console.error(JSON.stringify({
      code: "AGENT_GOOGLE_WORKSPACE_EXECUTION_FAILED",
      error: error instanceof Error ? error.message : String(error),
    }));
    if (error instanceof Error) {
      error.message = ctx.abortSignal.aborted
        ? "AGENT_GOOGLE_WORKSPACE_EXECUTION_CANCELLED: Выполнение команды Google Workspace отменено"
        : "AGENT_GOOGLE_WORKSPACE_EXECUTION_FAILED: Не удалось выполнить команду Google Workspace. Проверьте подключение";
    }
    throw error;
  }
  if (result.exitCode === 0) return result;

  console.error(JSON.stringify({
    code: "AGENT_GOOGLE_WORKSPACE_COMMAND_FAILED",
    exitCode: result.exitCode,
    stderr: result.stderr,
  }));
  if (result.exitCode === 124 || result.exitCode === 137) {
    throw new AppError(
      "AGENT_GOOGLE_WORKSPACE_EXECUTION_TIMEOUT",
      "Команда Google Workspace не завершилась вовремя. Проверьте результат перед повтором",
    );
  }
  throw new AppError(
    "AGENT_GOOGLE_WORKSPACE_COMMAND_FAILED",
    "Google Workspace отклонил команду. Проверьте подключение и существенные параметры",
  );
}
