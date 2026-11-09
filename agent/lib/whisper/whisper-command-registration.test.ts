/**
 * Declaring `/whisper` to Telegram for all group chats.
 *
 * Constructs covered:
 * - An installation without the command declares it, ephemeral, for all group chats.
 * - The group list is the default list and the command: Telegram shows the narrowest list, so a
 *   list of `/whisper` alone hid the default commands in groups (/code-review of 1.8.57–1.8.58), and
 *   a copy taken once kept groups on an old default list. A list that already matches is left alone.
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
    expect(call(fetch, 2)).toEqual({
      body: { commands: [TELEGRAM_WHISPER_BOT_COMMAND], scope: { type: "all_group_chats" } },
      method: "setMyCommands",
    });
  });

  it("starts an empty group list from the default commands, which it would otherwise hide in groups", async () => {
    const fetch = telegram(
      { body: { ok: true, result: [] } },
      { body: { ok: true, result: [{ command: "help", description: "Справка" }] } },
      { body: { ok: true, result: true } },
    );

    await expect(ensureTelegramWhisperCommand({ botToken: "token", fetch })).resolves.toBe(
      "updated",
    );

    expect(call(fetch, 1)).toEqual({
      body: { scope: { type: "default" } },
      method: "getMyCommands",
    });
    expect(call(fetch, 2).body.commands).toEqual([
      { command: "help", description: "Справка" },
      TELEGRAM_WHISPER_BOT_COMMAND,
    ]);
  });

  it("leaves the group list alone while it is the default list and the command", async () => {
    const help = { command: "help", description: "Справка" };
    const fetch = telegram(
      { body: { ok: true, result: [help, { ...TELEGRAM_WHISPER_BOT_COMMAND }] } },
      { body: { ok: true, result: [help] } },
    );

    await expect(ensureTelegramWhisperCommand({ botToken: "token", fetch })).resolves.toBe(
      "unchanged",
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("repairs its own command in the group list", async () => {
    const help = { command: "help", description: "Справка" };
    const fetch = telegram(
      { body: { ok: true, result: [help, { command: "whisper", description: "старое" }] } },
      { body: { ok: true, result: [help] } },
      { body: { ok: true, result: true } },
    );

    await expect(ensureTelegramWhisperCommand({ botToken: "token", fetch })).resolves.toBe(
      "updated",
    );
    expect(call(fetch, 2).body.commands).toEqual([help, TELEGRAM_WHISPER_BOT_COMMAND]);
  });

  // /code-review of the fix, 9 November 2026: a copy taken once kept groups on the old default list.
  it("follows a later change of the default commands into the group list", async () => {
    const help = { command: "help", description: "Справка" };
    const start = { command: "start", description: "Начать" };
    const fetch = telegram(
      { body: { ok: true, result: [help, { ...TELEGRAM_WHISPER_BOT_COMMAND }] } },
      { body: { ok: true, result: [start, help] } },
      { body: { ok: true, result: true } },
    );

    await expect(ensureTelegramWhisperCommand({ botToken: "token", fetch })).resolves.toBe(
      "updated",
    );
    expect(call(fetch, 2).body.commands).toEqual([start, help, TELEGRAM_WHISPER_BOT_COMMAND]);
  });

  // /code-review of the fix, 9 November 2026: Telegram takes at most 100 commands in a list.
  it("keeps the group list within Telegram's hundred commands, the command included", async () => {
    const defaults = Array.from({ length: 100 }, (_, index) => ({
      command: `c${index}`,
      description: `Команда ${index}`,
    }));
    const fetch = telegram(
      { body: { ok: true, result: [] } },
      { body: { ok: true, result: defaults } },
      { body: { ok: true, result: true } },
    );

    await ensureTelegramWhisperCommand({ botToken: "token", fetch });

    const commands = call(fetch, 2).body.commands as unknown[];
    expect(commands).toHaveLength(100);
    expect(commands.at(-1)).toEqual(TELEGRAM_WHISPER_BOT_COMMAND);
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
