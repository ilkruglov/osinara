/**
 * The production Yandex Go client: the sandbox runner's Chromium of this conversation.
 *
 * Export:
 * - `yandexTaxiClientFor`: a client bound to the tool context's sandbox session, so each family
 *   member uses the Yandex account logged in in their own sandbox.
 */
import type { ToolContext } from "eve/tools";

import { SANDBOX_RUNNER_BASE_URL } from "../../config.js";
import { createSandboxBrowserDriver } from "../browser/browser-driver.js";
import { SandboxRunnerClient } from "../sandbox-runner/runner-client.js";
import { sandboxSessionId } from "../sessions/session-context.js";
import { createYandexTaxiClient, type YandexTaxiClient } from "./yandex-taxi-client.js";

const runner = new SandboxRunnerClient(SANDBOX_RUNNER_BASE_URL);

export function yandexTaxiClientFor(ctx: ToolContext): YandexTaxiClient {
  return createYandexTaxiClient({ driver: createSandboxBrowserDriver({ runner, sandboxSessionId: sandboxSessionId(ctx), signal: ctx.abortSignal }) });
}
