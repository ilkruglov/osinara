/**
 * Local Eve Telegram ingress patch contract tests.
 *
 * Constructs covered:
 * - `onVerifiedUpdate`: runs only after webhook verification and parsing.
 * - Patched native dispatch: returns the Eve session and accepts application continuation/auth.
 * - `replyHandling: "message"`: suppresses only preliminary Telegram HITL reply synthesis.
 * - Application-authored durable message overrides replace only the model-visible inbound text.
 * - Pure HITL callbacks do not insert channel context between approval and tool execution.
 * - Callback-specific routing contracts live in `eve-telegram-ingress-patch-hitl.test.ts`.
 */
import { readFile } from "node:fs/promises";

import {
  parseTelegramUpdate,
  telegramChannel,
  type TelegramInboundResult,
} from "eve/channels/telegram";
import { describe, expect, it, vi } from "vitest";

import { codeText } from "./vendored-code.js";

import { callAdapterEventHandler } from "../../node_modules/eve/dist/src/channel/adapter.js";

interface HttpRoute {
  handler(request: Request, context: Record<string, unknown>): Promise<Response>;
}

function createChannelSource(session: Record<string, unknown> = { id: "session-test" }) {
  const send = vi.fn().mockResolvedValue(session);
  const respond = vi.fn().mockResolvedValue(session);
  const from = vi.fn(() => ({ respond, send }));
  return { from, respond, send };
}

