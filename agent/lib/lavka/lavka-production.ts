/**
 * The production Lavka client: the sandbox runner's Chromium of this conversation.
 *
 * Export:
 * - `lavkaClientFor`: a client bound to the tool context's sandbox session.
 */
import type { SessionContext } from "eve/context";
import type { ToolContext } from "eve/tools";

import { SANDBOX_RUNNER_BASE_URL } from "../../config.js";
import { createSandboxBrowserDriver } from "../browser/browser-driver.js";
import { SandboxRunnerClient } from "../sandbox-runner/runner-client.js";
import { sandboxSessionId } from "../sessions/session-context.js";
import { requireWorkspaceAuthorization } from "../workspaces/workspace-context.js";
import { createLavkaClient, type LavkaClient } from "./lavka-client.js";
import { lavkaDeliveryPointRepository } from "./lavka-delivery-point-repository.js";

const runner = new SandboxRunnerClient(SANDBOX_RUNNER_BASE_URL);

export function lavkaClientFor(ctx: ToolContext): LavkaClient {
  return createLavkaClient({ driver: createSandboxBrowserDriver({ runner, sandboxSessionId: sandboxSessionId(ctx), signal: ctx.abortSignal }) });
}

/** The requester's delivery point label for the confirmation window; null when none is chosen. */
export async function loadLavkaDeliveryPointLabel(ctx: Pick<SessionContext, "session">): Promise<string | null> {
  const auth = requireWorkspaceAuthorization(ctx);
  if (auth.userId === null) return null;
  return (await lavkaDeliveryPointRepository.find(auth.userId))?.label ?? null;
}
