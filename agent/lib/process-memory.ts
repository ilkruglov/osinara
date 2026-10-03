/**
 * Process memory of the agent server against its heap limit.
 *
 * Exports:
 * - `createProcessMemoryLog`: a reporter that writes one `AGENT_PROCESS_MEMORY` line at most once a
 *   minute (RSS, heap used and total, external memory, heap limit; megabytes).
 * - `logProcessMemory`: the process-wide reporter, called when a turn's inbound is prepared.
 *
 * Key construct:
 * - The server runs with a bounded V8 heap since 1.8.16 (`--max-old-space-size` in the
 *   entrypoint). Without a limit V8 kept ~1 GB of garbage under load (load run, 3 October 2026);
 *   with it, heap used against the limit shows how close a real day comes to an out-of-memory exit.
 */
import { getHeapStatistics } from "node:v8";

const INTERVAL_MILLISECONDS = 60_000;
const megabytes = (bytes: number) => Math.round(bytes / 1_048_576);

export function createProcessMemoryLog(log: (line: string) => void = console.info) {
  let lastAt = Number.NEGATIVE_INFINITY;
  return function report(now: number = Date.now()): void {
    if (now - lastAt < INTERVAL_MILLISECONDS) return;
    lastAt = now;
    const usage = process.memoryUsage();
    log(JSON.stringify({
      code: "AGENT_PROCESS_MEMORY",
      externalMb: megabytes(usage.external),
      heapLimitMb: megabytes(getHeapStatistics().heap_size_limit),
      heapTotalMb: megabytes(usage.heapTotal),
      heapUsedMb: megabytes(usage.heapUsed),
      rssMb: megabytes(usage.rss),
    }));
  };
}

export const logProcessMemory = createProcessMemoryLog();
