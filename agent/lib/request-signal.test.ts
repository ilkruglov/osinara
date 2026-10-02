/**
 * Per-request deadline contract tests.
 *
 * Constructs covered:
 * - Every request gets its own deadline instead of one shared by the adapter.
 * - An outer cancellation and the request's own signal both still abort the request.
 */
import { describe, expect, it } from "vitest";

import { deadlineSignal, withRequestTimeout } from "./request-signal.js";

describe("request deadlines", () => {
  it("joins the deadline with every present caller signal", () => {
    const caller = new AbortController();
    const signal = deadlineSignal(60_000, undefined, caller.signal);
    expect(signal.aborted).toBe(false);
    caller.abort();
    expect(signal.aborted).toBe(true);
  });

  it("aborts on the deadline alone", async () => {
    const signal = deadlineSignal(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(signal.aborted).toBe(true);
  });

  it("gives each request a fresh deadline and keeps outer and request signals", async () => {
    const seen: AbortSignal[] = [];
    const fake: typeof fetch = async (_request, init) => {
      seen.push(init!.signal!);
      return new Response("ok");
    };
    const outer = new AbortController();
    const own = new AbortController();
    const bounded = withRequestTimeout(fake, 60_000, outer.signal);
    await bounded("https://example.com");
    await bounded("https://example.com", { signal: own.signal });
    expect(seen[0]).not.toBe(seen[1]);
    own.abort();
    expect(seen[1]!.aborted).toBe(true);
    expect(seen[0]!.aborted).toBe(false);
    outer.abort();
    expect(seen[0]!.aborted).toBe(true);
  });
});
