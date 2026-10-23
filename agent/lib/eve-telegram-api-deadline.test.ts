/**
 * Deadlines on Eve's own Telegram calls (vendored Eve, `channels/telegram/api.js`).
 *
 * Constructs covered:
 * - Every Bot API attempt gets its own 30-second deadline; the retry after a 429 gets a fresh one.
 * - A caller's fetch receives the deadline as `init.signal`, so a wrapper can combine it.
 * - A file download gets the longer download deadline.
 *
 * Node's fetch waits five minutes for response headers by default, so before this a stuck Telegram
 * call held the turn that long (skill review of 24 October 2026).
 */
import { callTelegramApi, downloadTelegramFile } from "eve/channels/telegram";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Eve Telegram API deadlines", () => {
  it("gives every Bot API attempt its own deadline, the retry after a 429 a fresh one", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const signals: Array<AbortSignal | null | undefined> = [];
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      signals.push(init?.signal);
      return signals.length === 1
        ? Response.json({ error_code: 429, ok: false, parameters: { retry_after: 1 } }, { status: 429 })
        : Response.json({ ok: true, result: true });
    });

    const response = await callTelegramApi({ botToken: "1:test", fetch, method: "getMe" });

    expect(response.ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(timeout.mock.calls.map(([ms]) => ms)).toEqual([30_000, 30_000]);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[1]).toBeInstanceOf(AbortSignal);
    expect(signals[1]).not.toBe(signals[0]);
  });

  it("gives a file download the longer deadline", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response("bytes");
    });

    const response = await downloadTelegramFile({ credentials: { botToken: "1:test" }, fetch, filePath: "photos/a.jpg" });

    expect(await response.text()).toBe("bytes");
    expect(timeout.mock.calls.map(([ms]) => ms)).toEqual([120_000]);
  });

  it("aborts an attempt Telegram never answers", async () => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const fetch = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("timed out", "TimeoutError")));
    }));

    const pending = callTelegramApi({ botToken: "1:test", fetch, method: "getMe" });
    // The call resolves the token and takes its pacing slot first; abort once the request is out.
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
  });
});
