/**
 * Delivery side of the turn evaluation: the ids of Mia's messages, written by the channel.
 *
 * Export:
 * - `recordTurnDelivery`: upserts the turn's reply message ids; a failure is logged, never thrown,
 *   because the answer is already delivered and bookkeeping must not fail the turn.
 */
import { isScheduledSession } from "../agent-schedules/scheduled-session.js";
import { runtimeVersions } from "./runtime-versions.js";
import { turnEvaluationRepository } from "./turn-evaluation-repository.js";
import { turnIdentity, type TurnIdentityContext } from "./turn-identity.js";

export async function recordTurnDelivery(
  ctx: TurnIdentityContext & { session: { turn: { id: string } } },
  replyMessageIds: readonly string[],
  deliveredAt: Date,
  record = turnEvaluationRepository.recordDelivery,
): Promise<void> {
  if (replyMessageIds.length === 0 || isScheduledSession(ctx)) return;
  const identity = turnIdentity(ctx);
  if (!identity) return;
  try {
    await record({
      chatKind: identity.chatKind, eveSessionId: ctx.session.id, eveTurnId: ctx.session.turn.id,
      familyId: identity.familyId, telegramChatId: identity.telegramChatId, triggeringEntryId: identity.triggeringEntryId,
    }, { deliveredAt, replyMessageIds, versions: runtimeVersions() });
  } catch (error) {
    console.error(JSON.stringify({
      code: "AGENT_TURN_EVALUATION_DELIVERY_FAILED",
      error: error instanceof Error ? error.message : String(error),
      eveSessionId: ctx.session.id,
      eveTurnId: ctx.session.turn.id,
    }));
  }
}
