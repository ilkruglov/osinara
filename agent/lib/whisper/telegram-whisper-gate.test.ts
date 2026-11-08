/**
 * The webhook-time gate of a whisper: who may whisper and the immediate placeholder.
 *
 * Constructs covered:
 * - A whisper is answered only in a registered group, by the same access rules as a message there:
 *   a family group admits its family, owner-only mode admits only the owner.
 * - Refused or unregistered: nothing is sent, nothing is queued; a policy that changed while the
 *   author was looked up refuses too.
 * - An empty question gets a hint and is not queued.
 * - An accepted whisper gets a placeholder at once, in the command's topic; the marker names it, and
 *   the placeholder is recorded with its update before anything is queued. A placeholder that could
 *   not be recorded is removed and the webhook fails, so Telegram delivers the update again.
 * - A placeholder Telegram refused (the 15-second window passed) queues nothing.
 * - Closing records the placeholder as closed and removes it; a placeholder with no record is still
 *   removed; a refusal never throws.
 */
import type { TelegramMessage } from "eve/channels/telegram";
import { describe, expect, it, vi } from "vitest";

import type { RegisteredGroup } from "../family-access.js";
import {
  createTelegramWhisperGate,
  WHISPER_PLACEHOLDER_TEXT,
  WHISPER_USAGE_HINT,
} from "./telegram-whisper-gate.js";
import { memoryPlaceholders } from "./whisper-placeholder.test-fixtures.js";

const FAMILY_GROUP: RegisteredGroup = {
  familyId: "family-1",
  groupId: "group-1",
  messageMode: "addressed_only",
  telegramChatId: "-1001",
  toolAllowlist: [],
  type: "family_private",
} as RegisteredGroup;

function whisper(text = "/whisper о чём спор?", topic = false): TelegramMessage {
  return {
    attachments: [],
    caption: "",
    chat: { id: "-1001", title: "Группа", type: "supergroup" },
    from: { firstName: "Анна", id: "101", isBot: false, username: "anna" },
    messageId: "0",
    ...(topic ? { messageThreadId: 12 } : {}),
    raw: {
      ephemeral_message_id: 7,
      ...(topic ? { is_topic_message: true, message_thread_id: 12 } : {}),
      message_id: 0,
      text,
    },
    text,
  };
}

function gate(
  overrides: { group?: RegisteredGroup | null; identity?: unknown; send?: unknown } = {},
) {
  const telegram = {
    findGroup: vi
      .fn()
      .mockResolvedValue(overrides.group === undefined ? FAMILY_GROUP : overrides.group),
    findIdentity: vi
      .fn()
      .mockResolvedValue(
        overrides.identity === undefined
          ? { familyId: "family-1", role: "member", userId: "user-1" }
          : overrides.identity,
      ),
  };
  const api = {
    delete: vi.fn().mockResolvedValue({ ok: true }),
    edit: vi.fn().mockResolvedValue({ ok: true }),
    reply: vi.fn().mockResolvedValue(overrides.send ?? { ok: true, placeholderMessageId: 31 }),
  };
  const store = memoryPlaceholders();
  return {
    api,
    gate: createTelegramWhisperGate({
      api,
      botUsername: "osinara_bot",
      placeholders: store.repository,
      telegram,
    }),
    store,
    telegram,
  };
}

