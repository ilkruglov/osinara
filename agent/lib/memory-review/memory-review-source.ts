/**
 * A journal row as silent memory review reads it.
 *
 * Exports:
 * - `ReviewSourceRow`, `projectReviewSource`: the row and its projection by `journalText` (rows
 *   written before the journal's secret rules carry their secrets still), shared by the review
 *   repository and its dispatcher. A module of its own: tests that replace the review repository
 *   keep it.
 */
import { journalText } from "../secret-redaction.js";
import type { TelegramGroupJournalEntry } from "../telegram-group-journal-context.js";

/** The dispatch repository's rows add the author's Telegram id. */
export interface ReviewSourceRow {
  actor_id: string;
  actor_kind: "agent_self" | "telegram_bot" | "user";
  content_text: string | null;
  id: string;
  message_kind: string;
  message_thread_id: string | null;
  reply_to_sequence_id: string | null;
  sender_display_name: string | null;
  sender_tag: string | null;
  sender_username: string | null;
  sent_at: Date;
  sequence_id: string;
}

export function projectReviewSource(row: ReviewSourceRow): TelegramGroupJournalEntry {
  return {
    actorId: row.actor_id,
    actorKind: row.actor_kind,
    // Rows written before the journal's secret rules carry their secrets still.
    contentText: journalText(row.content_text),
    entryId: row.id,
    messageKind: row.message_kind,
    messageThreadId: row.message_thread_id,
    replyToSequenceId: row.reply_to_sequence_id,
    senderDisplayName: row.sender_display_name,
    senderTag: row.sender_tag,
    senderUsername: row.sender_username,
    sentAt: row.sent_at.toISOString(),
    sequenceId: row.sequence_id,
  };
}
