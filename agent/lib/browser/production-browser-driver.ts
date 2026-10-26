/**
 * The production browser driver of a conversation, shared by the browser tools, Lavka and Yandex Go.
 *
 * Export:
 * - `productionBrowserDriver`: the sandbox runner's driver for a sandbox session.
 *
 * Key constructs:
 * - Whoever restarts a hung browser (any of the three), the saved look of that sandbox goes with it:
 *   the page it describes is closed, and nothing may be acted on or reported from it.
 * - Every command of a turn first marks the browser as the turn's, waiting while a background check
 *   holds it (`browser-hold.ts`). A background check passes its `holder` and, before each command,
 *   proves the hold is still its own: a hold that ran out stops it (`AGENT_BROWSER_HOLD_LOST`).
 */
import { SANDBOX_RUNNER_BASE_URL } from "../../config.js";
import { AppError } from "../app-error.js";
import { SandboxRunnerClient } from "../sandbox-runner/runner-client.js";
import { createSandboxBrowserDriver, type BrowserDriver } from "./browser-driver.js";
import { browserHoldRepository } from "./browser-hold.js";
import { lookRepository } from "./look-repository.js";

const runner = new SandboxRunnerClient(SANDBOX_RUNNER_BASE_URL);

export function productionBrowserDriver(input: { background?: { holder: string }; sandboxSessionId: string; signal?: AbortSignal }): BrowserDriver {
  const driver = createSandboxBrowserDriver({
    onRestart: () => lookRepository.resetSandbox(input.sandboxSessionId),
    runner,
    sandboxSessionId: input.sandboxSessionId,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const background = input.background;
  const ready = background
    ? async () => {
      input.signal?.throwIfAborted();
      if (!await browserHoldRepository.holdsStill({ holder: background.holder, sandboxSessionId: input.sandboxSessionId })) {
        throw new AppError("AGENT_BROWSER_HOLD_LOST", "Проверка заказа больше не владеет браузером");
      }
    }
    : () => browserHoldRepository.enterAsTurn(input.sandboxSessionId, input.signal);
  return {
    back: async () => { await ready(); await driver.back(); },
    eval: async (script) => { await ready(); return await driver.eval(script); },
    open: async (url) => { await ready(); await driver.open(url); },
    press: async (key) => { await ready(); await driver.press(key); },
    screenshot: async (path) => { await ready(); await driver.screenshot(path); },
    scroll: async (direction) => { await ready(); await driver.scroll(direction); },
    settle: async () => { await ready(); await driver.settle(); },
    url: async () => { await ready(); return await driver.url(); },
  };
}
