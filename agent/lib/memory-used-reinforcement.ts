/**
 * Reinforce the memory records a delivered answer relied on.
 *
 * Export:
 * - `reinforceUsedMemories`: accepts only refs shown in this turn, bumps them, logs the rest;
 *   an answer without the directive while records were shown is logged as `AGENT_MEMORY_USED_MISSING`,
 *   an empty one as `AGENT_MEMORY_USED_NONE`. Each names the application session and its turn, the
 *   key of `AGENT_MEMORY_RETRIEVAL_TRACE`, so shown-to-used precision can be counted.
 *
 * Bookkeeping after a delivered answer: any failure is logged and never fails the turn.
 */
import type { SessionContext } from "eve/context";

import { memoryContextExposureRepository } from "./memory-context-exposure-repository.js";
import { requireMemoryAuthorization } from "./memory-context.js";
import { memoryReinforcementRepository } from "./memory-reinforcement-repository.js";

export interface ReinforceUsedMemoriesDependencies {
  exposures: Pick<typeof memoryContextExposureRepository, "sessionTurn" | "shownMemoryRefsForTurn">;
  reinforcement: Pick<typeof memoryReinforcementRepository, "reinforceByRefs">;
}

export async function reinforceUsedMemories(
  input: {
    applicationSessionId: string;
    ctx: Pick<SessionContext, "session">;
    /** The model wrote the directive, possibly empty; absent means it skipped the rule. */
    declared: boolean;
    memoryRefs: readonly string[];
    /** The turn's timeline entry, the join key of `AGENT_MEMORY_RETRIEVAL_TRACE` a failed turn cannot reuse. */
    timelineEntryId?: string | null;
  },
  dependencies: ReinforceUsedMemoriesDependencies = {
    exposures: memoryContextExposureRepository,
    reinforcement: memoryReinforcementRepository,
  },
): Promise<void> {
  try {
    const auth = requireMemoryAuthorization(input.ctx);
    const sessionTurn = await dependencies.exposures.sessionTurn(input.applicationSessionId);
    const shown = await dependencies.exposures.shownMemoryRefsForTurn(input.applicationSessionId, sessionTurn);
    if (input.memoryRefs.length === 0) {
      // An empty directive is a valid "used nothing"; a skipped directive while records were shown
      // is the only production measure of how often the rule is honoured.
      if (shown.size === 0) return;
      const line = JSON.stringify({
        applicationSessionId: input.applicationSessionId,
        code: input.declared ? "AGENT_MEMORY_USED_NONE" : "AGENT_MEMORY_USED_MISSING",
        sessionTurn,
        shown: shown.size,
        timelineEntryId: input.timelineEntryId ?? null,
      });
      if (input.declared) console.info(line);
      else console.warn(line);
      return;
    }
    const accepted = input.memoryRefs.filter((ref) => shown.has(ref));
    const rejected = input.memoryRefs.filter((ref) => !shown.has(ref));
    if (rejected.length > 0) {
      console.warn(JSON.stringify({ code: "AGENT_MEMORY_REINFORCE_REF_UNKNOWN", refs: rejected }));
    }
    if (accepted.length === 0) return;
    const result = await dependencies.reinforcement.reinforceByRefs(auth, {
      memoryRefs: accepted,
      provenance: { sessionId: input.ctx.session.id, turnId: input.ctx.session.turn.id },
      reason: "model_used",
    });
    console.info(JSON.stringify({
      applicationSessionId: input.applicationSessionId,
      code: "AGENT_MEMORY_REINFORCED",
      reason: "model_used",
      refs: result.reinforced,
      sessionTurn,
      shown: shown.size,
      timelineEntryId: input.timelineEntryId ?? null,
      ...(result.unknown.length === 0 ? {} : { unauthorized: result.unknown }),
    }));
  } catch (error) {
    console.error(JSON.stringify({
      code: "AGENT_MEMORY_REINFORCE_FAILED",
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}
