/**
 * Turn-scoped retrieved long-term memory instructions.
 *
 * Export:
 * - Eve dynamic instructions containing only authorized memory records as untrusted data.
 *
 * The filename orders this block last, so the volatile per-turn payload never invalidates the
 * cacheable prefix formed by the permanent instructions and the mode rulebook.
 */
import { defineDynamic, defineInstructions } from "eve/instructions";

import { resolveMemoryBlock } from "../lib/prompt/turn-blocks.js";

export default defineDynamic({
  events: {
    "turn.started": async (_event, ctx) => {
      const markdown = await resolveMemoryBlock(ctx);
      return markdown === null ? null : defineInstructions({ markdown });
    },
  },
});
