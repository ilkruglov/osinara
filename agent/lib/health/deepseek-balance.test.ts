/**
 * DeepSeek balance reader tests.
 *
 * Constructs covered:
 * - Only a DeepSeek installation asks; the USD entry of a good answer is read.
 * - A missing key, an HTTP error and a malformed body give null and a log line, never a throw.
 * - The digest line warns when requests are blocked or the balance is under the threshold, and
 *   otherwise reports the balance with the day's spend.
 */
import { describe, expect, it, vi } from "vitest";

import { formatDeepSeekBalance, readDeepSeekBalance } from "./deepseek-balance.js";

const good = { balance_infos: [{ currency: "CNY", total_balance: "1.00" }, { currency: "USD", total_balance: "12.34" }], is_available: true };
const fetchWith = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("readDeepSeekBalance", () => {
  it("reads the USD balance of a DeepSeek installation", async () => {
    const fetch = fetchWith(200, good);
    await expect(readDeepSeekBalance({ apiKey: "k", baseUrl: "https://api.deepseek.com", fetch, provider: "deepseek" })).resolves.toEqual({ available: true, totalUsd: 12.34 });
    expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe("https://api.deepseek.com/user/balance");
  });

  it("asks nothing of another provider or host", async () => {
    const fetch = fetchWith(200, good);
    await expect(readDeepSeekBalance({ apiKey: "k", baseUrl: "https://api.deepseek.com", fetch, provider: "groq" })).resolves.toBeNull();
    await expect(readDeepSeekBalance({ apiKey: "k", baseUrl: "https://proxy.example/v1", fetch, provider: "deepseek" })).resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns null and logs instead of throwing", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(readDeepSeekBalance({ apiKey: undefined, baseUrl: "https://api.deepseek.com", provider: "deepseek" })).resolves.toBeNull();
    await expect(readDeepSeekBalance({ apiKey: "k", baseUrl: "https://api.deepseek.com", fetch: fetchWith(401, {}), provider: "deepseek" })).resolves.toBeNull();
    await expect(readDeepSeekBalance({ apiKey: "k", baseUrl: "https://api.deepseek.com", fetch: fetchWith(200, { is_available: "yes" }), provider: "deepseek" })).resolves.toBeNull();
    expect(error).toHaveBeenCalledTimes(3);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('"reason":"http_401"'));
    error.mockRestore();
  });
});

describe("formatDeepSeekBalance", () => {
  it("warns when blocked or low, informs otherwise", () => {
    expect(formatDeepSeekBalance(null, 5)).toBeNull();
    expect(formatDeepSeekBalance({ available: false, totalUsd: -0.04 }, 5)).toEqual({ text: "DeepSeek: запросы недоступны, баланс −0,04 $. Бот не может отвечать, пополните счёт.", warning: true });
    expect(formatDeepSeekBalance({ available: true, totalUsd: 3.5 }, 5)?.warning).toBe(true);
    expect(formatDeepSeekBalance({ available: true, totalUsd: 12.5 }, 5, -1.2)).toEqual({ text: "DeepSeek: баланс 12,50 $, за сутки −1,20 $.", warning: false });
    expect(formatDeepSeekBalance({ available: true, totalUsd: 30 }, 5, 20)).toEqual({ text: "DeepSeek: баланс 30,00 $, за сутки +20,00 $.", warning: false });
    expect(formatDeepSeekBalance({ available: true, totalUsd: 12.5 }, 5)).toEqual({ text: "DeepSeek: баланс 12,50 $.", warning: false });
  });
});
