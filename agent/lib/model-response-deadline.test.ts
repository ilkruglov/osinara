/**
 * Model response deadline tests.
 *
 * Constructs covered:
 * - A provider that does not start answering is cut off with a stable application error.
 * - A stream that stops sending is cut off; one that keeps sending may run longer than the limit.
 * - Keep-alive is silence: SSE comment lines and blank lines neither end the wait for the first
 *   answer nor restart the idle timer, also when a comment is split across chunks (Codex review,
 *   6 November 2026: DeepSeek's keep-alive kept a stalled call open forever).
 * - The deadline errors the body itself, whatever the provider's stream does with the abort, and
 *   leaves no timer behind once the body ends or fails.
 * - The caller's own cancellation still reaches the request.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { withResponseDeadlines } from "./model-response-deadline.js";

const LIMITS = { idleMs: 60, startMs: 60 };

function never(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

/** A stream that sends `chunks` 20 ms apart and ignores any abort. */
function paced(chunks: string[]): Response {
  let index = 0;
  return new Response(
    new ReadableStream({
      async pull(controller) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (index < chunks.length) controller.enqueue(new TextEncoder().encode(chunks[index++]));
        else controller.close();
      },
    }),
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe("model response deadlines", () => {
  it.each([
    ["SSE keep-alive comments", Array.from({ length: 12 }, () => ": keep-alive\n\n")],
    ["blank lines", Array.from({ length: 12 }, () => "\n")],
    [
      "a comment split across chunks",
      Array.from({ length: 6 }, () => [": keep-", "alive\n\n"]).flat(),
    ],
  ])("cuts off a provider that answers with %s only", async (_name, chunks) => {
    const fetchWithDeadline = withResponseDeadlines(async () => paced(chunks), LIMITS);
    const response = await fetchWithDeadline("https://api.deepseek.com/responses", {});
    await expect(response.text()).rejects.toMatchObject({ code: "AGENT_MODEL_RESPONSE_TIMEOUT" });
  });

  it("cuts off a stream that goes back to keep-alive after its first data", async () => {
    const chunks = ['data: {"a":1}\n\n', ...Array.from({ length: 12 }, () => ": keep-alive\n\n")];
    const fetchWithDeadline = withResponseDeadlines(async () => paced(chunks), LIMITS);
    const response = await fetchWithDeadline("https://api.deepseek.com/responses", {});
    await expect(response.text()).rejects.toMatchObject({ code: "AGENT_MODEL_RESPONSE_TIMEOUT" });
  });

  it("leaves no timer behind once the body ends or fails", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fetchWithDeadline = withResponseDeadlines(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("data: x\n\n"));
              controller.error(new Error("connection reset"));
            },
          }),
        ),
      { idleMs: 10_000, startMs: 10_000 },
    );
    const failed = await fetchWithDeadline("https://api.deepseek.com/responses", {});
    await expect(failed.text()).rejects.toThrow("connection reset");
    expect(vi.getTimerCount()).toBe(0);

    const finished = await withResponseDeadlines(async () => new Response("{}"), {
      idleMs: 10_000,
      startMs: 10_000,
    })("https://api.deepseek.com/responses", {});
    await expect(finished.text()).resolves.toBe("{}");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cuts off a provider that never starts answering", async () => {
    const fetchWithDeadline = withResponseDeadlines(
      async (_input, init) => await never(init?.signal),
      LIMITS,
    );
    await expect(fetchWithDeadline("https://api.deepseek.com/responses", {})).rejects.toMatchObject(
      { code: "AGENT_MODEL_RESPONSE_TIMEOUT" },
    );
  });

  it("cuts off a stream that stops sending", async () => {
    const fetchWithDeadline = withResponseDeadlines(
      async (_input, init) =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("data: first\n\n"));
              init?.signal?.addEventListener("abort", () => controller.error(init.signal!.reason), {
                once: true,
              });
            },
          }),
        ),
      LIMITS,
    );
    const response = await fetchWithDeadline("https://api.deepseek.com/responses", {});
    await expect(response.text()).rejects.toMatchObject({ code: "AGENT_MODEL_RESPONSE_TIMEOUT" });
  });

  it("lets a stream that keeps sending run past the limit", async () => {
    const fetchWithDeadline = withResponseDeadlines(async () => {
      let sent = 0;
      return new Response(
        new ReadableStream({
          async pull(controller) {
            await new Promise((resolve) => setTimeout(resolve, 30));
            if (sent++ < 6) controller.enqueue(new TextEncoder().encode("x"));
            else controller.close();
          },
        }),
      );
    }, LIMITS);
    const response = await fetchWithDeadline("https://api.deepseek.com/responses", {});
    expect(await response.text()).toBe("xxxxxx");
  });

  it("passes the caller's cancellation through", async () => {
    const caller = new AbortController();
    const fetchWithDeadline = withResponseDeadlines(
      async (_input, init) => await never(init?.signal),
      { idleMs: 10_000, startMs: 10_000 },
    );
    const pending = fetchWithDeadline("https://api.deepseek.com/responses", {
      signal: caller.signal,
    });
    caller.abort(new Error("turn cancelled"));
    await expect(pending).rejects.toThrow("turn cancelled");
  });
});
