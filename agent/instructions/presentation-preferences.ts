/**
 * Turn-scoped presentation preference instructions.
 *
 * Export:
 * - Eve dynamic instructions built only from fixed safe preference mappings.
 */
import { defineDynamic, defineInstructions } from "eve/instructions";

import { resolvePreferenceBlock } from "../lib/prompt/turn-blocks.js";

export default defineDynamic({
  events: {
    "turn.started": async (_event, ctx) => {
      const markdown = await resolvePreferenceBlock(ctx);
      return markdown === null ? null : defineInstructions({ markdown });
    },
  },
});
