/**
 * The production browser driver of a conversation, shared by the browser tools, Lavka and Yandex Go.
 *
 * Export:
 * - `productionBrowserDriver`: the sandbox runner's driver for a sandbox session.
 *
 * Key construct:
 * - Whoever restarts a hung browser (any of the three), the saved look of that sandbox goes with it:
 *   the page it describes is closed, and nothing may be acted on or reported from it.
 */
import { SANDBOX_RUNNER_BASE_URL } from "../../config.js";
import { SandboxRunnerClient } from "../sandbox-runner/runner-client.js";
import { createSandboxBrowserDriver, type BrowserDriver } from "./browser-driver.js";
import { lookRepository } from "./look-repository.js";

const runner = new SandboxRunnerClient(SANDBOX_RUNNER_BASE_URL);

export function productionBrowserDriver(input: { sandboxSessionId: string; signal?: AbortSignal }): BrowserDriver {
  return createSandboxBrowserDriver({
    onRestart: () => lookRepository.resetSandbox(input.sandboxSessionId),
    runner,
    sandboxSessionId: input.sandboxSessionId,
    ...(input.signal ? { signal: input.signal } : {}),
  });
}
