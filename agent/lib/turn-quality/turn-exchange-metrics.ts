/**
 * Facts of the exchange around a turn in a group, computed from the journal without a model.
 *
 * Exports:
 * - `measureTurnExchange`: how the turn was triggered, how deep the reply chain to Mia is and how
 *   many of Mia's latest replies went to the same person.
 *
 * Key constructs:
 * - Entries arrive in timeline order and may include Mia's just-sent messages (the journal is
 *   written before the measurement runs): their Telegram ids are excluded so the turn's own answer
 *   does not count as an earlier reply.
 * - These counts are the signal for the owner's complaint of 15 October 2026 (23 answers to one
 *   person in 34 minutes); the typed reply judge that used to come with them was removed on
 *   5 November 2026, after the owner's labels showed it flagged answers he considered fine.
 */
import type { TelegramTimelineActorKind } from "../telegram-inbound-actor.js";

export interface ExchangeEntry {
  actorId: string;
  actorKind: TelegramTimelineActorKind;
  entryId?: string;
  replyToSequenceId: string | null;
  sequenceId: string;
  telegramMessageId?: string;
}

export type ExchangeTriggerKind = "addressed" | "reply_to_mia";

export interface ExchangeMetrics {
  /** How many of Mia's messages the reply chain of the triggering message passes through. */
  replyChainDepth: number;
  /** How many of Mia's latest replies before this turn answered the triggering person, consecutively. */
  sameAuthorRun: number;
  triggerKind: ExchangeTriggerKind;
}

function repliesToMia(
  entry: ExchangeEntry,
  bySequence: ReadonlyMap<string, ExchangeEntry>,
): boolean {
  const target =
    entry.replyToSequenceId === null ? undefined : bySequence.get(entry.replyToSequenceId);
  return target?.actorKind === "agent_self";
}

function replyChainDepth(
  trigger: ExchangeEntry,
  bySequence: ReadonlyMap<string, ExchangeEntry>,
): number {
  let depth = 0;
  const seen = new Set<string>();
  let current: ExchangeEntry | undefined = trigger;
  while (current && current.replyToSequenceId !== null && !seen.has(current.sequenceId)) {
    seen.add(current.sequenceId);
    current = bySequence.get(current.replyToSequenceId);
    if (current?.actorKind === "agent_self") depth += 1;
  }
  return depth;
}

function sameAuthorRun(
  trigger: ExchangeEntry,
  before: readonly ExchangeEntry[],
  bySequence: ReadonlyMap<string, ExchangeEntry>,
): number {
  let run = 0;
  for (let index = before.length - 1; index >= 0; index -= 1) {
    const entry = before[index]!;
    if (entry.actorKind !== "agent_self") continue;
    const target =
      entry.replyToSequenceId === null ? undefined : bySequence.get(entry.replyToSequenceId);
    if (!target || target.actorKind === "agent_self" || target.actorId !== trigger.actorId) break;
    run += 1;
  }
  return run;
}

export function measureTurnExchange(input: {
  entries: readonly ExchangeEntry[];
  /** Telegram ids of the messages Mia just sent for this turn; they are not part of the exchange. */
  ownMessageIds: readonly string[];
  triggeringEntryId: string;
}): ExchangeMetrics | null {
  const own = new Set(input.ownMessageIds);
  const entries = input.entries.filter(
    (entry) => entry.telegramMessageId === undefined || !own.has(entry.telegramMessageId),
  );
  const triggerIndex = entries.findIndex((entry) => entry.entryId === input.triggeringEntryId);
  if (triggerIndex === -1) return null;
  const trigger = entries[triggerIndex]!;
  if (trigger.actorKind === "agent_self") return null;
  const bySequence = new Map(entries.map((entry) => [entry.sequenceId, entry] as const));
  return {
    replyChainDepth: replyChainDepth(trigger, bySequence),
    sameAuthorRun: sameAuthorRun(trigger, entries.slice(0, triggerIndex), bySequence),
    triggerKind: repliesToMia(trigger, bySequence) ? "reply_to_mia" : "addressed",
  };
}
