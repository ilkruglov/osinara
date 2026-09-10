/**
 * Per-run memory of a workflow event log that was already read in full.
 *
 * Exports:
 * - `eventLogCacheKey`: the run id when this listing is the full ascending log without payloads.
 * - `readEventLogCache`, `writeEventLogCache`, `dropEventLogCache`: the cached log of one run.
 * - `traceEventLogRead`: one line per resume with how much of the log was reused.
 *
 * Key construct:
 * - `@workflow/core` resumes a parked run by listing every event of that run, and world-postgres
 *   answers with `select *`. A 43-turn Telegram session held 585 events carrying 9 MB of step
 *   inputs and hook payloads, so every message re-read and re-parsed all of it before the model was
 *   called (10 сентября 2026: 0.22 s of query time and most of a 0.7 s CPU stall per turn).
 * - The log is append-only per run, so a cached prefix stays valid and only the tail is fetched.
 *   The caller compares the stored row count with the live one, which is what makes a shrunk or
 *   rewritten log fall back to a full read instead of serving a stale prefix.
 * - Only payload-free ascending full listings qualify. A caller that asked for payloads, a page or
 *   a reverse order gets the untouched query, so no consumer can observe a different result.
 */

export interface CachedEventLog {
  readonly cursor: string | undefined;
  readonly data: readonly unknown[];
}

interface EventLogListingParams {
  readonly pagination?: {
    readonly cursor?: string;
    readonly limit?: number;
    readonly sortOrder?: string;
  };
  readonly runId: string;
}

const MAX_CACHED_RUNS = 24;
const cache = new Map<string, CachedEventLog>();

/** The run id when this listing is exactly the resume read, else null. */
export function eventLogCacheKey(
  params: EventLogListingParams,
  resolveData: string,
  sortOrder: string,
): string | null {
  if (resolveData !== "none" || sortOrder !== "asc") return null;
  if (params.pagination?.cursor !== undefined || params.pagination?.limit !== undefined) return null;
  return typeof params.runId === "string" && params.runId.length > 0 ? params.runId : null;
}

export function readEventLogCache(key: string): CachedEventLog | undefined {
  const entry = cache.get(key);
  if (entry === undefined) return undefined;
  // Re-insert so the least recently resumed run is the one evicted.
  cache.delete(key);
  cache.set(key, entry);
  return entry;
}

export function writeEventLogCache(
  key: string,
  data: readonly unknown[],
  cursor: string | undefined,
): void {
  cache.delete(key);
  cache.set(key, { cursor, data: [...data] });
  for (const stale of cache.keys()) {
    if (cache.size <= MAX_CACHED_RUNS) break;
    cache.delete(stale);
  }
}

export function dropEventLogCache(key: string): void {
  cache.delete(key);
}

/** One line per resume read: how many events came from memory and how many from the database. */
export function traceEventLogRead(
  runId: string,
  reused: number,
  fetched: number,
  milliseconds: number,
  log: (line: string) => void = (line) => console.info(line),
): void {
  log(JSON.stringify({
    code: "AGENT_WORKFLOW_EVENT_LOG",
    fetched,
    ms: Math.round(milliseconds),
    reused,
    runId,
  }));
}
