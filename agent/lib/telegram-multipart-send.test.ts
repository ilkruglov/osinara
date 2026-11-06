/**
 * Multipart Bot API uploads under the client's 429 rule.
 *
 * Constructs covered:
 * - An upload waits for its slot; a 429 pauses every call for the time Telegram names and the upload
 *   is tried once more after it, with its own slot.
 * - A second 429 pauses the other calls too and goes back to the caller; a pause over the cap is not
 *   waited out; a 429 without `retry_after` is returned as it is.
 */
import { describe, expect, it, vi } from "vitest";

import { postTelegramMultipart } from "./telegram-multipart-send.js";

function pacer(accepts = true) {
  return {
    acquire: vi.fn(async () => undefined),
    retryAfter: vi.fn(() => accepts),
    waitForPause: vi.fn(async () => undefined),
  };
}

const tooMany = (seconds?: number) => new Response(JSON.stringify({
  description: "Too Many Requests", error_code: 429, ok: false, ...(seconds === undefined ? {} : { parameters: { retry_after: seconds } }),
}), { status: 429 });
const sent = () => new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), { status: 200 });

type FetchMock = ReturnType<typeof vi.fn<(url: string, init: RequestInit) => Promise<Response>>>;

function upload(fetchMock: FetchMock, paced: ReturnType<typeof pacer>) {
  const form = new FormData();
  form.set("chat_id", "101");
  return postTelegramMultipart({ chatId: "101", fetch: fetchMock, form, method: "sendDocument", pacer: paced, timeoutMs: 1_000, token: "123:t" });
}

describe("postTelegramMultipart", () => {
  it("pauses every call after a 429 and tries the upload once more with its own slot", async () => {
    const paced = pacer();
    const fetchMock: FetchMock = vi.fn().mockResolvedValueOnce(tooMany(3)).mockResolvedValueOnce(sent());

    const response = await upload(fetchMock, paced);

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]![0]).toBe("https://api.telegram.org/bot123:t/sendDocument");
    expect(paced.retryAfter).toHaveBeenCalledExactlyOnceWith(3);
    expect(paced.waitForPause).toHaveBeenCalledOnce();
    expect(paced.acquire).toHaveBeenCalledTimes(2);
    expect(paced.acquire).toHaveBeenCalledWith("sendDocument", { chat_id: "101" });
  });

  it("pauses the others after a second 429 and gives it back", async () => {
    const paced = pacer();
    const fetchMock: FetchMock = vi.fn().mockResolvedValueOnce(tooMany(3)).mockResolvedValueOnce(tooMany(9));

    const response = await upload(fetchMock, paced);

    expect(response.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(paced.retryAfter.mock.calls).toEqual([[3], [9]]);
  });

  it("returns a 429 whose pause is over the cap or unnamed without trying again", async () => {
    const overCap = pacer(false);
    const fetchOverCap: FetchMock = vi.fn().mockResolvedValueOnce(tooMany(600));
    await expect(upload(fetchOverCap, overCap)).resolves.toMatchObject({ status: 429 });
    expect(fetchOverCap).toHaveBeenCalledOnce();
    expect(overCap.waitForPause).not.toHaveBeenCalled();

    const unnamed = pacer();
    const fetchUnnamed: FetchMock = vi.fn().mockResolvedValueOnce(tooMany());
    await expect(upload(fetchUnnamed, unnamed)).resolves.toMatchObject({ status: 429 });
    expect(fetchUnnamed).toHaveBeenCalledOnce();
    expect(unnamed.retryAfter).not.toHaveBeenCalled();
  });
});
