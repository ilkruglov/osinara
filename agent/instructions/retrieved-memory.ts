/**
 * Turn-scoped retrieved long-term memory.
 *
 * Export:
 * - Eve dynamic instructions containing only authorized memory records as untrusted data.
 *
 * Key constructs:
 * - The runtime event supplies the durable turn ID used to bind writable profile subject refs.
 * - Records enter durable history as a user-role message before the current delivery. The system
 *   prefix therefore stays byte-identical between turns and the provider prompt cache covers the
 *   whole conversation instead of only the permanent instructions.
 * - Fail-closed notices remain system-role so they outrank untrusted data.
 */
import { defineDynamic, defineInstructions } from "eve/instructions";

import { resolveMemoryBlock } from "../lib/prompt/turn-blocks.js";
import { isMemoryReviewSession } from "../lib/memory-review/memory-review-session.js";

const INVALID_TURN_BLOCK = [
  "AGENT_MEMORY_TURN_CONTEXT_INVALID: Не удалось проверить идентификатор текущего хода.",
  "Не используй долговременную память в этом ответе и предложи пользователю повторить запрос.",
].join(" ");

function turnIdFromEvent(event: unknown): string | null {
  if (typeof event !== "object" || event === null || !("data" in event)) return null;
  const data = event.data;
  if (typeof data !== "object" || data === null || !("turnId" in data)) return null;
  return typeof data.turnId === "string" && data.turnId.length > 0 ? data.turnId : null;
}

export default defineDynamic({
  events: {
    "turn.started": async (event, ctx) => {
      if (isMemoryReviewSession(ctx)) return null;
      // Eve exposes the durable turn identity on the lifecycle event, not the resolve context.
      const turnId = turnIdFromEvent(event);
      if (turnId === null) return defineInstructions({ content: INVALID_TURN_BLOCK, role: "system" });
      const block = await resolveMemoryBlock(ctx, turnId);
      return block === null ? null : defineInstructions({ content: block.markdown, role: block.role });
    },
  },
});
