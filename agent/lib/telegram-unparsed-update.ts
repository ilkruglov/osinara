/**
 * Verified Telegram updates that Eve does not parse, routed to their application handlers.
 *
 * Exports:
 * - `createTelegramUnparsedUpdateRouter`: injectable router for tests.
 * - `routeTelegramUnparsedUpdate`: production router for the channel's `onUnparsedUpdate`.
 *
 * Key construct:
 * - Eve 0.40.0 parses messages and button presses only; the fork hands every other verified update
 *   here. `my_chat_member` (the bot blocked, unblocked, removed from or added to a chat) marks
 *   reachability before Telegram gets 200, so its failed write fails the webhook and Telegram
 *   delivers it again. Everything else goes to the reaction recorder, which answers `ok` for any
 *   shape it does not read.
 */
import { handleMyChatMemberUpdate } from "./telegram-reachability/my-chat-member.js";
import { handleTelegramUnparsedUpdate as handleTelegramReactionUpdate } from "./turn-quality/telegram-reaction-update.js";

export interface TelegramUnparsedUpdateHandlers {
  membership(raw: Record<string, unknown>): Promise<Response>;
  reaction(raw: Record<string, unknown>): Promise<Response>;
}

export function createTelegramUnparsedUpdateRouter(handlers: TelegramUnparsedUpdateHandlers) {
  return function routeTelegramUnparsedUpdate(raw: Record<string, unknown>): Promise<Response> {
    return raw.my_chat_member !== undefined ? handlers.membership(raw) : handlers.reaction(raw);
  };
}

export const routeTelegramUnparsedUpdate = createTelegramUnparsedUpdateRouter({
  membership: (raw) => handleMyChatMemberUpdate(raw),
  reaction: (raw) => handleTelegramReactionUpdate(raw),
});
