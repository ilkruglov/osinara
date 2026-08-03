/**
 * Durable model input for one Telegram group turn.
 *
 * Exports:
 * - `TelegramGroupTurnContextPreparer`: injectable bootstrap/incremental context contract.
 * - `createTelegramGroupTurnContextPreparer`: composes timeline and session cursor repositories.
 * - `telegramGroupTurnContextPreparer`: production context preparer.
 */
import {
  TELEGRAM_GROUP_JOURNAL_CONTEXT_CHARACTERS,
  TELEGRAM_GROUP_JOURNAL_CONTEXT_MESSAGES,
} from "../config.js";
import { groupTimelineCursorRepository } from "./sessions/group-timeline-cursor-repository.js";
import { formatTelegramGroupJournalContext } from "./telegram-group-journal-context.js";
import {
  telegramGroupJournalRepository,
  type TelegramGroupJournalRepository,
} from "./telegram-group-journal-repository.js";

interface PrepareTelegramGroupTurnContextInput {
  applicationSessionId: string;
  currentEntryId: string;
  currentSenderDisplayName: string;
  currentSenderUsername: string | null;
  currentSequence: string;
  groupId: string;
  includeAttachmentReferences: boolean;
  messageText: string;
  messageThreadId: string | null;
}

interface TelegramGroupTurnContextDependencies {
  journal: Pick<TelegramGroupJournalRepository, "listIncremental" | "listRecent">;
  sessions: Pick<typeof groupTimelineCursorRepository, "currentGroupTimelineCursor">;
}

export interface PreparedTelegramGroupTurnContext {
  cursorSequence: string;
  durableMessage: string;
}

export type TelegramGroupTurnContextPreparer = (
  input: PrepareTelegramGroupTurnContextInput,
) => Promise<PreparedTelegramGroupTurnContext>;

function durableTurnMessage(
  timeline: string | null,
  input: Pick<
    PrepareTelegramGroupTurnContextInput,
    "currentSenderDisplayName" | "currentSenderUsername" | "messageText"
  >,
): string {
  // The durable envelope retains speaker attribution without exposing Telegram identifiers.
  const timelinePrefix = timeline === null ? "" : `${timeline}\n\n`;
  const currentMessage = JSON.stringify({
    senderDisplayName: input.currentSenderDisplayName,
    senderUsername: input.currentSenderUsername,
    text: input.messageText,
  }).replaceAll("&", "\\u0026").replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
  return `${timelinePrefix}<current_telegram_message>\n${currentMessage}\n</current_telegram_message>`;
}

export function createTelegramGroupTurnContextPreparer(
  dependencies: TelegramGroupTurnContextDependencies,
): TelegramGroupTurnContextPreparer {
  return async (input) => {
    const cursor = await dependencies.sessions.currentGroupTimelineCursor(
      input.applicationSessionId,
    );
    const page = cursor === null
      ? {
          entries: await dependencies.journal.listRecent({
            anchorEntryId: input.currentEntryId,
            beforeSequence: input.currentSequence,
            groupId: input.groupId,
            limit: TELEGRAM_GROUP_JOURNAL_CONTEXT_MESSAGES,
            messageThreadId: input.messageThreadId,
          }),
          omittedBeforeSequence: null,
        }
      : await dependencies.journal.listIncremental({
          afterSequence: cursor,
          applicationSessionId: input.applicationSessionId,
          beforeSequence: input.currentSequence,
          groupId: input.groupId,
          limit: TELEGRAM_GROUP_JOURNAL_CONTEXT_MESSAGES,
          messageThreadId: input.messageThreadId,
        });
    // External capability revocation hides even historical opaque references from new model turns.
    const visibleEntries = input.includeAttachmentReferences
      ? page.entries
      : page.entries.map(({ attachment: _attachment, ...entry }) => entry);
    const timeline = formatTelegramGroupJournalContext(
      visibleEntries,
      TELEGRAM_GROUP_JOURNAL_CONTEXT_CHARACTERS,
      page.omittedBeforeSequence,
    );
    return {
      cursorSequence: input.currentSequence,
      durableMessage: durableTurnMessage(timeline, input),
    };
  };
}

export const telegramGroupTurnContextPreparer = createTelegramGroupTurnContextPreparer({
  journal: telegramGroupJournalRepository,
  sessions: groupTimelineCursorRepository,
});
