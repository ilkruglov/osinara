/**
 * Shared Telegram authorization-boundary test fixtures.
 *
 * Exports:
 * - `BOT_USERNAME`: stable bot identity used by dispatch tests.
 * - `privateMessage` and `groupMessage`: minimal parsed Eve Telegram messages.
 * - `telegramContext`: Telegram channel context with an observable sender.
 * - `repositories`: isolated application repository doubles for message-handler tests.
 */
import type { TelegramContext, TelegramMessage } from "eve/channels/telegram";
import { vi } from "vitest";

export const BOT_USERNAME = "osinara_bot";

export function privateMessage(text: string): TelegramMessage {
  return {
    attachments: [],
    caption: "",
    chat: { id: "telegram-101", type: "private" },
    from: { firstName: "Анна", id: "telegram-101", isBot: false, username: "anna" },
    messageId: "1",
    raw: { date: 1_700_000_000 },
    text,
  };
}

export function groupMessage(text: string): TelegramMessage {
  return {
    ...privateMessage(text),
    chat: { id: "group-101", title: "Группа", type: "group" },
  };
}

export function telegramContext() {
  const sendMessage = vi.fn().mockResolvedValue({});
  return {
    context: {
      telegram: {
        botUsername: BOT_USERNAME,
        sendMessage,
      },
    } as unknown as TelegramContext,
    sendMessage,
  };
}

export function repositories() {
  return {
    attachmentReferences: {
      captureReplyTarget: vi.fn().mockResolvedValue(null),
      record: vi.fn().mockResolvedValue({
        attachmentId: "00000000-0000-4000-8000-000000000099",
        fileName: "семейный файл.pdf",
        kind: "document",
        mediaType: "application/pdf",
        size: 1_024,
        telegramMessageId: "1",
      }),
    },
    attachments: {
      persist: vi.fn().mockResolvedValue([]),
    },
    family: {
      claimInvitation: vi.fn(),
    },
    groupContext: {
      prepare: vi.fn().mockResolvedValue({
        cursorSequence: "1",
        durableMessage: "<current_telegram_message>test</current_telegram_message>",
      }),
    },
    hitl: {
      authorizeReply: vi.fn().mockResolvedValue("not_applicable"),
    },
    journal: {
      listBefore: vi.fn().mockResolvedValue([]),
      listRecent: vi.fn().mockResolvedValue([]),
      record: vi.fn().mockResolvedValue({
        entryId: "00000000-0000-4000-8000-000000000010",
        replyToAgent: false,
        replyTargetUnavailable: false,
        replyToSequenceId: null,
        sequenceId: "1",
        status: "inserted",
      }),
    },
    proactiveDeliveries: {
      listPendingContext: vi.fn().mockResolvedValue(null),
    },
    session: {
      hasRoute: vi.fn().mockResolvedValue(false),
      prepareTurn: vi.fn().mockResolvedValue({
        continuationToken: "telegram-101::",
        generation: 0,
        id: "session-1",
        rotated: false,
        sandboxSessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      }),
    },
    telegram: {
      claimFirstOwner: vi.fn(),
      findGroup: vi.fn().mockResolvedValue(null),
      findIdentity: vi.fn().mockResolvedValue(null),
      hasOwner: vi.fn(),
    },
  };
}
