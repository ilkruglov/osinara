/** Stream failures and late cleanup must remain bounded and observable at the ingress boundary. */
import { describe, expect, it, vi } from "vitest";
import { waitForSessionBoundary } from "./telegram-session-boundary.js";

describe("waitForSessionBoundary", () => {
  it("preserves a failure to open the stream", async () => {
    const error = new Error("stream storage unavailable");
    await expect(waitForSessionBoundary({
      id: "session", getEventStream: async () => { throw error; },
    }, 0, 100)).rejects.toBe(error);
  });

  it("rejects a closed stream without a boundary", async () => {
    await expect(waitForSessionBoundary({
      id: "session",
      getEventStream: async () => new ReadableStream({ start(c) { c.close(); } }),
    }, 0, 100)).rejects.toMatchObject({ code: "AGENT_TELEGRAM_SESSION_BOUNDARY_MISSING" });
  });

  it("preserves the completed cursor despite cancellation failure", async () => {
    const error = new Error("stream cancellation failed");
    const stream = new ReadableStream({
      start(c) { c.enqueue({ type: "session.waiting" }); },
      cancel() { throw error; },
    });
    await expect(waitForSessionBoundary({ id: "session", getEventStream: async () => stream }, 0, 100)).resolves.toBe(1);
    expect(stream.locked).toBe(false);
  });

  it("settles a timeout even when cancelling the silent stream rejects", async () => {
    const cancel = vi.fn(() => { throw new Error("cancel failed after timeout"); });
    const stream = new ReadableStream<{ type: string }>({ cancel });
    await expect(waitForSessionBoundary({ id: "session", getEventStream: async () => stream }, 0, 10))
      .rejects.toMatchObject({ code: "AGENT_TELEGRAM_SESSION_BOUNDARY_TIMEOUT" });
    await vi.waitFor(() => expect(stream.locked).toBe(false));
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("does not reuse a boundary for either of the next two turns after stuck cleanup", async () => {
    const history = [{ type: "turn.started" }, { type: "session.waiting" }];
    let controller!: ReadableStreamDefaultController<{ type: string }>;
    let releaseCancel!: () => void;
    let opens = 0;
    const session = {
      id: "reused-session",
      async getEventStream(options?: { startIndex?: number }) {
        opens += 1;
        const first = opens === 1;
        return new ReadableStream({
          start(c) {
            controller = c;
            for (const event of history.slice(options?.startIndex ?? 0)) c.enqueue(event);
          },
          cancel() { if (first) return new Promise<void>((resolve) => { releaseCancel = resolve; }); },
        });
      },
    };
    let cursor = await waitForSessionBoundary(session, 0, 10);
    releaseCancel();
    expect(cursor).toBe(2);
    for (const expectedCursor of [4, 6]) {
      history.push({ type: "turn.started" });
      const pending = waitForSessionBoundary(session, cursor, 200);
      const settledEarly = await Promise.race([
        pending.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 15)),
      ]);
      expect(settledEarly).toBe(false);
      const waiting = { type: "session.waiting" };
      history.push(waiting);
      controller.enqueue(waiting);
      cursor = await pending;
      expect(cursor).toBe(expectedCursor);
    }
  });
});
