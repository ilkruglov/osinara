/**
 * Turn-scoped retrieved long-term memory instructions.
 *
 * Export:
 * - Eve dynamic instructions containing only authorized memory records as untrusted data.
 *
 * Key construct:
 * - The runtime event supplies the durable turn ID used to bind writable profile subject refs.
 *
 * The filename orders this block last, so the volatile per-turn payload never invalidates the
 * cacheable prefix formed by the permanent instructions and the mode rulebook.
 */
import { defineDynamic, defineInstructions } from "eve/instructions";

import { resolveMemoryBlock } from "../lib/prompt/turn-blocks.js";

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
      // Eve exposes the durable turn identity on the lifecycle event, not the resolve context.
      const turnId = turnIdFromEvent(event);
      if (turnId === null) return defineInstructions({ markdown: INVALID_TURN_BLOCK });
      const markdown = await resolveMemoryBlock(ctx, turnId);
      return markdown === null ? null : defineInstructions({ markdown });
    },
  },
});
