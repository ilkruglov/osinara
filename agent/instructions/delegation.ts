/**
 * Turn-scoped trusted delegation role instructions.
 *
 * Export:
 * - Root trusted sessions receive orchestration rules; other channels receive no root guidance.
 */
import { defineDynamic, defineInstructions } from "eve/instructions";

import { resolveConversationEnvironment } from "../lib/conversation-environment.js";
import { ORCHESTRATOR_DELEGATION_RULES } from "../lib/prompt/delegation-fragments.js";

export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) => {
      try {
        if (ctx.channel.kind === "subagent") return null;
        if (resolveConversationEnvironment(ctx.session.auth) === "external") return null;
        return defineInstructions({
          markdown: ORCHESTRATOR_DELEGATION_RULES,
        });
      } catch (error) {
        console.error(JSON.stringify({
          code: "AGENT_DELEGATION_ENVIRONMENT_INVALID",
          error: error instanceof Error ? error.message : String(error),
        }));
        return null;
      }
    },
  },
});
