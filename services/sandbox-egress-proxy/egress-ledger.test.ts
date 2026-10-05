/**
 * Egress accounting.
 *
 * Constructs covered:
 * - Every connection is one log line with client, host, port, bytes and duration.
 * - Bytes count while they flow and add up across a client's connections; a client past its
 *   daily budget gets no new connection and its open ones are told to stop, until the next UTC
 *   day; other clients are not affected.
 */
import { describe, expect, it } from "vitest";

import { createEgressLedger } from "./egress-ledger.js";

describe("createEgressLedger", () => {
  it("logs each connection with its bytes and duration", () => {
    const lines: string[] = [];
    let now = Date.UTC(2026, 9, 5, 12);
    const ledger = createEgressLedger({ dailyBytes: 10_000, log: (line) => lines.push(line), now: () => now });

    const meter = ledger.open("172.20.0.5")!;
    meter.add("up", 200);
    meter.add("down", 900);
    now += 30;
    meter.close({ host: "example.com", kind: "connect", port: 443 });
    meter.close({ host: "example.com", kind: "connect", port: 443 });

    expect(lines.map((line) => JSON.parse(line))).toEqual([{
      bytesDown: 900, bytesUp: 200, client: "172.20.0.5", code: "SANDBOX_EGRESS_CONNECTION",
      host: "example.com", kind: "connect", ms: 30, port: 443,
    }]);
  });

  it("adds up a client's connections, closed and open, and refuses past the budget until the next day", () => {
    // Codex review, 5 October 2026: the count kept only the last connection, and an open tunnel
    // was counted only when it closed, so neither many small nor one long connection was bounded.
    const lines: string[] = [];
    let now = Date.UTC(2026, 9, 5, 12);
    const ledger = createEgressLedger({ dailyBytes: 1_000, log: (line) => lines.push(line), now: () => now });

    for (let index = 0; index < 2; index += 1) {
      const meter = ledger.open("172.20.0.5")!;
      expect(meter.add("down", 400)).toBe(true);
      meter.close({ host: "example.com", kind: "http", port: 80 });
    }
    const long = ledger.open("172.20.0.5")!;
    const parallel = ledger.open("172.20.0.5")!;
    expect(long.add("down", 150)).toBe(true);
    // The parallel connection crosses the budget; the long one learns it on its next chunk.
    expect(parallel.add("up", 100)).toBe(false);
    expect(long.add("down", 1)).toBe(false);
    expect(ledger.open("172.20.0.5")).toBeNull();
    expect(lines.filter((line) => line.includes("SANDBOX_EGRESS_DAILY_LIMIT"))).toHaveLength(3);
    expect(ledger.open("172.20.0.6")).not.toBeNull();

    now += 24 * 60 * 60 * 1000;
    expect(ledger.open("172.20.0.5")).not.toBeNull();
  });
});
