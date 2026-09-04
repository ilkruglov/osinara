/**
 * Turn-scoped announcement of the reaction set Telegram accepts in the current chat.
 *
 * Export:
 * - Eve dynamic user-role instructions carrying the verified set, authored once per change.
 *
 * The filename orders this block after the mode rules that reference it and before the volatile
 * memory payload. The set is user-role because it belongs to the conversation and must survive as
 * one announcement instead of being rebuilt into the system prefix on every turn.
 */
import { defineDynamic, defineInstructions } from "eve/instructions";

import { resolveReactionSetBlock } from "../lib/prompt/turn-blocks.js";
import { isMemoryReviewSession } from "../lib/memory-review/memory-review-session.js";

export default defineDynamic({
  events: {
    "turn.started": async (_event, ctx) => {
      if (isMemoryReviewSession(ctx)) return null;
      const content = await resolveReactionSetBlock(ctx);
      return content === null ? null : defineInstructions({ content, role: "user" });
    },
  },
});
