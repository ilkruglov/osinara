/**
 * Records that the messages shown to a running turn reached a model call.
 *
 * Exports:
 * - `recordTurnInterjectionDelivery`: at model step N, marks claims returned during earlier steps as
 *   delivered and frees claims of an attempt Eve threw away.
 * - `finishTurnInterjectionDelivery`: at the end of the turn, the same rule against the last step,
 *   and the rest goes back to ordinary processing.
 *
 * Key constructs:
 * - A step starts only after every tool of the previous step has finished, so its prompt carries
 *   each result returned before it. The model's own action events are no proof: with parallel calls
 *   a fast tool can return while the model is still requesting the next one.
 * - Eve re-runs an interrupted step with the same index and the history of the completed attempt
 *   only (review, 28 September 2026): the step number, not the moment, decides what was delivered.
 * - A failed record is retried once and repeated at the end of the turn; if both fail the message
 *   reaches its ordinary turn as a new one, which can at most repeat a reply, never drop it.
 */
import type { SessionAuth } from "eve/context";

import { turnInterjectionRepository } from "./turn-interjection-repository.js";
import { resolveTurnInterjectionScope } from "./turn-interjection-scope.js";

type DeliveryContext = { session: { auth: SessionAuth; id: string; parent?: unknown; turn: { id: string } } };
type Repository = Pick<typeof turnInterjectionRepository, "finishTurn" | "stepStarted">;

async function twice(ctx: DeliveryContext, stage: string, operation: () => Promise<unknown>): Promise<void> {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await operation();
      return;
    } catch (error) {
      console.error(JSON.stringify({
        attempt,
        code: "AGENT_TURN_INTERJECTION_DELIVERY_RECORD_FAILED",
        error: error instanceof Error ? error.message : String(error),
        eveSessionId: ctx.session.id,
        eveTurnId: ctx.session.turn.id,
        stage,
      }));
    }
  }
}

export async function recordTurnInterjectionDelivery(
  ctx: DeliveryContext,
  stepIndex: number,
  repository: Repository = turnInterjectionRepository,
): Promise<void> {
  if (resolveTurnInterjectionScope(ctx) === null) return;
  await twice(ctx, "step", () => repository.stepStarted(ctx.session.id, ctx.session.turn.id, stepIndex));
}

export async function finishTurnInterjectionDelivery(
  ctx: DeliveryContext,
  repository: Repository = turnInterjectionRepository,
): Promise<void> {
  if (resolveTurnInterjectionScope(ctx) === null) return;
  await twice(ctx, "turn", () => repository.finishTurn(ctx.session.id, ctx.session.turn.id));
}
