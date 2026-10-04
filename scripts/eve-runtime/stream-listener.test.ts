/**
 * Workflow stream listener tests.
 *
 * Constructs covered:
 * - Payloads of the LISTEN client reach the handler.
 * - A connection that ends is replaced: a new client is connected, LISTENs again and its payloads
 *   reach the handler; the loss and the recovery are logged.
 * - A failed reconnect is retried with a growing delay.
 * - Close stops the listener and no reconnect follows.
 */
import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { createStreamListener } from "./stream-listener.ts";

class FakeClient extends EventEmitter {
  queries: string[] = [];
  ended = false;
  constructor(private readonly failConnect = false) { super(); }
  async connect() { if (this.failConnect) throw new Error("ECONNREFUSED"); }
  async query(text: string) { this.queries.push(text); return undefined; }
  async end() { this.ended = true; }
}

describe("workflow stream listener", () => {
  it("delivers payloads, reconnects after the connection ends and stops on close", async () => {
    const clients: FakeClient[] = [];
    const payloads: string[] = [];
    const log = vi.fn();
    const sleeps: number[] = [];
    const listener = await createStreamListener({
      channel: "workflow_event_chunk",
      connect: () => { const client = new FakeClient(clients.length === 1); clients.push(client); return client; },
      log,
      onPayload: async (payload) => { payloads.push(payload); },
      retryDelayMs: 100,
      sleep: async (ms) => { sleeps.push(ms); },
    });
    expect(clients[0]!.queries).toEqual(["LISTEN workflow_event_chunk"]);
    clients[0]!.emit("notification", { payload: "one" });
    expect(payloads).toEqual(["one"]);

    // The connection drops: the first replacement fails to connect, the second takes over.
    clients[0]!.emit("end");
    await vi.waitFor(() => expect(clients).toHaveLength(3));
    await vi.waitFor(() => expect(clients[2]!.queries).toEqual(["LISTEN workflow_event_chunk"]));
    expect(sleeps).toEqual([100, 200]);
    expect(clients[1]!.ended).toBe(true);
    clients[0]!.emit("notification", { payload: "stale" });
    clients[2]!.emit("notification", { payload: "two" });
    expect(payloads).toEqual(["one", "two"]);
    const codes = log.mock.calls.map(([line]) => (JSON.parse(line as string) as { code: string }).code);
    expect(codes).toEqual([
      "AGENT_WORKFLOW_STREAM_LISTENER_LOST",
      "AGENT_WORKFLOW_STREAM_LISTENER_RETRY_FAILED",
      "AGENT_WORKFLOW_STREAM_LISTENER_RECONNECTED",
    ]);

    await listener.close();
    expect(clients[2]!.queries).toEqual(["LISTEN workflow_event_chunk", "UNLISTEN workflow_event_chunk"]);
    expect(clients[2]!.ended).toBe(true);
    clients[2]!.emit("end");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(clients).toHaveLength(3);
  });

  it("survives a second error of a lost client and a close during a reconnect", async () => {
    const clients: FakeClient[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const listener = await createStreamListener({
      channel: "workflow_event_chunk",
      connect: () => {
        const client = new FakeClient();
        // The replacement's connect is held open so close() can arrive while it is under way.
        if (clients.length === 1) client.connect = () => held;
        clients.push(client);
        return client;
      },
      log: () => {},
      onPayload: async () => {},
      retryDelayMs: 1,
      sleep: async () => {},
    });
    // Postgres going down: a FATAL error, then the socket ends; neither may escape as unhandled.
    clients[0]!.emit("error", new Error("terminating connection due to administrator command"));
    clients[0]!.emit("error", new Error("Connection terminated unexpectedly"));
    clients[0]!.emit("end");
    expect(clients[0]!.ended).toBe(true);
    await vi.waitFor(() => expect(clients).toHaveLength(2));
    await listener.close();
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    // The replacement finished connecting after close and was ended at once; no third client follows.
    expect(clients).toHaveLength(2);
    expect(clients[1]!.ended).toBe(true);
  });

  it("fails the first connection instead of retrying it in the background", async () => {
    await expect(createStreamListener({
      channel: "workflow_event_chunk",
      connect: () => new FakeClient(true),
      onPayload: async () => {},
    })).rejects.toThrow("ECONNREFUSED");
  });
});
