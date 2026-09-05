/**
 * Turn-scoped delegation role instructions for every conversation trust zone.
 *
 * Export:
 * - Interactive root conversations receive orchestration rules.
 * - Scheduled, memory-review, and child turns receive no recursive delegation guidance.
 */
import { defineDynamic, defineInstructions } from "eve/instructions";

import { ORCHESTRATOR_DELEGATION_RULES } from "../lib/prompt/delegation-fragments.js";
import { isMemoryReviewSession } from "../lib/memory-review/memory-review-session.js";

export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) => {
      if (
        ctx.channel.kind === "subagent" ||
        isMemoryReviewSession(ctx)
      ) {
        return null;
      }
      return defineInstructions({ markdown: ORCHESTRATOR_DELEGATION_RULES });
    },
  },
});
