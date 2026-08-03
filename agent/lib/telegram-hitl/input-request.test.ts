/**
 * Telegram HITL input rendering tests.
 *
 * Constructs covered:
 * - `createTelegramInputRequestHandler`: persists approver identity before exposing buttons.
 * - Interactive and scheduled requests receive aliases without changing Eve's continuation hook.
 */
import type { SessionContext } from "eve/context";
import type { TelegramEventContext } from "eve/channels/telegram";
import { describe, expect, it, vi } from "vitest";

import { createTelegramInputRequestHandler } from "./input-request.js";

describe("createTelegramInputRequestHandler", () => {
  it("registers the expected approver and route before exposing callback buttons", async () => {
    const parkSession = vi.fn();
    const register = vi.fn();
    const registerMessageRoutes = vi.fn();
    const request = vi.fn().mockImplementation(async (method: string) => method === "sendMessage"
      ? { body: { ok: true, result: { message_id: 88 } }, ok: true, status: 200 }
      : { body: {}, ok: true, status: 200 });
    const handler = createTelegramInputRequestHandler({
      approvals: { register },
      parkSession,
      present: async (request) => request,
      registerMessageRoutes,
    });
    const channel = {
      continuationToken: "-1001:55:77",
      state: {
        botUsername: "osinara_bot",
        chatId: "-1001",
        chatType: "supergroup",
        conversationId: "77",
        hitlCallbacks: {},
        messageThreadId: 55,
        nextHitlCallbackId: 0,
        pendingFreeformReplies: {},
        triggeringUserId: "101",
      },
      telegram: { request },
    } as unknown as TelegramEventContext;
    const ctx = {
      session: {
        auth: {
          current: {
            attributes: {
              applicationSessionId: "app-session-1",
              telegramChatId: "-1001",
              telegramChatType: "supergroup",
              telegramReplyToMessageId: "77",
              telegramUserId: "101",
            },
            authenticator: "telegram",
            principalId: "user-1",
            principalType: "user",
          },
          initiator: null,
        },
        id: "wrun_hitl",
        turn: { id: "turn-1", sequence: 1 },
      },
    } as unknown as SessionContext;

    await handler({
      requests: [{
        action: {
          callId: "call-1",
          input: { action: "create" },
          kind: "tool-call",
          toolName: "manage_reminder",
        },
        display: "confirmation",
        options: [
          { id: "approve", label: "Yes", style: "primary" },
          { id: "deny", label: "No", style: "default" },
        ],
        prompt: "Approve tool call",
        requestId: "request-1",
      }],
    } as never, channel, ctx);

    expect(parkSession).toHaveBeenCalledWith({
      applicationSessionId: "app-session-1",
      pendingRequestId: "request-1",
      requesterTelegramUserId: "101",
      requesterUserId: null,
    });
    expect(request).toHaveBeenCalledWith("sendMessage", expect.objectContaining({
      chat_id: "-1001",
      message_thread_id: 55,
      reply_parameters: { allow_sending_without_reply: true, message_id: 77 },
      text: "Подготавливаю безопасный запрос подтверждения.",
    }));
    expect(request.mock.calls[0]?.[1]).not.toHaveProperty("reply_markup");
    expect(registerMessageRoutes).toHaveBeenCalledWith(channel, ctx, ["88"]);
    expect(register).toHaveBeenCalledWith(expect.objectContaining({
      applicationSessionId: "app-session-1",
      callbackData: ["eve:0", "eve:1"],
      callbackOptions: [
        { callbackData: "eve:0", label: "Yes", optionId: "approve" },
        { callbackData: "eve:1", label: "No", optionId: "deny" },
      ],
      eveSessionId: "wrun_hitl",
      requestId: "request-1",
      promptText: "Approve tool call",
      telegramChatId: "-1001",
      telegramChatType: "supergroup",
      telegramMessageId: "88",
      telegramMessageThreadId: "55",
      telegramUserId: "101",
    }));
    expect(request).toHaveBeenCalledWith("editMessageText", {
      chat_id: "-1001",
      message_id: 88,
      message_thread_id: 55,
      reply_markup: expect.any(Object),
      text: expect.any(String),
    });
    expect(registerMessageRoutes.mock.invocationCallOrder[0]).toBeLessThan(
      register.mock.invocationCallOrder[0]!,
    );
    expect(register.mock.invocationCallOrder[0]).toBeLessThan(
      request.mock.invocationCallOrder[1]!,
    );
  });

  it("opens ForceReply only on the non-actionable placeholder for a freeform request", async () => {
    const register = vi.fn();
    const request = vi.fn().mockImplementation(async (method: string) => method === "sendMessage"
      ? { body: { ok: true, result: { message_id: 90 } }, ok: true, status: 200 }
      : { body: {}, ok: true, status: 200 });
    const handler = createTelegramInputRequestHandler({
      approvals: { register },
      parkSession: vi.fn(),
      present: async (request) => request,
      registerMessageRoutes: vi.fn(),
    });
    const channel = {
      state: {
        botUsername: "osinara_bot",
        chatId: "-1001",
        chatType: "supergroup",
        conversationId: "77",
        hitlCallbacks: {},
        messageThreadId: 55,
        nextHitlCallbackId: 0,
        pendingFreeformReplies: {},
        triggeringUserId: "101",
      },
      telegram: { request },
    } as unknown as TelegramEventContext;
    const ctx = {
      session: {
        auth: {
          current: {
            attributes: { applicationSessionId: "app-session-1", telegramUserId: "101" },
            authenticator: "telegram",
            principalId: "user-1",
            principalType: "user",
          },
          initiator: null,
        },
        id: "wrun_hitl",
        turn: { id: "turn-1", sequence: 1 },
      },
    } as unknown as SessionContext;

    await handler({
      requests: [{
        action: { callId: "call-1", input: {}, kind: "tool-call", toolName: "ask_question" },
        allowFreeform: true,
        display: "text",
        options: [],
        prompt: "Уточните значение",
        requestId: "request-freeform",
      }],
    } as never, channel, ctx);

    expect(request).toHaveBeenCalledWith("sendMessage", {
      chat_id: "-1001",
      message_thread_id: 55,
      reply_markup: expect.objectContaining({ force_reply: true }),
      text: "Подготавливаю безопасный запрос подтверждения.",
    });
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ callbackData: [] }));
    expect(request).toHaveBeenCalledWith(
      "editMessageText",
      expect.objectContaining({ text: "Уточните значение" }),
    );
  });

  it("registers the exact callback route for a scheduled request", async () => {
    const registerMessageRoutes = vi.fn();
    const request = vi.fn().mockImplementation(async (method: string) => method === "sendMessage"
      ? { body: { ok: true, result: { message_id: 91 } }, ok: true, status: 200 }
      : { body: {}, ok: true, status: 200 });
    const handler = createTelegramInputRequestHandler({
      approvals: { register: vi.fn() },
      parkSession: vi.fn(),
      present: async (input) => input,
      registerMessageRoutes,
    });
    const channel = {
      state: {
        botUsername: "osinara_bot",
        chatId: "101",
        chatType: "private",
        conversationId: null,
        hitlCallbacks: {},
        messageThreadId: null,
        nextHitlCallbackId: 0,
        pendingFreeformReplies: {},
        triggeringUserId: "101",
      },
      telegram: { request },
    } as unknown as TelegramEventContext;
    const ctx = {
      session: {
        auth: {
          current: {
            attributes: {
              applicationSessionId: "app-session-1",
              scheduledRunId: "run-1",
              telegramUserId: "101",
            },
            authenticator: "telegram",
            principalId: "user-1",
            principalType: "user",
          },
          initiator: null,
        },
        id: "wrun_scheduled_hitl",
        turn: { id: "turn-1", sequence: 1 },
      },
    } as unknown as SessionContext;

    await handler({
      requests: [{
        action: { callId: "call-1", input: {}, kind: "tool-call", toolName: "ask_question" },
        allowFreeform: true,
        display: "text",
        options: [],
        prompt: "Уточните значение",
        requestId: "request-scheduled",
      }],
    } as never, channel, ctx);

    expect(registerMessageRoutes).toHaveBeenCalledWith(channel, ctx, ["91"]);
  });
});
