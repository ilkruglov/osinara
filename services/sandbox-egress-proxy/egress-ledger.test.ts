/**
 * Egress accounting.
 *
 * Constructs covered:
 * - Every connection is one log line with client, host, port, bytes and duration.
 * - A client past its daily budget is refused until the next UTC day; others are not.
 */
import { describe, expect, it } from "vitest";

import { createEgressLedger } from "./egress-ledger.js";

describe("createEgressLedger", () => {
  it("logs each connection and refuses a client past its daily budget until the next day", () => {
    const lines: string[] = [];
    let now = Date.UTC(2026, 9, 5, 12);
    const ledger = createEgressLedger({ dailyBytes: 1_000, log: (line) => lines.push(line), now: () => now });

    expect(ledger.admit("172.20.0.5")).toBe(true);
    ledger.record({ bytesDown: 900, bytesUp: 200, client: "172.20.0.5", host: "example.com", kind: "connect", ms: 30, port: 443 });
    expect(JSON.parse(lines[0]!)).toEqual({
      bytesDown: 900, bytesUp: 200, client: "172.20.0.5", code: "SANDBOX_EGRESS_CONNECTION",
      host: "example.com", kind: "connect", ms: 30, port: 443,
    });
    expect(ledger.admit("172.20.0.5")).toBe(false);
    expect(lines.at(-1)).toContain("SANDBOX_EGRESS_DAILY_LIMIT");
    expect(ledger.admit("172.20.0.6")).toBe(true);

    now += 24 * 60 * 60 * 1000;
    expect(ledger.admit("172.20.0.5")).toBe(true);
  });
});
