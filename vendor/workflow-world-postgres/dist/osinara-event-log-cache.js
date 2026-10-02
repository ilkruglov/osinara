/**
 * Per-run memory of a workflow event log that was already read in full.
 *
 * Exports:
 * - `eventLogCacheKey`: the run and resolve mode when this listing is the full ascending log.
 * - `readEventLogCache`, `writeEventLogCache`, `dropEventLogCache`: the cached log of one run.
 * - `traceEventLogRead`: one line per resume with how much of the log was reused.
 *
 * Key construct:
 * - `@workflow/core` rebuilds a run by listing its whole event log, and world-postgres answers with
 *   `select *`. A 43-turn Telegram session held 585 events carrying 9 MB of step inputs and hook
 *   payloads, re-read and re-parsed before every model call (10 сентября 2026: 0.22 s of queries
 *   and most of a 0.7 s CPU stall per turn).
 * - The log is append-only per run, so a cached prefix stays valid and only the tail is fetched.
 *   The caller compares the stored row count with the live one, which is what makes a shrunk or
 *   rewritten log fall back to a full read instead of serving a stale prefix.
 * - Both resolve modes are cached under separate keys, because the replay path asks for payloads
 *   and the recovery path asks for metadata only; mixing them would hand a caller the wrong shape.
 * - Payload-carrying logs are large, so the cache is bounded by estimated bytes and evicts the
 *   least recently read run. Every event and its retained binary backing storage are counted.
 * - Cached events are handed out by reference. `@workflow/core` only appends them to its own
 *   arrays and never writes into an event, which is what makes sharing safe.
 */

                                 
                                      
                                    
 

                                 
                         
                             
                            
                                
    
                         
 

                                             
                         
 

const MAX_CACHED_RUNS = 12;
const MAX_CACHED_BYTES = 64 * 1024 * 1024;
const MAX_ENTRY_BYTES = 24 * 1024 * 1024;

const cache = new Map                    ();
let cachedBytes = 0;

/** The cache key when this listing is exactly the full-log read, else null. */
export function eventLogCacheKey(
  params                       ,
  resolveData        ,
  sortOrder        ,
)                {
  if (sortOrder !== "asc") return null;
  if (params.pagination?.cursor !== undefined || params.pagination?.limit !== undefined) return null;
  if (typeof params.runId !== "string" || params.runId.length === 0) return null;
  return `${params.runId}\0${resolveData}`;
}

/** Conservative payload accounting, without JSON copies or expanding binary data into numbers. */
function estimateBytes(data                    )         {
  const seen = new WeakSet        ();
  let bytes = 0;
  let visited = 0;
  function count(value         , depth        )       {
    if (bytes > MAX_ENTRY_BYTES) return;
    // Pathological metadata is not worth caching; these guards bound traversal work and stack use.
    if (++visited > 1_000_000 || depth > 64) { bytes = Infinity; return; }
    if (typeof value === "string") { bytes += value.length * 2; return; }
    if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") {
      bytes += 8;
      return;
    }
    if (typeof value !== "object") { bytes = Infinity; return; }
    if (seen.has(value)) return;
    seen.add(value);
    bytes += 64;
    if (ArrayBuffer.isView(value)) {
      // A one-byte subarray retains the entire allocation. Count shared backing storage once.
      count(value.buffer, depth + 1);
    } else if (value instanceof ArrayBuffer || value instanceof SharedArrayBuffer) {
      bytes += value.byteLength;
    } else if (value instanceof Date) {
      bytes += 8;
    } else if (Array.isArray(value)) {
      bytes += value.length * 8;
      for (const item of value) {
        if (bytes > MAX_ENTRY_BYTES) break;
        count(item, depth + 1);
      }
    } else if (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) {
      for (const [key, item] of Object.entries(value)) {
        bytes += 16 + key.length * 2;
        count(item, depth + 1);
        if (bytes > MAX_ENTRY_BYTES) break;
      }
    } else {
      // Unknown retained representations must not silently bypass the byte budget.
      bytes = Infinity;
    }
  }
  try { count(data, 0); } catch { return Infinity; }
  return bytes;
}

function evictUntilWithinBounds()       {
  for (const [key, entry] of cache) {
    if (cache.size <= MAX_CACHED_RUNS && cachedBytes <= MAX_CACHED_BYTES) break;
    cache.delete(key);
    cachedBytes -= entry.bytes;
  }
}

export function readEventLogCache(key        )                             {
  const entry = cache.get(key);
  if (entry === undefined) return undefined;
  // Re-insert so the least recently resumed run is the one evicted.
  cache.delete(key);
  cache.set(key, entry);
  return entry;
}

export function writeEventLogCache(
  key        ,
  data                    ,
  cursor                    ,
)       {
  dropEventLogCache(key);
  const bytes = estimateBytes(data);
  // One enormous run must not push every other session out of the cache.
  if (bytes > MAX_ENTRY_BYTES) return;
  cache.set(key, { bytes, cursor, data: [...data] });
  cachedBytes += bytes;
  evictUntilWithinBounds();
}

export function dropEventLogCache(key        )       {
  const entry = cache.get(key);
  if (entry === undefined) return;
  cache.delete(key);
  cachedBytes -= entry.bytes;
}

/** One line per full-log read: how many events came from memory and how many from the database. */
export function traceEventLogRead(
  runId        ,
  reused        ,
  fetched        ,
  milliseconds        ,
  log                         = (line) => console.info(line),
)       {
  log(JSON.stringify({
    code: "AGENT_WORKFLOW_EVENT_LOG",
    fetched,
    ms: Math.round(milliseconds),
    reused,
    runId,
  }));
}
