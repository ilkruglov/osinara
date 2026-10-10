/**
 * Eve unparsed-update patch tests.
 *
 * Eve 0.40.0 drops every verified webhook update its parser does not know, so a Telegram
 * `message_reaction` never reached the application. The patch hands such an update to
 * `onUnparsedUpdate` after webhook verification; without the hook the update is dropped as before.
 */
import { readFile } from "node:fs/promises";

import { telegramChannel } from "eve/channels/telegram";
import { describe, expect, it, vi } from "vitest";

import { codeText } from "./vendored-code.js";

interface HttpRoute {
  handler(request: Request, context: Record<string, unknown>): Promise<Response>;
}

const reaction = { message_reaction: { chat: { id: -100 }, date: 1, message_id: 5, new_reaction: [], user: { id: 7 } }, update_id: 3 };

function post(body: unknown, secret: string) {
  return new Request("https://agent.example/eve/v1/telegram", {
    body: JSON.stringify(body),
    headers: { "x-telegram-bot-api-secret-token": secret },
    method: "POST",
  });
}

describe("Eve unparsed update patch", () => {
  it("pins the seam in the vendored runtime and types", async () => {
    const runtime = await readFile("vendor/eve/dist/src/public/channels/telegram/telegramChannel.js", "utf8");
    const types = await readFile("vendor/eve/dist/src/public/channels/telegram/telegramChannel.d.ts", "utf8");
    expect(codeText(runtime)).toContain(codeText("if (u === null) return e.onUnparsedUpdate === void 0 ? new Response(`ok`) : e.onUnparsedUpdate(c);"));
    expect(types.match(/readonly onUnparsedUpdate\?: \(raw: JsonObject\) => Response \| Promise<Response>;/g)).toHaveLength(1);
  });

  it("hands a verified reaction update to the hook and never an unverified one", async () => {
    const onUnparsedUpdate = vi.fn().mockResolvedValue(new Response("recorded"));
    const onVerifiedUpdate = vi.fn();
    const channel = telegramChannel({ credentials: { webhookSecretToken: "secret" }, onUnparsedUpdate, onVerifiedUpdate });
    const route = channel.routes[0] as unknown as HttpRoute;
    const context = { from: vi.fn(), params: {}, requestIp: null, waitUntil: vi.fn() };

    expect((await route.handler(post(reaction, "wrong"), context)).status).toBe(401);
    expect(onUnparsedUpdate).not.toHaveBeenCalled();

    const response = await route.handler(post(reaction, "secret"), context);
    expect(await response.text()).toBe("recorded");
    expect(onUnparsedUpdate).toHaveBeenCalledWith(reaction);
    expect(onVerifiedUpdate).not.toHaveBeenCalled();
  });

  it("drops an unparsed update as before when no hook is configured", async () => {
    const channel = telegramChannel({ credentials: { webhookSecretToken: "secret" } });
    const route = channel.routes[0] as unknown as HttpRoute;
    const response = await route.handler(post(reaction, "secret"), { from: vi.fn(), params: {}, requestIp: null, waitUntil: vi.fn() });
    expect(await response.text()).toBe("ok");
  });
});
