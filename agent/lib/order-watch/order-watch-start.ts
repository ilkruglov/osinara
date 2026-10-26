/**
 * Starting and stopping order watches from a tool call in the person's private chat.
 *
 * Exports:
 * - `startOrderWatch`: follows an order from the current chat's sandbox into the current chat; a
 *   failure is logged and reported as `false`, never failing the order that was just placed.
 * - `stopOrderWatches`: stops the person's watches of a service, or of one order.
 */
import type { ToolContext } from "eve/tools";

import { sandboxSessionId } from "../sessions/session-context.js";
import type { OrderWatchService } from "./order-watch-config.js";
import { orderWatchRepository } from "./order-watch-repository.js";
import type { OrderWatchState } from "./order-watch-status.js";

export async function startOrderWatch(
  ctx: ToolContext,
  input: { familyId: string; initialState: OrderWatchState | null; orderId: string; service: OrderWatchService; userId: string },
  repository: Pick<typeof orderWatchRepository, "start"> = orderWatchRepository,
): Promise<boolean> {
  try {
    const telegramChatId = ctx.session.auth.current?.attributes.telegramChatId;
    if (typeof telegramChatId !== "string" || telegramChatId.length === 0) throw new Error("telegram_chat_missing");
    await repository.start({ ...input, now: new Date(), sandboxSessionId: sandboxSessionId(ctx), telegramChatId });
    return true;
  } catch (error) {
    console.error(JSON.stringify({ code: "AGENT_ORDER_WATCH_START_FAILED", error: error instanceof Error ? error.message.slice(0, 120) : "unknown", service: input.service }));
    return false;
  }
}

export async function stopOrderWatches(input: { orderId?: string | undefined; service: OrderWatchService; userId: string }): Promise<number> {
  return await orderWatchRepository.stop(input);
}
