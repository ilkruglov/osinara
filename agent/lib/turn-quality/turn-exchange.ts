/**
 * Model-free facts about how a turn answered and the exchange around it.
 *
 * Exports:
 * - `recordTurnResponseKind`: how Mia actually answered this turn (text, reaction, silence).
 * - `observeTurnExchange`: after delivery in an external group, reads the exchange from the journal
 *   and records the trigger kind, the reply chain depth and the same-author run next to the turn.
 * - `TurnExchangeDependencies`: injectable journal, repository and versions, for tests.
 *
 * Key constructs:
 * - A measurement never throws into the turn: any failure is logged with its code and the turn
 *   identity, never with message text.
 * - The journal adds reply ancestors in front of the recent block; the metrics need the contiguous
 *   tail only, or a chain would skip the replies between an old parent and now.
 */
import { isScheduledSession } from "../agent-schedules/scheduled-session.js";
import { telegramGroupJournalRepository } from "../telegram-group-journal-repository.js";
import { runtimeVersions, type RuntimeVersions } from "./runtime-versions.js";
import type { TurnEvaluationIdentity } from "./turn-evaluation-repository.js";
import {
  measureTurnExchange,
  type ExchangeEntry,
  type ExchangeMetrics,
} from "./turn-exchange-metrics.js";
import { turnExchangeRepository, type TurnResponseKind } from "./turn-exchange-repository.js";
import { turnIdentity, type TurnIdentityContext } from "./turn-identity.js";

/** The contiguous recent block the metrics are computed over. */
export const EXCHANGE_JOURNAL_LIMIT = 20;

export interface TurnExchangeDependencies {
  listRecent: (input: {
    groupId: string;
    messageThreadId: string | null;
  }) => Promise<readonly ExchangeEntry[]>;
  recordMetrics: (
    identity: TurnEvaluationIdentity,
    metrics: ExchangeMetrics,
    versions: RuntimeVersions,
  ) => Promise<void>;
  recordResponseKind: (
    identity: TurnEvaluationIdentity,
    kind: TurnResponseKind,
    versions: RuntimeVersions,
  ) => Promise<void>;
  versions: () => RuntimeVersions;
}

type TurnContext = TurnIdentityContext & { session: { turn: { id: string } } };

const defaultDependencies: TurnExchangeDependencies = {
  listRecent: (input) =>
    telegramGroupJournalRepository.listRecent({
      anchorEntryId: null,
      beforeSequence: null,
      groupId: input.groupId,
      limit: EXCHANGE_JOURNAL_LIMIT,
      messageThreadId: input.messageThreadId,
    }),
  recordMetrics: (identity, metrics, versions) =>
    turnExchangeRepository.recordMetrics(identity, metrics, versions),
  recordResponseKind: (identity, kind, versions) =>
    turnExchangeRepository.recordResponseKind(identity, kind, versions),
  versions: runtimeVersions,
};

function evaluationIdentity(ctx: TurnContext): TurnEvaluationIdentity | null {
  if (isScheduledSession(ctx)) return null;
  const identity = turnIdentity(ctx);
  if (!identity) return null;
  return {
    chatKind: identity.chatKind,
    eveSessionId: ctx.session.id,
    eveTurnId: ctx.session.turn.id,
    familyId: identity.familyId,
    telegramChatId: identity.telegramChatId,
    triggeringEntryId: identity.triggeringEntryId,
  };
}

function logFailure(code: string, ctx: TurnContext, error: unknown): void {
  console.error(
    JSON.stringify({
      code,
      error: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200),
      eveSessionId: ctx.session.id,
      eveTurnId: ctx.session.turn.id,
    }),
  );
}

export async function recordTurnResponseKind(
  ctx: TurnContext,
  kind: TurnResponseKind,
  dependencies: TurnExchangeDependencies = defaultDependencies,
): Promise<void> {
  const identity = evaluationIdentity(ctx);
  if (!identity) return;
  try {
    await dependencies.recordResponseKind(identity, kind, dependencies.versions());
  } catch (error) {
    logFailure("AGENT_TURN_EVALUATION_RESPONSE_KIND_FAILED", ctx, error);
  }
}

export async function observeTurnExchange(
  ctx: TurnContext,
  input: { forumTopicId: string | null; groupId: string; ownMessageIds: readonly string[] },
  dependencies: TurnExchangeDependencies = defaultDependencies,
): Promise<void> {
  const identity = evaluationIdentity(ctx);
  if (!identity || identity.chatKind !== "external" || !identity.triggeringEntryId) return;
  try {
    const entries = (
      await dependencies.listRecent({ groupId: input.groupId, messageThreadId: input.forumTopicId })
    ).slice(-EXCHANGE_JOURNAL_LIMIT);
    const metrics = measureTurnExchange({
      entries,
      ownMessageIds: input.ownMessageIds,
      triggeringEntryId: identity.triggeringEntryId,
    });
    if (!metrics) return;
    await dependencies.recordMetrics(identity, metrics, dependencies.versions());
  } catch (error) {
    logFailure("AGENT_TURN_EXCHANGE_FAILED", ctx, error);
  }
}
