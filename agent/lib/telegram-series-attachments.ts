/**
 * Files of the earlier messages a turn answers together with its own.
 *
 * Exports:
 * - `unseenFileMessageIds`: Telegram ids of a private chat's photo and file messages the session
 *   has not seen, with the earlier members of the current series.
 * - `unseenAttachmentReferences`: the author's photo and file references a group turn has not seen.
 *
 * Key construct:
 * - An album and the text after it are one series and one turn (25 November 2026); the earlier
 *   messages start no turn, so their files reach the model only through the last message's turn.
 *   They come from what the session has not seen yet (the delta after its cursor, before the
 *   timeline is cut to its budget), not from the series held in memory: a series cut by a failed
 *   member or a restart leaves its tail to a later turn, which must still see the files before it,
 *   and a photo an earlier turn saw (answered with a reaction or nothing) does not come back. A new
 *   session has no delta; there the series' own members stand in (review, 26 November 2026).
 */
import type {
  TelegramAttachmentReference,
  TelegramGroupJournalEntry,
} from "./telegram-group-journal-context.js";

const FILE_MESSAGE_KINDS = new Set(["document", "photo"]);

export function unseenFileMessageIds(
  unseen: readonly TelegramGroupJournalEntry[],
  seriesMessageIds: readonly string[],
): string[] {
  const ids = new Set(seriesMessageIds);
  for (const entry of unseen) {
    if (
      entry.actorKind === "user" &&
      FILE_MESSAGE_KINDS.has(entry.messageKind) &&
      entry.telegramMessageId !== undefined
    ) {
      ids.add(entry.telegramMessageId);
    }
  }
  return [...ids].sort((left, right) => (BigInt(left) < BigInt(right) ? -1 : 1));
}

export function unseenAttachmentReferences(
  unseen: readonly TelegramGroupJournalEntry[],
  authorTelegramUserId: string,
): TelegramAttachmentReference[] {
  // References come already filtered by the rights of the current turn.
  return unseen.flatMap((entry) =>
    entry.attachment !== undefined &&
    entry.telegramMessageId !== undefined &&
    entry.telegramUserId === authorTelegramUserId
      ? [{ ...entry.attachment, telegramMessageId: entry.telegramMessageId }]
      : [],
  );
}
