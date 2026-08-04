/**
 * Durable model input for one Telegram group turn.
 *
 * Exports:
 * - `TelegramGroupTurnContextPreparer`: injectable bootstrap/incremental context contract.
 * - `createTelegramGroupTurnContextPreparer`: composes timeline and session cursor repositories.
 * - `telegramGroupTurnContextPreparer`: production context preparer.
 * - `currentTelegramMessageText`: reads the addressed message back out of the durable envelope.
 */
import {
  TELEGRAM_GROUP_JOURNAL_CONTEXT_CHARACTERS,
  TELEGRAM_GROUP_JOURNAL_CONTEXT_MESSAGES,
} from "../config.js";
import { AppError } from "./app-error.js";
import { escapeUntrustedContextJson } from "./untrusted-context-json.js";
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
  replyTargetUnavailable: boolean;
  replyToSequenceId: string | null;
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

const CURRENT_MESSAGE_OPEN_TAG = "<current_telegram_message>";
const CURRENT_MESSAGE_CLOSE_TAG = "</current_telegram_message>";
const TURN_MESSAGE_ERROR_CODE = "AGENT_TELEGRAM_TURN_MESSAGE_INVALID";

function turnMessageError(reason: string, detail?: string): AppError {
  // The exact failure stays in logs; the caller only needs the stable contract error.
  console.error(JSON.stringify({
    code: TURN_MESSAGE_ERROR_CODE,
    reason,
    ...(detail === undefined ? {} : { detail }),
  }));
  return new AppError(
    TURN_MESSAGE_ERROR_CODE,
    "Не удалось прочитать текущее сообщение группы. Отправьте сообщение ещё раз",
  );
}

function durableTurnMessage(
  timeline: string | null,
  input: Pick<
    PrepareTelegramGroupTurnContextInput,
    | "currentSenderDisplayName"
    | "currentSenderUsername"
    | "messageText"
    | "replyTargetUnavailable"
    | "replyToSequenceId"
  >,
): string {
  if (input.replyTargetUnavailable && input.replyToSequenceId !== null) {
    throw turnMessageError("reply_metadata_conflict");
  }
  // The durable envelope retains speaker attribution without exposing Telegram identifiers.
  const timelinePrefix = timeline === null ? "" : `${timeline}\n\n`;
  const currentMessage = escapeUntrustedContextJson({
    senderDisplayName: input.currentSenderDisplayName,
    senderUsername: input.currentSenderUsername,
    ...(input.replyTargetUnavailable ? { replyTargetUnavailable: true } : {}),
    ...(input.replyToSequenceId === null ? {} : { replyToSequenceId: input.replyToSequenceId }),
    text: input.messageText,
  });
  return `${timelinePrefix}${CURRENT_MESSAGE_OPEN_TAG}\n${currentMessage}\n${CURRENT_MESSAGE_CLOSE_TAG}`;
}

/**
 * Reads the addressed message text back out of an envelope this module produced. Participant text
 * inside the envelope has its markup escaped, so the delimiters are unambiguous and a malformed
 * payload means the durable turn input is corrupt rather than merely unusual.
 */
export function currentTelegramMessageText(durableMessage: string): string {
  const opening = durableMessage.lastIndexOf(CURRENT_MESSAGE_OPEN_TAG);
  const closing = durableMessage.lastIndexOf(CURRENT_MESSAGE_CLOSE_TAG);
  if (opening < 0 || closing <= opening) throw turnMessageError("envelope_missing");

  const payload = durableMessage.slice(opening + CURRENT_MESSAGE_OPEN_TAG.length, closing).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch (error) {
    throw turnMessageError(
      "envelope_unparsable",
      error instanceof Error ? error.message : String(error),
    );
  }

  const text = (parsed as { text?: unknown } | null)?.text;
  if (typeof text !== "string") throw turnMessageError("text_missing");
  return text;
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
          anchorEntryId: input.currentEntryId,
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
      input.replyToSequenceId,
    );
    // A DB-resolved reply is usable only when its protected target survived model-context bounds.
    const replyTargetIncluded = input.replyToSequenceId === null ||
      timeline?.includes(`\n#${input.replyToSequenceId} [`) === true;
    const replyToSequenceId = replyTargetIncluded ? input.replyToSequenceId : null;
    const replyTargetUnavailable = input.replyTargetUnavailable || !replyTargetIncluded;
    return {
      cursorSequence: input.currentSequence,
      durableMessage: durableTurnMessage(timeline, {
        ...input,
        replyTargetUnavailable,
        replyToSequenceId,
      }),
    };
  };
}

export const telegramGroupTurnContextPreparer = createTelegramGroupTurnContextPreparer({
  journal: telegramGroupJournalRepository,
  sessions: groupTimelineCursorRepository,
});
