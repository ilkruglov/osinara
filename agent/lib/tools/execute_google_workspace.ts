/**
 * Typed model-facing Google Workspace execution boundary.
 *
 * Exports:
 * - `createGoogleWorkspaceExecutor`: injectable live authorization and process boundary.
 * - `execute_google_workspace`: reviewed argv execution with input-aware Eve HITL.
 */
import type { ToolContext } from "eve/tools";
import { defineTool } from "eve/tools";
import { z } from "zod";

import { AppError } from "../app-error.js";
import { withGoogleWorkspaceExecutionAccount } from "../google-workspace/google-execution-authorization.js";
import { classifyGoogleWorkspaceCommand } from "../google-workspace/google-workspace-command-policy.js";
import { runGoogleWorkspaceCommand } from "../google-workspace/google-workspace-command-runner.js";
import type { GoogleIntegrationAuthorization } from "../google-workspace/google-integration-contract.js";
import { resolveGoogleWorkspaceAuthorization } from "../google-workspace/google-workspace-context.js";
import {
  missingGoogleWorkspaceScopes,
  requireGoogleOAuthEnvironment,
} from "../google-workspace/google-workspace-config.js";
import { refreshGoogleAccessToken } from "../google-workspace/google-oauth-client.js";
import { googleWorkspaceProfileStore } from "../google-workspace/google-workspace-profile-store.js";

const commandSchema = z.object({
  argv: z.array(z.string().min(1).max(64 * 1024)).min(1).max(128).describe(
    "Точные аргументы gws без имени бинарника и без shell quoting",
  ),
}).strict();

const MODEL_FACING_OUTPUT_MAX_BYTES = 256 * 1024;

function modelFacingOutput(
  kind: "mutation" | "read",
  result: { stderr: string; stdout: string },
) {
  const byteLength = Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr);
  if (byteLength <= MODEL_FACING_OUTPUT_MAX_BYTES) {
    return { completed: true, stderr: result.stderr, stdout: result.stdout };
  }
  if (kind === "mutation") {
    // The external side effect has already completed; never return an error that could invite a
    // duplicate retry. Full oversized output is intentionally omitted from model context.
    return {
      completed: true,
      outputBytes: byteLength,
      outputTruncated: true,
      stderr: "",
      stdout: "",
    };
  }
  throw new AppError(
    "AGENT_GOOGLE_WORKSPACE_OUTPUT_TOO_LARGE",
    "Результат Google Workspace слишком велик. Уточните фильтр, период или размер страницы",
  );
}

interface GoogleWorkspaceExecutorDependencies {
  resolveAuthorization(ctx: ToolContext): Promise<GoogleIntegrationAuthorization>;
  run(
    argv: readonly string[],
    auth: GoogleIntegrationAuthorization,
    accessToken: string,
    ctx: ToolContext,
  ): ReturnType<typeof runGoogleWorkspaceCommand>;
  withAuthorizedExecution<T>(
    auth: GoogleIntegrationAuthorization,
    operation: (accessToken: string) => Promise<T>,
  ): Promise<T>;
}

async function withAuthorizedGoogleWorkspaceExecution<T>(
  auth: GoogleIntegrationAuthorization,
  operation: (accessToken: string) => Promise<T>,
): Promise<T> {
  const config = requireGoogleOAuthEnvironment();
  return await withGoogleWorkspaceExecutionAccount(auth, config.encryptionKey, async (account) => {
    const profileExists = await googleWorkspaceProfileStore.exists(auth.workspaceId);
    if (!account || missingGoogleWorkspaceScopes(account.scopes).length > 0 || !profileExists) {
      throw new AppError(
        "AGENT_GOOGLE_WORKSPACE_PROFILE_NOT_READY",
        "Профиль Google Workspace не готов. Подключите аккаунт заново",
      );
    }

    // Membership and profile locks remain active across refresh and the one-shot command.
    const accessToken = (await refreshGoogleAccessToken(config, account.refreshToken)).accessToken;
    if (!await googleWorkspaceProfileStore.exists(auth.workspaceId)) {
      throw new AppError(
        "AGENT_GOOGLE_WORKSPACE_PROFILE_CHANGED",
        "Профиль Google Workspace изменился во время подтверждения. Повторите запрос",
      );
    }
    return await operation(accessToken);
  });
}

export function createGoogleWorkspaceExecutor(dependencies: GoogleWorkspaceExecutorDependencies) {
  return async function executeGoogleWorkspace(
    input: z.infer<typeof commandSchema>,
    ctx: ToolContext,
  ) {
    // Classification is repeated inside execute so direct/replayed calls cannot bypass policy.
    const kind = classifyGoogleWorkspaceCommand(input.argv);
    const auth = await dependencies.resolveAuthorization(ctx);

    // This DB/profile check intentionally occurs after a potentially long HITL pause.
    return await dependencies.withAuthorizedExecution(auth, async (accessToken) => {
      const result = await dependencies.run(input.argv, auth, accessToken, ctx);
      return { kind, scope: auth.scope, ...modelFacingOutput(kind, result) };
    });
  };
}

const executeGoogleWorkspace = createGoogleWorkspaceExecutor({
  resolveAuthorization: resolveGoogleWorkspaceAuthorization,
  run: (argv, auth, accessToken, ctx) =>
    runGoogleWorkspaceCommand(argv, auth, accessToken, ctx),
  withAuthorizedExecution: withAuthorizedGoogleWorkspaceExecution,
});

export default defineTool({
  approval: ({ toolInput }) => {
    try {
      return classifyGoogleWorkspaceCommand(toolInput?.argv ?? []) === "mutation"
        ? "user-approval"
        : "not-applicable";
    } catch (error) {
      return {
        type: "denied",
        reason: error instanceof AppError
          ? error.message
          : "AGENT_GOOGLE_WORKSPACE_COMMAND_FORBIDDEN: Команда отсутствует в allowlist",
      };
    }
  },
  description:
    "Выполнить разрешённую команду Google Workspace в текущем personal/family профиле. Передайте точный argv без `gws`; mutation автоматически требует подтверждения Eve со всеми аргументами и должна занимать не более 3000 символов в JSON-представлении. Файловые аргументы недоступны.",
  inputSchema: commandSchema,
  async execute(input, ctx) {
    return await executeGoogleWorkspace(input, ctx);
  },
});
