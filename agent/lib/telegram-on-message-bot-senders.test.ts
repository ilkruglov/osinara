/**
 * Telegram bot-participant routing boundary tests.
 *
 * Constructs covered:
 * - An external group admits another bot as a group-scoped participant without any account.
 * - A bot reaches the model under exactly the trigger rules that apply to a human participant.
 * - The trusted family zone drops a bot before the shared timeline is written.
 * - Owner-only mode never accepts a bot, because it is reserved for the verified human owner.
 * - A bot reply to Osinara stays an ordinary message and never enters HITL approval.
 * - A private message from a bot is dropped silently, without an enrollment hint to answer.
 */
import { describe, expect, it } from "vitest";

import {
  BOT_USERNAME,
  botGroupMessage,
  repositories,
  telegramContext,
} from "./telegram-on-message.test-fixtures.js";
import { createTelegramMessageHandler } from "./telegram-on-message.js";

const externalGroup = {
  familyId: "family-1",
  groupId: "group-2",
  messageMode: "all" as const,
  skillAllowlist: [],
  telegramChatId: "group-101",
  toolAllowlist: [],
  type: "external" as const,
};

describe("createTelegramMessageHandler bot senders", () => {
  it("dispatches an addressed bot message as a group-scoped participant", async () => {
    const repository = repositories();
    repository.telegram.findGroup.mockResolvedValue(externalGroup);
    const handler = createTelegramMessageHandler(repository);
    const { context } = telegramContext();

    const result = await handler(context, botGroupMessage(`@${BOT_USERNAME} привет`));

    expect(result?.auth).toMatchObject({
      attributes: {
        groupId: "group-2",
        groupType: "external",
        memoryScopes: ["group"],
        role: "external",
        telegramActorId: "8123456789",
        telegramActorKind: "telegram_bot",
      },
      principalId: "telegram-bot:8123456789",
      principalType: "service",
    });
    expect(result?.auth?.attributes?.telegramUserId).toBeUndefined();
    expect(repository.telegram.findIdentity).not.toHaveBeenCalled();
  });

  it("journals an unaddressed bot message without waking the model", async () => {
    const repository = repositories();
    repository.telegram.findGroup.mockResolvedValue(externalGroup);
    const handler = createTelegramMessageHandler(repository);
    const { context } = telegramContext();

    const result = await handler(context, botGroupMessage("просто болтаю в чате"));

    expect(result).toBeNull();
    expect(repository.journal.record).toHaveBeenCalledWith(
      "group-2",
      expect.anything(),
      expect.objectContaining({ actorId: "telegram-bot:8123456789", kind: "telegram_bot" }),
    );
    // Only human messages become memory evidence; a bot never proposes facts about the family.
    expect(repository.memoryReview.observePassiveMessage).not.toHaveBeenCalled();
  });

  it("treats a bot reply to Osinara as a message, never as HITL approval", async () => {
    const repository = repositories();
    repository.telegram.findGroup.mockResolvedValue(externalGroup);
    repository.journal.record.mockResolvedValue({
      entryId: "00000000-0000-4000-8000-000000000010",
      replyToAgent: true,
      replyTargetUnavailable: false,
      replyToSequenceId: "99",
      sequenceId: "100",
      status: "inserted",
    });
    const message = {
      ...botGroupMessage("и тебе привет"),
      replyToMessage: {
        chat: { id: "group-101", type: "group" as const },
        from: { firstName: "Осинара", id: "bot-1", isBot: true, username: BOT_USERNAME },
        messageId: "99",
      },
    };

    const result = await createTelegramMessageHandler(repository)(telegramContext().context, message);

    expect(repository.hitl.authorizeReply).not.toHaveBeenCalled();
    expect(result?.replyHandling).toBe("message");
    expect(result?.auth?.principalType).toBe("service");
  });

  it("drops a bot message in the trusted family zone before journaling it", async () => {
    const repository = repositories();
    repository.telegram.findGroup.mockResolvedValue({
      ...externalGroup,
      groupId: "group-1",
      type: "family_private",
    });
    const handler = createTelegramMessageHandler(repository);
    const { context } = telegramContext();

    const result = await handler(context, botGroupMessage(`@${BOT_USERNAME} привет`));

    expect(result).toBeNull();
    expect(repository.journal.record).not.toHaveBeenCalled();
  });

  it("answers nothing to a bot in a private chat", async () => {
    const repository = repositories();
    const handler = createTelegramMessageHandler(repository);
    const { context, sendMessage } = telegramContext();
    const message = {
      ...botGroupMessage("привет"),
      chat: { id: "8123456789", type: "private" as const },
    };

    const result = await handler(context, message);

    expect(result).toBeNull();
    // An enrollment hint would be answered by the other bot, and answered again on every reply.
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("drops a bot message in an owner-only external group", async () => {
    const repository = repositories();
    repository.telegram.findGroup.mockResolvedValue({
      ...externalGroup,
      messageMode: "owner_only",
    });
    const handler = createTelegramMessageHandler(repository);
    const { context } = telegramContext();

    const result = await handler(context, botGroupMessage(`@${BOT_USERNAME} привет`));

    expect(result).toBeNull();
    expect(repository.journal.record).not.toHaveBeenCalled();
  });
});
