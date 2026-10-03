/**
 * Process memory log of the agent server.
 *
 * Constructs covered:
 * - One `AGENT_PROCESS_MEMORY` line carries RSS, heap used and total, external memory and the
 *   heap limit, in megabytes.
 * - Lines are throttled to one a minute however many turns arrive.
 */
import { describe, expect, it, vi } from "vitest";

import { createProcessMemoryLog } from "./process-memory.js";

describe("process memory log", () => {
  it("reports the heap against its limit at most once a minute", () => {
    const log = vi.fn();
    const report = createProcessMemoryLog(log);

    report(1_000_000);
    report(1_030_000);
    report(1_061_000);

    expect(log).toHaveBeenCalledTimes(2);
    const line = JSON.parse(log.mock.calls[0]![0] as string) as Record<string, unknown>;
    expect(line).toMatchObject({ code: "AGENT_PROCESS_MEMORY" });
    for (const field of ["rssMb", "heapUsedMb", "heapTotalMb", "externalMb", "heapLimitMb"]) {
      expect(typeof line[field]).toBe("number");
      expect(line[field] as number).toBeGreaterThanOrEqual(0);
    }
    expect(line.heapLimitMb as number).toBeGreaterThan(line.heapUsedMb as number);
  });
});
