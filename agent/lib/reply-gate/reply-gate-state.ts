/**
 * The state the reply gate shows Jev, and the exchange metrics computed from the journal.
 *
 * Exports:
 * - `buildReplyGateState`: the excerpt (recent entries, the triggering message, the candidate) as
 *   a structured state, plus how the turn was triggered, how deep the reply chain to Mia is and how
 *   many of Mia's latest replies went to the same person.
 *
 * Key constructs:
 * - Entries arrive in timeline order and may include Mia's just-sent messages (the journal is
 *   written before the gate runs): their Telegram ids are excluded so the candidate is judged once.
 * - Irrelevant state lowers Jev's accuracy (vendor note), so the excerpt is short: the last entries
 *   only, each clipped, people named by display name or username, Mia marked as the bot.
 * - The metrics are code, not the model: Jev does not count reliably, and the owner wants the
 *   facts of the exchange measurable before any policy uses them.
 */
import type { TelegramTimelineActorKind } from "../telegram-inbound-actor.js";

export interface ReplyGateEntry {
  actorId: string;
  actorKind: TelegramTimelineActorKind;
  contentText: string | null;
  entryId?: string;
  messageKind: string;
  replyToSequenceId: string | null;
  senderDisplayName: string | null;
  senderUsername: string | null;
  sequenceId: string;
  telegramMessageId?: string;
}

export type ReplyGateTriggerKind = "addressed" | "reply_to_mia";

export interface ReplyGateMetrics {
  /** How many of Mia's messages the reply chain of the triggering message passes through. */
  replyChainDepth: number;
  /** How many of Mia's latest replies before this turn answered the triggering person, consecutively. */
  sameAuthorRun: number;
  triggerKind: ReplyGateTriggerKind;
}

export interface ReplyGateExcerptMessage {
  from: string;
  reply_to_mia: boolean;
  text: string;
}

export interface ReplyGateState {
  candidate: { from: "Мия (бот)"; text: string };
  chat: string;
  current: ReplyGateExcerptMessage;
  recent: ReplyGateExcerptMessage[];
}

export const REPLY_GATE_RECENT_LIMIT = 12;
const RECENT_TEXT_LIMIT = 300;
const CANDIDATE_TEXT_LIMIT = 1_500;
const MIA = "Мия (бот)";

function clip(text: string, limit: number): string {
  const trimmed = text.replace(/\s+/gu, " ").trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit - 1)}…`;
}

function personName(entry: ReplyGateEntry): string {
  if (entry.actorKind === "agent_self") return MIA;
  const name = entry.senderDisplayName?.trim() || entry.senderUsername?.trim() || "участник";
  return entry.actorKind === "telegram_bot" ? `${name} (бот)` : name;
}

function entryText(entry: ReplyGateEntry, limit: number): string {
  return clip(entry.contentText?.trim() || `[${entry.messageKind}]`, limit);
}

function repliesToMia(entry: ReplyGateEntry, bySequence: ReadonlyMap<string, ReplyGateEntry>): boolean {
  const target = entry.replyToSequenceId === null ? undefined : bySequence.get(entry.replyToSequenceId);
  return target?.actorKind === "agent_self";
}

function replyChainDepth(trigger: ReplyGateEntry, bySequence: ReadonlyMap<string, ReplyGateEntry>): number {
  let depth = 0;
  const seen = new Set<string>();
  let current: ReplyGateEntry | undefined = trigger;
  while (current && current.replyToSequenceId !== null && !seen.has(current.sequenceId)) {
    seen.add(current.sequenceId);
    current = bySequence.get(current.replyToSequenceId);
    if (current?.actorKind === "agent_self") depth += 1;
  }
  return depth;
}

function sameAuthorRun(trigger: ReplyGateEntry, before: readonly ReplyGateEntry[], bySequence: ReadonlyMap<string, ReplyGateEntry>): number {
  let run = 0;
  for (let index = before.length - 1; index >= 0; index -= 1) {
    const entry = before[index]!;
    if (entry.actorKind !== "agent_self") continue;
    const target = entry.replyToSequenceId === null ? undefined : bySequence.get(entry.replyToSequenceId);
    if (!target || target.actorKind === "agent_self" || target.actorId !== trigger.actorId) break;
    run += 1;
  }
  return run;
}

export function buildReplyGateState(input: {
  candidate: string;
  entries: readonly ReplyGateEntry[];
  /** Telegram ids of the messages Mia just sent for this turn; they are not part of the excerpt. */
  ownMessageIds: readonly string[];
  triggeringEntryId: string;
}): { metrics: ReplyGateMetrics; state: ReplyGateState } | null {
  const own = new Set(input.ownMessageIds);
  const entries = input.entries.filter((entry) => entry.telegramMessageId === undefined || !own.has(entry.telegramMessageId));
  const triggerIndex = entries.findIndex((entry) => entry.entryId === input.triggeringEntryId);
  if (triggerIndex === -1) return null;
  const trigger = entries[triggerIndex]!;
  if (trigger.actorKind === "agent_self") return null;
  const bySequence = new Map(entries.map((entry) => [entry.sequenceId, entry] as const));
  const before = entries.slice(0, triggerIndex);
  const recent = before.slice(-REPLY_GATE_RECENT_LIMIT).map((entry) => ({
    from: personName(entry),
    reply_to_mia: repliesToMia(entry, bySequence),
    text: entryText(entry, RECENT_TEXT_LIMIT),
  }));
  const triggerRepliesToMia = repliesToMia(trigger, bySequence);
  return {
    metrics: {
      replyChainDepth: replyChainDepth(trigger, bySequence),
      sameAuthorRun: sameAuthorRun(trigger, before, bySequence),
      triggerKind: triggerRepliesToMia ? "reply_to_mia" : "addressed",
    },
    state: {
      candidate: { from: MIA, text: clip(input.candidate, CANDIDATE_TEXT_LIMIT) },
      chat: "Групповой чат друзей в Telegram; Мия это бот-участник чата, отвечает, когда к ней обращаются",
      current: { from: personName(trigger), reply_to_mia: triggerRepliesToMia, text: entryText(trigger, RECENT_TEXT_LIMIT) },
      recent,
    },
  };
}
