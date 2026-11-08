/**
 * Declaring `/whisper` to Telegram for all group chats.
 *
 * Constructs covered:
 * - An installation without the command declares it, ephemeral, for all group chats.
 * - A matching declaration is left alone; other group commands are kept when it is added.
 * - A refused read or write is an error with a stable code, never a silent success.
 */
import { describe, expect, it, vi } from "vitest";

import { TELEGRAM_WHISPER_BOT_COMMAND } from "./telegram-whisper.js";
import { ensureTelegramWhisperCommand } from "./whisper-command-registration.js";

function telegram(...bodies: Array<{ body: unknown; status?: number }>) {
  const queue = [...bodies];
  return vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => {
    const next = queue.shift()!;
    return new Response(JSON.stringify(next.body), {
      headers: { "content-type": "application/json" },
      status: next.status ?? 200,
    });
  });
}

function call(fetch: ReturnType<typeof telegram>, index: number) {
  const [url, init] = fetch.mock.calls[index]!;
  return {
    body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    method: String(url).split("/").at(-1),
  };
}

describe("ensureTelegramWhisperCommand", () => {
  it("declares the ephemeral command for all group chats when it is missing", async () => {
    const fetch = telegram(
      { body: { ok: true, result: [] } },
      { body: { ok: true, result: true } },
    );

    await expect(ensureTelegramWhisperCommand({ botToken: "token", fetch })).resolves.toBe(
      "updated",
    );

    expect(call(fetch, 0)).toEqual({
      body: { scope: { type: "all_group_chats" } },
      method: "getMyCommands",
    });
    expect(call(fetch, 1)).toEqual({
      body: { commands: [TELEGRAM_WHISPER_BOT_COMMAND], scope: { type: "all_group_chats" } },
      method: "setMyCommands",
    });
  });

  it("leaves a matching declaration alone", async () => {
    const fetch = telegram({ body: { ok: true, result: [{ ...TELEGRAM_WHISPER_BOT_COMMAND }] } });

    await expect(ensureTelegramWhisperCommand({ botToken: "token", fetch })).resolves.toBe(
      "unchanged",
    );
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("keeps other group commands when it adds or repairs its own", async () => {
    const fetch = telegram(
      {
        body: {
          ok: true,
          result: [
            { command: "help", description: "Справка" },
            { command: "whisper", description: "старое" },
          ],
        },
      },
      { body: { ok: true, result: true } },
    );

    await expect(ensureTelegramWhisperCommand({ botToken: "token", fetch })).resolves.toBe(
      "updated",
    );
    expect(call(fetch, 1).body.commands).toEqual([
      { command: "help", description: "Справка" },
      TELEGRAM_WHISPER_BOT_COMMAND,
    ]);
  });

  it("fails with a stable code when Telegram refuses", async () => {
    const fetch = telegram({
      body: { description: "Unauthorized", error_code: 401, ok: false },
      status: 401,
    });

    await expect(ensureTelegramWhisperCommand({ botToken: "token", fetch })).rejects.toMatchObject({
      code: "AGENT_TELEGRAM_WHISPER_COMMAND_FAILED",
    });
  });
});
