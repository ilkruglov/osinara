/**
 * The production Yandex Go client: the sandbox runner's Chromium of this conversation.
 *
 * Export:
 * - `yandexTaxiClientFor`: a client bound to the tool context's sandbox session, so each family
 *   member uses the Yandex account logged in in their own sandbox.
 */
import type { ToolContext } from "eve/tools";

import { productionBrowserDriver } from "../browser/production-browser-driver.js";
import { sandboxSessionId } from "../sessions/session-context.js";
import { createYandexTaxiClient, type YandexTaxiClient } from "./yandex-taxi-client.js";

export function yandexTaxiClientFor(ctx: ToolContext): YandexTaxiClient {
  return createYandexTaxiClient({ driver: productionBrowserDriver({ sandboxSessionId: sandboxSessionId(ctx), signal: ctx.abortSignal }) });
}