describe("createTelegramWhisperGate", () => {
  it("answers a family member at once with a placeholder in the command's topic", async () => {
    const { api, gate: whisperGate, store } = gate();

    await expect(whisperGate.open(whisper("/whisper о чём спор?", true), "5001")).resolves.toEqual({
      ephemeralMessageId: 7,
      placeholderMessageId: 31,
      receiverUserId: "101",
    });
    expect(api.reply).toHaveBeenCalledExactlyOnceWith({
      chatId: "-1001",
      ephemeralMessageId: 7,
      messageThreadId: 12,
      receiverUserId: "101",
      text: WHISPER_PLACEHOLDER_TEXT,
    });
    expect(store.repository.record).toHaveBeenCalledExactlyOnceWith({
      chatId: "-1001",
      placeholderMessageId: 31,
      receiverUserId: "101",
      updateId: "5001",
    });
    expect(store.row()?.status).toBe("open");
  });

  it("removes a placeholder it could not record and fails the webhook", async () => {
    const { api, gate: whisperGate, store } = gate();
    vi.mocked(store.repository.record).mockRejectedValueOnce(new Error("connection terminated"));

    await expect(whisperGate.open(whisper(), "5001")).rejects.toThrow("connection terminated");
    expect(api.delete).toHaveBeenCalledExactlyOnceWith({
      chatId: "-1001",
      placeholderMessageId: 31,
      receiverUserId: "101",
    });
  });

  it.each([
    ["an unregistered group", { group: null }],
    ["a stranger in a family group", { identity: null }],
    ["another family", { identity: { familyId: "family-2", role: "member", userId: "user-9" } }],
    [
      "a member in owner-only mode",
      { group: { ...FAMILY_GROUP, messageMode: "owner_only" } as RegisteredGroup },
    ],
  ])("stays silent for %s", async (_name, overrides) => {
    const { api, gate: whisperGate } = gate(overrides);

    await expect(whisperGate.open(whisper(), "5001")).resolves.toBeNull();
    expect(api.reply).not.toHaveBeenCalled();
  });

  it("stays silent when the group switched to owner-only while the author was looked up", async () => {
    const {
      api,
      gate: whisperGate,
      telegram,
    } = gate({
      group: { ...FAMILY_GROUP, messageMode: "all", type: "external" } as RegisteredGroup,
      identity: null,
    });
    telegram.findGroup
      .mockResolvedValueOnce({ ...FAMILY_GROUP, messageMode: "all", type: "external" })
      .mockResolvedValueOnce({ ...FAMILY_GROUP, messageMode: "owner_only", type: "external" });

    await expect(whisperGate.open(whisper(), "5001")).resolves.toBeNull();
    expect(api.reply).not.toHaveBeenCalled();
  });

  it("admits anyone in an external group open to everyone", async () => {
    const { api, gate: whisperGate } = gate({
      group: { ...FAMILY_GROUP, messageMode: "all", type: "external" } as RegisteredGroup,
      identity: null,
    });

    await expect(whisperGate.open(whisper(), "5001")).resolves.toEqual(
      expect.objectContaining({ placeholderMessageId: 31 }),
    );
    expect(api.reply).toHaveBeenCalledOnce();
  });

  it("answers an empty question with a hint and queues nothing", async () => {
    const { api, gate: whisperGate } = gate();

    await expect(whisperGate.open(whisper("/whisper"), "5001")).resolves.toBeNull();
    expect(api.reply).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ text: WHISPER_USAGE_HINT }),
    );
  });

  it("ignores a message that is not a whisper to this bot", async () => {
    const { api, gate: whisperGate, telegram } = gate();

    await expect(
      whisperGate.open(whisper("/whisper@other_bot привет"), "5001"),
    ).resolves.toBeNull();
    expect(telegram.findGroup).not.toHaveBeenCalled();
    expect(api.reply).not.toHaveBeenCalled();
  });

  it("queues nothing when Telegram refused the placeholder", async () => {
    const { gate: whisperGate } = gate({
      send: {
        body: { description: "Bad Request: message to be replied not found" },
        ok: false,
        status: 400,
      },
    });

    await expect(whisperGate.open(whisper(), "5001")).resolves.toBeNull();
  });

  it("records the placeholder as closed, removes it and swallows a refusal", async () => {
    const { api, gate: whisperGate, store } = gate();
    store.seed("open");
    api.delete.mockResolvedValueOnce({ body: {}, ok: false, status: 400 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(
      whisperGate.close("-1001", {
        ephemeralMessageId: 7,
        placeholderMessageId: 31,
        receiverUserId: "101",
      }),
    ).resolves.toBeUndefined();
    expect(api.delete).toHaveBeenCalledExactlyOnceWith({
      chatId: "-1001",
      placeholderMessageId: 31,
      receiverUserId: "101",
    });
    expect(store.row()).toMatchObject({ pendingContent: null, status: "closed" });
    warn.mockRestore();
  });

  it("removes a placeholder that has no record", async () => {
    const { api, gate: whisperGate } = gate();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await whisperGate.close("-1001", {
      ephemeralMessageId: 7,
      placeholderMessageId: 31,
      receiverUserId: "101",
    });

    expect(api.delete).toHaveBeenCalledExactlyOnceWith({
      chatId: "-1001",
      placeholderMessageId: 31,
      receiverUserId: "101",
    });
    warn.mockRestore();
  });
});
