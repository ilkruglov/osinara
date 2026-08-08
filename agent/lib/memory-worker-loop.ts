/**
 * Graceful background memory worker process loop.
 *
 * Export:
 * - `runMemoryWorkerLoop`: stops claiming on cancellation and closes resources after active work.
 */
import { setTimeout as sleep } from "node:timers/promises";

export async function runMemoryWorkerLoop(input: {
  close(): Promise<void>;
  idleMilliseconds: number;
  processNext(): Promise<boolean>;
  signal: AbortSignal;
}): Promise<void> {
  try {
    while (!input.signal.aborted) {
      const processed = await input.processNext();
      if (processed || input.signal.aborted) continue;
      try {
        await sleep(input.idleMilliseconds, undefined, { signal: input.signal });
      } catch (error) {
        if (!input.signal.aborted) throw error;
      }
    }
  } finally {
    await input.close();
  }
}
