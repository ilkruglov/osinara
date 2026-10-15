/**
 * The reply gate: a typed second opinion on every answer Mia sends to an external group.
 *
 * Exports:
 * - `observeReplyGate`: after delivery, reads the exchange from the journal, asks Jev the fixed
 *   rubric about the candidate and records the verdict next to the turn. Shadow mode: nothing is
 *   blocked, the answer is already in the chat; the verdicts calibrate the threshold against the
 *   owner's labels before the gate ever changes a reply.
 * - `recordTurnResponseKind`: how Mia actually answered this turn (text, reaction, silence).
 * - `REPLY_GATE_AVAILABLE`: whether a TypeSafe key is configured.
 *
 * Key constructs:
 * - The gate is a measurement, so it never throws into the turn: a vendor failure is recorded as
 *   `unavailable`, a missing trigger or key as `skipped`, anything else is logged.
 * - The prompt of the main model is untouched: the gate is a separate call with its own short
 *   state, so the provider cache of the turn is not affected.
 */
import { isScheduledSession } from "../agent-schedules/scheduled-session.js";
import { telegramGroupJournalRepository } from "../telegram-group-journal-repository.js";
import { runtimeVersions, type RuntimeVersions } from "../turn-quality/runtime-versions.js";
import type { TurnEvaluationIdentity } from "../turn-quality/turn-evaluation-repository.js";
import { turnIdentity, type TurnIdentityContext } from "../turn-quality/turn-identity.js";
import { createJevClient, JevClientError, type JevClient, type JevDecision } from "./jev-client.js";
import { REPLY_GATE_QUESTIONS, REPLY_GATE_REGISTERS, type ReplyGateQuestionKey } from "./reply-gate-questions.js";
import { replyGateRepository, type ReplyGateScores, type ReplyGateVerdictInput, type TurnResponseKind } from "./reply-gate-repository.js";
import { buildReplyGateState, REPLY_GATE_RECENT_LIMIT, type ReplyGateEntry } from "./reply-gate-state.js";

export const REPLY_GATE_AVAILABLE = typeof process.env.TYPESAFE_API_KEY === "string" && process.env.TYPESAFE_API_KEY.length > 0;
/** The contiguous recent block the excerpt and the metrics are computed over. */
export const JOURNAL_LIMIT = REPLY_GATE_RECENT_LIMIT + 8;

export interface ReplyGateDependencies {
  client: JevClient | null;
  listRecent: (input: { groupId: string; messageThreadId: string | null }) => Promise<readonly ReplyGateEntry[]>;
  recordResponseKind: (identity: TurnEvaluationIdentity, kind: TurnResponseKind, versions: RuntimeVersions) => Promise<void>;
  recordVerdict: (identity: TurnEvaluationIdentity, input: ReplyGateVerdictInput) => Promise<void>;
  versions: () => RuntimeVersions;
}

type TurnContext = TurnIdentityContext & { session: { turn: { id: string } } };

let defaultClient: JevClient | null | undefined;

function defaultDependencies(): ReplyGateDependencies {
  if (defaultClient === undefined) {
    const apiKey = process.env.TYPESAFE_API_KEY;
    defaultClient = typeof apiKey === "string" && apiKey.length > 0 ? createJevClient({ apiKey }) : null;
  }
  return {
    client: defaultClient,
    listRecent: (input) => telegramGroupJournalRepository.listRecent({
      anchorEntryId: null, beforeSequence: null, groupId: input.groupId, limit: JOURNAL_LIMIT, messageThreadId: input.messageThreadId,
    }),
    recordResponseKind: (identity, kind, versions) => replyGateRepository.recordResponseKind(identity, kind, versions),
    recordVerdict: (identity, input) => replyGateRepository.recordVerdict(identity, input),
    versions: runtimeVersions,
  };
}

function evaluationIdentity(ctx: TurnContext): TurnEvaluationIdentity | null {
  if (isScheduledSession(ctx)) return null;
  const identity = turnIdentity(ctx);
  if (!identity) return null;
  return {
    chatKind: identity.chatKind, eveSessionId: ctx.session.id, eveTurnId: ctx.session.turn.id,
    familyId: identity.familyId, telegramChatId: identity.telegramChatId, triggeringEntryId: identity.triggeringEntryId,
  };
}

/** Our own failures (journal, database) are logged with their message; vendor text never is. */
function logFailure(code: string, ctx: TurnContext, error: unknown): void {
  console.error(JSON.stringify({
    code, error: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200),
    eveSessionId: ctx.session.id, eveTurnId: ctx.session.turn.id,
  }));
}