describe("Eve Telegram verified ingress patch", () => {
  it("pins the reviewed runtime and public type seam exactly once", async () => {
    const runtime = await readFile(
      "vendor/eve/dist/src/public/channels/telegram/telegramChannel.js",
      "utf8",
    );
    const inputRequestsRuntime = await readFile(
      "vendor/eve/dist/src/harness/input-requests.js",
      "utf8",
    );
    const types = await readFile(
      "vendor/eve/dist/src/public/channels/telegram/telegramChannel.d.ts",
      "utf8",
    );
    const valid: TelegramInboundResult = {
      auth: null,
      message: "durable group context\n\ncurrent message",
      replyHandling: "message",
    };
    const callbackResult = {
      acknowledgementText: "Решение сохранено",
      auth: null,
      continuationToken: "101::",
    } satisfies import("eve/channels/telegram").TelegramHitlCallbackResult;
    // @ts-expect-error The pinned seam deliberately permits no other handling modes.
    const invalid: TelegramInboundResult = { auth: null, replyHandling: "hitl" };

    expect(codeText(runtime).match(/r\.replyHandling!==`message`/g)).toHaveLength(1);
    expect(codeText(runtime).match(/i\.acknowledgementText\?\?`Answerreceived\.`/g)).toHaveLength(1);
    expect(codeText(runtime).match(/n\.send\(r\.message\?\?a/g)).toHaveLength(1);
    // Eve natively defers callback context until after the isolated approval step.
    expect(codeText(inputRequestsRuntime)).toContain(codeText("deferMessagesWhileApprovalsPending"));
    expect(codeText(inputRequestsRuntime)).toContain(codeText("queueDeferredStepInput"));
    expect(types.match(/readonly message\?: string;/g)).toHaveLength(1);
    expect(types.match(/readonly replyHandling\?: "message";/g)).toHaveLength(1);
    expect(valid).toMatchObject({ replyHandling: "message" });
    expect(invalid).toBeDefined();
    expect(callbackResult.acknowledgementText).toBe("Решение сохранено");
  });

  it("never exposes an update to the durable hook before webhook authentication", async () => {
    const onVerifiedUpdate = vi.fn();
    const channel = telegramChannel({
      credentials: { webhookSecretToken: "webhook-secret" },
      onVerifiedUpdate,
    });
    const route = channel.routes[0] as unknown as HttpRoute;

    const response = await route.handler(new Request("https://agent.example/eve/v1/telegram", {
      body: JSON.stringify({ update_id: 1000 }),
      headers: { "x-telegram-bot-api-secret-token": "wrong-secret" },
      method: "POST",
    }), {
      from: vi.fn(),
      params: {},
      requestIp: null,
      waitUntil: vi.fn(),
    });

    expect(response.status).toBe(401);
    expect(onVerifiedUpdate).not.toHaveBeenCalled();
  });

  it("sends an application-authored durable message override", async () => {
    const source = createChannelSource({ id: "session-context" });
    const channel = telegramChannel({
      credentials: { webhookSecretToken: "webhook-secret" },
      onMessage: async () => ({ auth: null, message: "durable context\n\nПривет" }),
    });
    const route = channel.routes[0] as unknown as HttpRoute;
    let backgroundTask: Promise<unknown> | undefined;

    await route.handler(new Request("https://agent.example/eve/v1/telegram", {
      body: JSON.stringify({
        message: {
          chat: { id: 101, type: "private" },
          date: 1_700_000_000,
          from: { first_name: "Анна", id: 101, is_bot: false },
          message_id: 78,
          text: "Привет",
        },
        update_id: 1007,
      }),
      headers: { "x-telegram-bot-api-secret-token": "webhook-secret" },
      method: "POST",
    }), {
      params: {},
      requestIp: null,
      from: source.from,
      waitUntil(task: Promise<unknown>) {
        backgroundTask = task;
      },
    });
    await backgroundTask;

    expect(source.send.mock.calls[0]?.[0]).toBe("durable context\n\nПривет");
  });

  it("propagates input.requested handler failures instead of parking an unbound approval", async () => {
    const error = new Error("AGENT_APPROVAL_STORAGE_FAILED");
    const adapter = {
      kind: "telegram",
      "input.requested": vi.fn().mockRejectedValue(error),
    };

    await expect(callAdapterEventHandler(
      adapter as never,
      { data: { requests: [] }, type: "input.requested" } as never,
      {} as never,
    )).rejects.toBe(error);
  });

  it("acknowledges through the hook and dispatches with the native channel adapter", async () => {
    const source = createChannelSource({
      continuationToken: "101::",
      getEventStream: vi.fn(),
      id: "session-1",
    });
    let backgroundTask: Promise<unknown> | undefined;
    let dispatchedSession: unknown;
    const onVerifiedUpdate = vi.fn((context) => {
      context.waitUntil(context.dispatch(context.update).then((session: unknown) => {
        dispatchedSession = session;
      }));
      return new Response("queued", { status: 202 });
    });
    const channel = telegramChannel({
      botUsername: "osinara_bot",
      credentials: { webhookSecretToken: "webhook-secret" },
      onMessage: async () => ({ auth: null }),
      onVerifiedUpdate,
    });
    const route = channel.routes[0] as unknown as HttpRoute;
    const request = new Request("https://agent.example/eve/v1/telegram", {
      body: JSON.stringify({
        message: {
          chat: { id: 101, type: "private" },
          date: 1_700_000_000,
          from: { first_name: "Анна", id: 101, is_bot: false },
          message_id: 77,
          text: "Привет",
        },
        update_id: 1001,
      }),
      headers: { "x-telegram-bot-api-secret-token": "webhook-secret" },
      method: "POST",
    });

    const response = await route.handler(request, {
      params: {},
      requestIp: null,
      from: source.from,
      waitUntil(task: Promise<unknown>) {
        backgroundTask = task;
      },
    });
    await backgroundTask;

    expect(response.status).toBe(202);
    expect(onVerifiedUpdate).toHaveBeenCalledTimes(1);
    expect(source.send).toHaveBeenCalledTimes(1);
    expect(dispatchedSession).toMatchObject({ id: "session-1" });
  });

  it("uses the application continuation token returned by the authorized message handler", async () => {
    const source = createChannelSource({ id: "session-rotated" });
    const channel = telegramChannel({
      credentials: { webhookSecretToken: "webhook-secret" },
      onMessage: async () => ({ auth: null, continuationToken: "101:::osinara:2" }),
    });
    const route = channel.routes[0] as unknown as HttpRoute;
    let backgroundTask: Promise<unknown> | undefined;

    await route.handler(new Request("https://agent.example/eve/v1/telegram", {
      body: JSON.stringify({
        message: {
          chat: { id: 101, type: "private" },
          date: 1_700_000_000,
          from: { first_name: "Анна", id: 101, is_bot: false },
          message_id: 78,
          text: "Продолжим",
        },
        update_id: 1002,
      }),
      headers: { "x-telegram-bot-api-secret-token": "webhook-secret" },
      method: "POST",
    }), {
      params: {},
      requestIp: null,
      from: source.from,
      waitUntil(task: Promise<unknown>) {
        backgroundTask = task;
      },
    });
    await backgroundTask;

    expect(source.from).toHaveBeenCalledWith("101:::osinara:2");
  });

  it("dispatches a timeline reply as a message when the handler opts out of HITL synthesis", async () => {
    const source = createChannelSource({ id: "session-fresh-reply" });
    const channel = telegramChannel({
      credentials: { webhookSecretToken: "webhook-secret" },
      onMessage: async () => ({
        auth: null,
        continuationToken: "-100::340:osinara:2",
        replyHandling: "message" as const,
      }),
    });
    const route = channel.routes[0] as unknown as HttpRoute;
    let backgroundTask: Promise<unknown> | undefined;

    await route.handler(new Request("https://agent.example/eve/v1/telegram", {
      body: JSON.stringify({
        message: {
          chat: { id: -100, type: "supergroup" },
          date: 1_700_000_000,
          from: { first_name: "Анна", id: 101, is_bot: false },
          message_id: 342,
          reply_to_message: {
            chat: { id: -100, type: "supergroup" },
            date: 1_699_999_999,
            from: { first_name: "Osinara", id: 999, is_bot: true },
            message_id: 340,
            text: "Предыдущий ответ",
          },
          text: "Продолжи",
        },
        update_id: 1005,
      }),
      headers: { "x-telegram-bot-api-secret-token": "webhook-secret" },
      method: "POST",
    }), {
      params: {},
      requestIp: null,
      from: source.from,
      waitUntil(task: Promise<unknown>) {
        backgroundTask = task;
      },
    });
    await backgroundTask;

    expect(source.send.mock.calls[0]?.[0]).toEqual(expect.anything());
    expect(source.respond).not.toHaveBeenCalled();
    expect(source.from).toHaveBeenCalledWith("-100::340:osinara:2");
    expect(source.send.mock.calls[0]?.[1]).toMatchObject({
      state: {
        chatId: "-100",
        conversationId: "340",
      },
    });
  });

  it("preserves native synthetic HITL reply handling when the opt-out is absent", async () => {
    const source = createChannelSource({ id: "session-hitl-reply" });
    const channel = telegramChannel({
      credentials: { webhookSecretToken: "webhook-secret" },
      onMessage: async () => ({ auth: null }),
    });
    const route = channel.routes[0] as unknown as HttpRoute;
    let backgroundTask: Promise<unknown> | undefined;

    await route.handler(new Request("https://agent.example/eve/v1/telegram", {
      body: JSON.stringify({
        message: {
          chat: { id: -100, type: "supergroup" },
          date: 1_700_000_000,
          from: { first_name: "Анна", id: 101, is_bot: false },
          message_id: 343,
          reply_to_message: {
            chat: { id: -100, type: "supergroup" },
            date: 1_699_999_999,
            from: { first_name: "Osinara", id: 999, is_bot: true },
            message_id: 341,
            text: "Подтвердите действие",
          },
          text: "Да",
        },
        update_id: 1006,
      }),
      headers: { "x-telegram-bot-api-secret-token": "webhook-secret" },
      method: "POST",
    }), {
      params: {},
      requestIp: null,
      from: source.from,
      waitUntil(task: Promise<unknown>) {
        backgroundTask = task;
      },
    });
    await backgroundTask;

    expect(source.respond.mock.calls[0]?.[0]).toEqual([{
      requestId: "telegram_reply:341",
      text: "Да",
    }]);
  });

  it("exposes an authenticated private drain route on the same adapter", async () => {
    const source = createChannelSource({ id: "session-drain" });
    const update = parseTelegramUpdate({
      message: {
        chat: { id: 101, type: "private" },
        date: 1_700_000_000,
        from: { first_name: "Анна", id: 101, is_bot: false },
        message_id: 79,
        text: "Из очереди",
      },
      update_id: 1008,
    });
    if (update === null) throw new Error("TEST_TELEGRAM_UPDATE_INVALID");
    const onDrain = vi.fn((context) => {
      context.waitUntil(context.dispatch(update));
      return new Response("drained");
    });
    const channel = telegramChannel({
      credentials: { webhookSecretToken: "webhook-secret" },
      drainRoute: "/eve/v1/telegram-drain",
      onDrain,
    });
    const route = channel.routes[1] as unknown as HttpRoute;
    let backgroundTask: Promise<unknown> | undefined;
    const response = await route.handler(
      new Request("http://agent:3000/eve/v1/telegram-drain", {
        body: "{}",
        headers: { "x-telegram-bot-api-secret-token": "webhook-secret" },
        method: "POST",
      }),
      {
        params: {},
        requestIp: null,
        from: source.from,
        waitUntil(task: Promise<unknown>) {
          backgroundTask = task;
        },
      },
    );
    await backgroundTask;

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("drained");
    expect(onDrain).toHaveBeenCalledTimes(1);
    expect(source.send).toHaveBeenCalledTimes(1);
  });
});
