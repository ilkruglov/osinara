/**
 * Turn-scoped user-managed operational instructions for the exact Telegram chat.
 *
 * Export:
 * - Eve dynamic instructions built from the live-authorized, XML-escaped chat prompt.
 */
import { defineDynamic, defineInstructions } from "eve/instructions";

import { resolvePreferenceBlock } from "../lib/prompt/turn-blocks.js";
import { isMemoryReviewSession } from "../lib/memory-review/memory-review-session.js";

export default defineDynamic({
  events: {
    "turn.started": async (_event, ctx) => {
      if (isMemoryReviewSession(ctx)) return null;
      const markdown = await resolvePreferenceBlock(ctx);
      return markdown === null ? null : defineInstructions({ markdown });
    },
  },
});
