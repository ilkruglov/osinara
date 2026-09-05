/**
 * Reinforce the memory records a delivered answer relied on.
 *
 * Export:
 * - `reinforceUsedMemories`: accepts only refs shown in this turn, bumps them, logs the rest.
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
    memoryRefs: readonly string[];
  },
  dependencies: ReinforceUsedMemoriesDependencies = {
    exposures: memoryContextExposureRepository,
    reinforcement: memoryReinforcementRepository,
  },
): Promise<void> {
  if (input.memoryRefs.length === 0) return;
  try {
    const auth = requireMemoryAuthorization(input.ctx);
    const sessionTurn = await dependencies.exposures.sessionTurn(input.applicationSessionId);
    const shown = await dependencies.exposures.shownMemoryRefsForTurn(input.applicationSessionId, sessionTurn);
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
      code: "AGENT_MEMORY_REINFORCED",
      reason: "model_used",
      refs: result.reinforced,
      ...(result.unknown.length === 0 ? {} : { unauthorized: result.unknown }),
    }));
  } catch (error) {
    console.error(JSON.stringify({
      code: "AGENT_MEMORY_REINFORCE_FAILED",
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}
