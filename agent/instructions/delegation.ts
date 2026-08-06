/**
 * Turn-scoped trusted delegation role instructions.
 *
 * Export:
 * - Every root conversation receives orchestration rules; child copies receive no recursive guidance.
 */
import { defineDynamic, defineInstructions } from "eve/instructions";

import { ORCHESTRATOR_DELEGATION_RULES } from "../lib/prompt/delegation-fragments.js";

export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) => {
      if (ctx.channel.kind === "subagent") return null;
      return defineInstructions({ markdown: ORCHESTRATOR_DELEGATION_RULES });
    },
  },
});
