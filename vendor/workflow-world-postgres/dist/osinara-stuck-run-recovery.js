/**
 * Re-enqueues Workflow runs whose next step lost its queue job.
 *
 * Exports:
 * - `STUCK_RETRY_AFTER_MS`, `STUCK_STEP_STARTED_AFTER_MS`, `STUCK_RUN_SCAN_INTERVAL_MS`: limits.
 * - `findStuckRuns`: active runs whose last event is a retry nobody picked up, or a step start far
 *   older than any step may run.
 * - `startStuckRunRecovery`: scans on an interval and enqueues each found run the way the world's
 *   own startup recovery did; returns a stop function.
 * - `findInFlightRuns`, `requeueInFlightRuns`: startup recovery of the runs interrupted mid-flight
 *   only; parked sessions and sleeps are left to the events that wake them.
 *
 * Key construct:
 * - On 1 October 2026 a turn step recorded `step_retrying`, but the follow-up job that should have
 *   run it again was written to a closed HTTP connection and never existed. Workflow's own backstop
 *   skips steps that already retried, so the run stayed pending and the private chat was silent
 *   for 8.5 hours, until a restart re-enqueued every active run. This scan does the same for the
 *   runs that need it, without a restart. Replay is idempotent, so a duplicate enqueue is safe.
 * - Runs that wait on a hook, a sleep or a parked session end on other events and are never touched.
 */

export const STUCK_RETRY_AFTER_MS = 10 * 60 * 1000;
export const STUCK_STEP_STARTED_AFTER_MS = 25 * 60 * 1000;
export const STUCK_RUN_SCAN_INTERVAL_MS = 5 * 60 * 1000;

                         
                                                                                            
 

                           
                    
                
                       
 

export async function findStuckRuns(
  pool               ,
  limits                                                       = {
    retryAfterMs: STUCK_RETRY_AFTER_MS,
    stepStartedAfterMs: STUCK_STEP_STARTED_AFTER_MS,
  },
)                      {
  // Event times are stored without a zone in the session's local time, hence LOCALTIMESTAMP.
  const result = await pool.query(
    `SELECT r.id AS run_id, r.name AS workflow_name, last.type AS last_event
       FROM workflow.workflow_runs r
       JOIN LATERAL (
         SELECT e.type, e.created_at FROM workflow.workflow_events e
          WHERE e.run_id = r.id
          ORDER BY e.created_at DESC, e.id DESC
          LIMIT 1
       ) last ON true
      WHERE r.status IN ('pending', 'running')
        AND ((last.type = 'step_retrying' AND last.created_at < LOCALTIMESTAMP - make_interval(secs => $1::double precision))
          OR (last.type = 'step_started' AND last.created_at < LOCALTIMESTAMP - make_interval(secs => $2::double precision)))
      ORDER BY last.created_at
      LIMIT 50`,
    [limits.retryAfterMs / 1000, limits.stepStartedAfterMs / 1000],
  );
  return result.rows.flatMap((row) =>
    typeof row.run_id === "string" && typeof row.workflow_name === "string" && typeof row.last_event === "string"
      ? [{ lastEvent: row.last_event, runId: row.run_id, workflowName: row.workflow_name }]
      : []);
}

/** Last events of a run that ends on another event: a parked session's hook, a sleep's timer. */
const PARKED_LAST_EVENTS = ["hook_created", "wait_created"];

/**
 * Active runs whose last event leaves the next action to this process: a run interrupted while a
 * step ran, between steps, or right after creation. Parked runs are not included, whatever their
 * age. Pages by run id so a large installation is read in bounded chunks.
 */
export async function findInFlightRuns(pool               , pageSize = 500)                      {
  const found             = [];
  let after = "";
  while (true) {
    const result = await pool.query(
      `SELECT r.id AS run_id, r.name AS workflow_name, last.type AS last_event
         FROM workflow.workflow_runs r
         JOIN LATERAL (
           SELECT e.type FROM workflow.workflow_events e
            WHERE e.run_id = r.id
            ORDER BY e.created_at DESC, e.id DESC
            LIMIT 1
         ) last ON true
        WHERE r.status IN ('pending', 'running') AND r.id > $1
          AND last.type <> ALL($2::text[])
        ORDER BY r.id
        LIMIT $3`,
      [after, PARKED_LAST_EVENTS, pageSize],
    );
    for (const row of result.rows) {
      if (typeof row.run_id !== "string" || typeof row.workflow_name !== "string" || typeof row.last_event !== "string") continue;
      found.push({ lastEvent: row.last_event, runId: row.run_id, workflowName: row.workflow_name });
      after = row.run_id;
    }
    if (result.rows.length < pageSize) return found;
  }
}

/**
 * Startup recovery: enqueues the in-flight runs and nothing else. Replaces the world's own
 * `reenqueueActiveRuns`, which replayed every active run, parked sessions included, on each start
 * (79 runs on production, 4 October 2026, growing with the number of chats).
 */
export async function requeueInFlightRuns(input   
                                                                               
                      
                      
 )                  {
  const runs = await findInFlightRuns(input.pool);
  for (const run of runs) {
    await input.enqueue(`${input.queuePrefix}${run.workflowName}`, { runId: run.runId });
  }
  if (runs.length > 0) {
    console.info(JSON.stringify({ code: "AGENT_WORKFLOW_INFLIGHT_RUNS_REQUEUED", count: runs.length }));
  }
  return runs.length;
}

export function startStuckRunRecovery(input   
                                                                               
                      
                      
                      
 )             {
  let running = false;
  const scan = async () => {
    if (running) return;
    running = true;
    try {
      for (const run of await findStuckRuns(input.pool)) {
        await input.enqueue(`${input.queuePrefix}${run.workflowName}`, { runId: run.runId });
        console.warn(JSON.stringify({ code: "AGENT_WORKFLOW_STUCK_RUN_REQUEUED", lastEvent: run.lastEvent, runId: run.runId }));
      }
    } catch (error) {
      console.error(JSON.stringify({
        code: "AGENT_WORKFLOW_STUCK_RUN_SCAN_FAILED",
        error: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void scan(), input.intervalMs ?? STUCK_RUN_SCAN_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
