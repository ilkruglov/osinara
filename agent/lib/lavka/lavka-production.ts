/**
 * The production Lavka client: the sandbox runner's Chromium of this conversation.
 *
 * Export:
 * - `lavkaClientFor`: a client bound to the tool context's sandbox session.
 */
import type { SessionContext } from "eve/context";
import type { ToolContext } from "eve/tools";

import { productionBrowserDriver } from "../browser/production-browser-driver.js";
import { sandboxSessionId } from "../sessions/session-context.js";
import { requireWorkspaceAuthorization } from "../workspaces/workspace-context.js";
import { createLavkaClient, lavkaAddressKey, type LavkaClient } from "./lavka-client.js";
import { lavkaDeliveryPointRepository } from "./lavka-delivery-point-repository.js";

export function lavkaClientFor(ctx: ToolContext): LavkaClient {
  return createLavkaClient({ driver: productionBrowserDriver({ sandboxSessionId: sandboxSessionId(ctx), signal: ctx.abortSignal }) });
}

/** The requester's delivery point for the confirmation window: its label and fingerprint; null when none is chosen. */
export async function loadLavkaDeliveryPoint(ctx: Pick<SessionContext, "session">): Promise<{ key: string; label: string } | null> {
  const auth = requireWorkspaceAuthorization(ctx);
  if (auth.userId === null) return null;
  const point = await lavkaDeliveryPointRepository.find(auth.userId);
  return point === null ? null : { key: lavkaAddressKey(point), label: point.label };
}
