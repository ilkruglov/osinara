/**
 * Local Eve Telegram ingress patch HITL callback contract tests.
 *
 * Constructs covered:
 * - Rotated application continuation tokens are used for callback delivery.
 * - Telegram forum topic identity survives callback update parsing.
 * - Application-rejected callbacks never resume the Eve session.
 */
import { parseTelegramUpdate, telegramChannel } from "eve/channels/telegram";
import { describe, expect, it, vi } from "vitest";

interface HttpRoute {
  handler(request: Request, context: Record<string, unknown>): Promise<Response>;
}

describe("Eve Telegram verified ingress patch HITL callbacks", () => {
  it("resolves a rotated continuation token for HITL callbacks before delivery", async () => {
    const send = vi.fn().mockResolvedValue({ id: "session-callback" });
    const auth = {
      attributes: { applicationSessionId: "app-session-1", role: "owner" },
      authenticator: "telegram",
      principalId: "user-1",
      principalType: "user" as const,
    };
    const onHitlCallbackQuery = vi.fn().mockResolvedValue({
      auth,
      continuationToken: "-100:55:77:osinara:3",
    });
    const channel = telegramChannel({
      api: {
        fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, result: true }), {
          headers: { "content-type": "application/json" },
        })),
      },
      credentials: { botToken: "test-token", webhookSecretToken: "webhook-secret" },
      onHitlCallbackQuery,
    });
    const route = channel.routes[0] as unknown as HttpRoute;
    let backgroundTask: Promise<unknown> | undefined;

    await route.handler(new Request("https://agent.example/eve/v1/telegram", {
      body: JSON.stringify({
        callback_query: {
          data: "eve:0",
          from: { first_name: "Анна", id: 101, is_bot: false },
          id: "callback-1",
          message: {
            chat: { id: -100, type: "supergroup" },
            date: 1_700_000_000,
            message_id: 77,
            message_thread_id: 55,
            text: "Подтвердите действие",
          },
        },
        update_id: 1003,
      }),
      headers: { "x-telegram-bot-api-secret-token": "webhook-secret" },
      method: "POST",
    }), {
      params: {},
      requestIp: null,
      send,
      waitUntil(task: Promise<unknown>) {
        backgroundTask = task;
      },
    });
    await backgroundTask;

    expect(onHitlCallbackQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: "callback-1" }),
      "-100::77",
    );
    expect(send.mock.calls[0]?.[1]).toMatchObject({
      auth,
      continuationToken: "-100:55:77:osinara:3",
    });
  });

  it("preserves an explicit forum topic ID on callback messages", () => {
    const update = parseTelegramUpdate({
      callback_query: {
        data: "eve:0",
        from: { first_name: "Анна", id: 101, is_bot: false },
        id: "callback-forum",
        message: {
          chat: { id: -100, type: "supergroup" },
          is_topic_message: true,
          message_id: 77,
          message_thread_id: 55,
        },
      },
      update_id: 1007,
    });

    expect(update).toMatchObject({
      callbackQuery: { message: { messageThreadId: 55 } },
      kind: "callback_query",
    });
  });

  it("does not resume Eve when the application rejects a HITL callback", async () => {
    const send = vi.fn();
    const onHitlCallbackQuery = vi.fn().mockResolvedValue(null);
    const channel = telegramChannel({
      api: {
        fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, result: true }), {
          headers: { "content-type": "application/json" },
        })),
      },
      credentials: { botToken: "test-token", webhookSecretToken: "webhook-secret" },
      onHitlCallbackQuery,
    });
    const route = channel.routes[0] as unknown as HttpRoute;
    let backgroundTask: Promise<unknown> | undefined;

    await route.handler(new Request("https://agent.example/eve/v1/telegram", {
      body: JSON.stringify({
        callback_query: {
          data: "eve:0",
          from: { first_name: "Анна", id: 202, is_bot: false },
          id: "callback-foreign",
          message: {
            chat: { id: -100, type: "supergroup" },
            date: 1_700_000_000,
            message_id: 77,
            text: "Подтвердите действие",
          },
        },
        update_id: 1004,
      }),
      headers: { "x-telegram-bot-api-secret-token": "webhook-secret" },
      method: "POST",
    }), {
      params: {},
      requestIp: null,
      send,
      waitUntil(task: Promise<unknown>) {
        backgroundTask = task;
      },
    });
    await backgroundTask;

    expect(onHitlCallbackQuery).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });
});
