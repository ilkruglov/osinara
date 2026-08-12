/**
 * Dynamic Eve skills resolved from the current trusted conversation policy.
 *
 * Export:
 * - Turn-scoped safe skill map; group changes apply on the next turn without session rotation.
 */
import { defineDynamic } from "eve/skills";

import { resolveConversationSkills } from "../lib/group-skills/group-skill-resolver.js";
import { isMemoryReviewSession } from "../lib/memory-review/memory-review-session.js";

export default defineDynamic({
  events: {
    "turn.started": async (_event, ctx) => isMemoryReviewSession(ctx)
      ? {}
      : await resolveConversationSkills(ctx.session.auth),
  },
});