/** Jev answers under our keys with the asked types; anything else is a vendor contract break. */
function scoresOf(decision: JevDecision<ReplyGateQuestionKey>): ReplyGateScores {
  const { answers } = decision;
  const noul = (key: "asked" | "escalates" | "repeats_self" | "third_party") => {
    const answer = answers[key];
    if (answer.type !== "noul") throw new JevClientError("AGENT_JEV_RESPONSE_INVALID", `${key}: ожидался noul`);
    return Math.min(1, Math.max(0, answer.noul));
  };
  const register = answers.register;
  const worth = answers.worth;
  if (register.type !== "choice" || worth.type !== "score") throw new JevClientError("AGENT_JEV_RESPONSE_INVALID", "register/worth: не тот тип");
  // The option name is not echoed: whatever the vendor returned here must not reach the logs.
  if (!(REPLY_GATE_REGISTERS as readonly string[]).includes(register.choice)) {
    throw new JevClientError("AGENT_JEV_RESPONSE_INVALID", "register: вариант вне списка");
  }
  return {
    asked: noul("asked"), escalates: noul("escalates"), register: register.choice,
    registerConfidence: Math.min(1, Math.max(0, register.confidence)), repeatsSelf: noul("repeats_self"),
    thirdParty: noul("third_party"), worth: Math.min(3, Math.max(0, worth.score)),
  };
}

export async function recordTurnResponseKind(
  ctx: TurnContext,
  kind: TurnResponseKind,
  dependencies: ReplyGateDependencies = defaultDependencies(),
): Promise<void> {
  const identity = evaluationIdentity(ctx);
  if (!identity) return;
  try {
    await dependencies.recordResponseKind(identity, kind, dependencies.versions());
  } catch (error) {
    logFailure("AGENT_TURN_EVALUATION_RESPONSE_KIND_FAILED", ctx, error);
  }
}

export async function observeReplyGate(
  ctx: TurnContext,
  input: { candidate: string; forumTopicId: string | null; groupId: string; ownMessageIds: readonly string[] },
  dependencies: ReplyGateDependencies = defaultDependencies(),
): Promise<void> {
  const identity = evaluationIdentity(ctx);
  if (!identity || identity.chatKind !== "external") return;
  const versions = dependencies.versions();
  const skipped = (errorCode: string): ReplyGateVerdictInput => ({ errorCode, latencyMs: null, metrics: null, model: null, scores: null, status: "skipped", versions });
  try {
    if (!dependencies.client) {
      await dependencies.recordVerdict(identity, skipped("AGENT_REPLY_GATE_NOT_CONFIGURED"));
      return;
    }
    if (!identity.triggeringEntryId) {
      await dependencies.recordVerdict(identity, skipped("AGENT_REPLY_GATE_TRIGGER_MISSING"));
      return;
    }
    // The journal adds reply ancestors in front of the recent block; the metrics need the
    // contiguous tail only, or a chain would skip the replies between an old parent and now.
    const entries = (await dependencies.listRecent({ groupId: input.groupId, messageThreadId: input.forumTopicId })).slice(-JOURNAL_LIMIT);
    const built = buildReplyGateState({
      candidate: input.candidate, entries, ownMessageIds: input.ownMessageIds, triggeringEntryId: identity.triggeringEntryId,
    });
    if (!built) {
      await dependencies.recordVerdict(identity, skipped("AGENT_REPLY_GATE_TRIGGER_MISSING"));
      return;
    }
    try {
      const decision = await dependencies.client.decide(built.state, REPLY_GATE_QUESTIONS);
      const scores = scoresOf(decision);
      await dependencies.recordVerdict(identity, {
        errorCode: null, latencyMs: decision.latencyMs, metrics: built.metrics, model: decision.model, scores, status: "scored", versions,
      });
      console.info(JSON.stringify({
        code: "AGENT_REPLY_GATE_SCORED", eveSessionId: ctx.session.id, eveTurnId: ctx.session.turn.id,
        latencyMs: decision.latencyMs, model: decision.model, ...built.metrics, ...scores, inputTokens: decision.usage.inputTokens,
      }));
    } catch (error) {
      if (!(error instanceof JevClientError)) throw error;
      await dependencies.recordVerdict(identity, {
        errorCode: error.code, latencyMs: null, metrics: built.metrics, model: null, scores: null, status: "unavailable", versions,
      });
      console.warn(JSON.stringify({
        code: "AGENT_REPLY_GATE_UNAVAILABLE", error: error.code, eveSessionId: ctx.session.id, eveTurnId: ctx.session.turn.id, status: error.status,
      }));
    }
  } catch (error) {
    logFailure("AGENT_REPLY_GATE_FAILED", ctx, error);
  }
}
