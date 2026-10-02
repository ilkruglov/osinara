/**
 * Slow-query trace for the workflow PostgreSQL pool.
 *
 * Export:
 * - `traceWorkflowPool`: wraps a pool in place so a query over the threshold reports itself.
 *
 * Key construct:
 * - The workflow driver was the blind spot in reply latency: the only way to see that resuming a
 *   run read its whole event log was to switch production statement logging on and wait for a live
 *   message (10 сентября 2026). Wrapping the one pool covers storage, queue and streamer at once.
 * - Only the statement shape is logged, never parameter values: they carry run payloads, which
 *   hold the turn context of a family chat.
 */

const TRACED = Symbol.for("osinara.workflowPoolTrace");
const STATEMENT_LOG_LIMIT = 120;
const SLOW_QUERY_MS = 150;

                      
                                         
 

                                            
                                           
 

function statementShape(query         )         {
  const text = typeof query === "string"
    ? query
    : typeof (query                             )?.text === "string"
      ? (query                    ).text
      : "";
  return text.replace(/\s+/gu, " ").trim().slice(0, STATEMENT_LOG_LIMIT);
}

function rowCount(result         )                {
  const rows = (result                             )?.rows;
  return Array.isArray(rows) ? rows.length : null;
}

function wrapQuery(owner            , thresholdMs        , log                        )       {
  const original = owner.query.bind(owner);
  owner.query = (...args           ) => {
    const startedAt = performance.now();
    const observe = (result         )       => {
      const ms = performance.now() - startedAt;
      if (ms < thresholdMs) return;
      log(JSON.stringify({
        code: "AGENT_WORKFLOW_SLOW_QUERY",
        ms: Math.round(ms),
        rows: rowCount(result),
        statement: statementShape(args[0]),
      }));
    };
    const outcome = original(...args);
    // The callback form has no promise to observe; the pool contract keeps both.
    if (typeof (outcome                             )?.then !== "function") return outcome;
    return (outcome                    ).then((result) => {
      observe(result);
      return result;
    }, (error         ) => {
      observe(null);
      throw error;
    });
  };
}

/** Wraps the pool and every client it hands out; wrapping twice is a no-op. */
export function traceWorkflowPool(
  pool               ,
  thresholdMs         = SLOW_QUERY_MS,
  log                         = (line) => console.warn(line),
)                {
  const traced = pool                                       ;
  if (traced[TRACED] === true) return pool;
  traced[TRACED] = true;
  wrapQuery(pool, thresholdMs, log);
  const connect = pool.connect.bind(pool);
  pool.connect = (...args           ) => {
    const outcome = connect(...args);
    if (typeof (outcome                             )?.then !== "function") return outcome;
    return (outcome                    ).then((client) => {
      const tracedClient = client                                    ;
      if (tracedClient !== null && typeof tracedClient?.query === "function" && tracedClient[TRACED] !== true) {
        tracedClient[TRACED] = true;
        wrapQuery(tracedClient, thresholdMs, log);
      }
      return client;
    });
  };
  return pool;
}
