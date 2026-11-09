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
 * - `releaseDeadWorkerLocks`: startup release of queue jobs still locked by processes that died.
 *
 * Key construct:
 * - On 1 October 2026 a turn step recorded `step_retrying`, but the follow-up job that should have
 *   run it again was written to a closed HTTP connection and never existed. Workflow's own backstop
 *   skips steps that already retried, so the run stayed pending and the private chat was silent
 *   for 8.5 hours, until a restart re-enqueued every active run. This scan does the same for the
 *   runs that need it, without a restart. Replay is idempotent, so a duplicate enqueue is safe.
 * - Runs that wait on a hook, a sleep or a parked session end on other events and are never touched.
 *   A turn cannot be told apart that way (its inbox hook lives from its start), so a turn found again
 *   in the state its replay left it in is skipped for an hour (`STUCK_REQUEUE_REPEAT_AFTER_MS`).
 */

export const STUCK_RETRY_AFTER_MS = 10 * 60 * 1000;
export const STUCK_STEP_STARTED_AFTER_MS = 25 * 60 * 1000;
/**
 * A run whose last event is step_completed is either a session resting on a hook created turns
 * ago or a run whose next step's queue job was lost. The hook row is the evidence for a session:
 * a resting session holds one, an abandoned continuation does not. A turn is different: it creates
 * its inbox hook before its first step and keeps it to the end (Eve `turnWorkflow`), so for a turn
 * a hook proves nothing and an old completed step means a lost continuation (Codex review,
 * 6 November 2026). Re-enqueuing a turn that only waits (an approval, a child) replays it to the
 * same wait, which is safe.
 */
export const STUCK_STEP_COMPLETED_AFTER_MS = 25 * 60 * 1000;
export const TURN_WORKFLOW_NAME = "workflow//eve//turnWorkflow";
export const STUCK_RUN_SCAN_INTERVAL_MS = 5 * 60 * 1000;

                         
                                                                                            
 

                           
                    
                                                                                               
                       
                
                       
 

/**
 * A run found again with the same last event after its replay only waits: an approval or a child
 * writes nothing while it waits, and a replay of such a turn returns to the same wait (/code-review
 * of 1.8.57–1.8.58: every pass replayed it, reading its whole event log). It is replayed once per
 * state, and again after this long in case the requeued job itself was lost.
 */
export const STUCK_REQUEUE_REPEAT_AFTER_MS = 60 * 60 * 1000;

export async function findStuckRuns(
  pool               ,
  limits                                                       = {
    retryAfterMs: STUCK_RETRY_AFTER_MS,
    stepStartedAfterMs: STUCK_STEP_STARTED_AFTER_MS,
  },
  /** Runs left out while their last event is still this one: a replay left them waiting. */
  skip                                                    = [],
)                      {
  // Event times are stored without a zone in the session's local time, hence LOCALTIMESTAMP.
  const result = await pool.query(
    `SELECT r.id AS run_id, r.name AS workflow_name, last.type AS last_event, last.id AS last_event_id
       FROM workflow.workflow_runs r
       JOIN LATERAL (
         SELECT e.id, e.type, e.created_at FROM workflow.workflow_events e
          WHERE e.run_id = r.id
          ORDER BY e.created_at DESC, e.id DESC
          LIMIT 1
       ) last ON true
      WHERE r.status IN ('pending', 'running')
        AND ((last.type = 'step_retrying' AND last.created_at < LOCALTIMESTAMP - make_interval(secs => $1::double precision))
          OR (last.type = 'step_started' AND last.created_at < LOCALTIMESTAMP - make_interval(secs => $2::double precision))
          OR (last.type = 'step_completed' AND last.created_at < LOCALTIMESTAMP - make_interval(secs => $3::double precision)
              AND (r.name = $4 OR NOT EXISTS (SELECT 1 FROM workflow.workflow_hooks h WHERE h.run_id = r.id))))
        -- Left out here, not after the limit, so waiting runs take no place from stuck ones.
        AND NOT EXISTS (SELECT 1 FROM unnest($5::text[], $6::text[]) AS skip(run_id, event_id)
                         WHERE skip.run_id = r.id AND skip.event_id = last.id)
      ORDER BY last.created_at
      LIMIT 50`,
    [
      limits.retryAfterMs / 1000,
      limits.stepStartedAfterMs / 1000,
      STUCK_STEP_COMPLETED_AFTER_MS / 1000,
      TURN_WORKFLOW_NAME,
      skip.map((run) => run.runId),
      skip.map((run) => run.lastEventId),
    ],
  );
  return result.rows.flatMap((row) =>
    typeof row.run_id === "string" &&
    typeof row.workflow_name === "string" &&
    typeof row.last_event === "string"
      ? [
          {
            lastEvent: row.last_event,
            ...(typeof row.last_event_id === "string" ? { lastEventId: row.last_event_id } : {}),
            runId: row.run_id,
            workflowName: row.workflow_name,
          },
        ]
      : [],
  );
}

/** Last events of a run that ends on another event: a parked session's hook, a sleep's timer. */
const PARKED_LAST_EVENTS = ["hook_created", "wait_created"];
/**
 * A session that waits on a hook created turns ago ends its last turn on step_completed, like a
 * run interrupted between steps. The two are told apart by age: a process restarts within
 * minutes, so a completed step older than this has nothing in flight behind it (the deploy's
 * own wait for turns uses the same window).
 */
export const INFLIGHT_COMPLETED_STEP_WITHIN_MS = 10 * 60 * 1000;

/**
 * Active runs whose last event leaves the next action to this process: a run interrupted while a
 * step ran, right after creation, or between steps, where "between steps" is a completed step
 * younger than the window, a turn (whose inbox hook proves nothing), or a run with no hook to wake
 * it (a session resting on its hook is left alone). Pages by run id so a large installation is read
 * in bounded chunks.
 */
export async function findInFlightRuns(pool               , pageSize = 500)                      {
  const found             = [];
  let after = "";
  while (true) {
    const result = await pool.query(
      `SELECT r.id AS run_id, r.name AS workflow_name, last.type AS last_event
         FROM workflow.workflow_runs r
         JOIN LATERAL (
           SELECT e.type, e.created_at FROM workflow.workflow_events e
            WHERE e.run_id = r.id
            ORDER BY e.created_at DESC, e.id DESC
            LIMIT 1
         ) last ON true
        WHERE r.status IN ('pending', 'running') AND r.id > $1
          AND last.type <> ALL($2::text[])
          AND (last.type <> 'step_completed'
               OR last.created_at > LOCALTIMESTAMP - make_interval(secs => $4::double precision)
               OR r.name = $5
               OR NOT EXISTS (SELECT 1 FROM workflow.workflow_hooks h WHERE h.run_id = r.id))
        ORDER BY r.id
        LIMIT $3`,
      [
        after,
        PARKED_LAST_EVENTS,
        pageSize,
        INFLIGHT_COMPLETED_STEP_WITHIN_MS / 1000,
        TURN_WORKFLOW_NAME,
      ],
    );
    for (const row of result.rows) {
      if (
        typeof row.run_id !== "string" ||
        typeof row.workflow_name !== "string" ||
        typeof row.last_event !== "string"
      )
        continue;
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
    console.info(
      JSON.stringify({ code: "AGENT_WORKFLOW_INFLIGHT_RUNS_REQUEUED", count: runs.length }),
    );
  }
  return runs.length;
}

/**
 * Releases the queue jobs and job queues locked by workers that started before this process.
 *
 * A worker locks a job while running it; graphile-worker frees a lock only after four hours, so a
 * process killed mid-step (a restart, a crash, an OOM, a deploy that stopped waiting) left its turn
 * and every later message of that chat waiting: Ft86 was silent from 14:31 on 5 October 2026 until
 * the lock was freed by hand. The installation runs one agent process, so every lock older than
 * this process belongs to a dead one. With several replicas this would steal live jobs; it must
 * then become a heartbeat check.
 */
export async function releaseDeadWorkerLocks(
  pool               ,
  startedAt      ,
)                  {
  const result = await pool.query(
    `WITH dead AS (
       SELECT DISTINCT locked_by FROM graphile_worker._private_jobs
        WHERE locked_by IS NOT NULL AND locked_at < $1
       UNION
       SELECT DISTINCT locked_by FROM graphile_worker._private_job_queues
        WHERE locked_by IS NOT NULL AND locked_at < $1
     ), released AS (
       SELECT graphile_worker.force_unlock_workers(ARRAY(SELECT locked_by FROM dead))
     )
     SELECT (SELECT count(*) FROM dead) AS workers FROM released`,
    [startedAt],
  );
  const workers = Number(result.rows[0]?.workers ?? 0);
  if (workers > 0) {
    console.warn(JSON.stringify({ code: "AGENT_WORKFLOW_DEAD_WORKER_LOCKS_RELEASED", workers }));
  }
  return workers;
}

export function startStuckRunRecovery(input   
                                                                               
                      
                     
                      
                      
 )             {
  const now = input.now ?? Date.now;
  let running = false;
  /** Runs this process requeued within the hour: the last event they had then and when. */
  const requeued = new Map                                             ();
  const scan = async () => {
    if (running) return;
    running = true;
    try {
      for (const [runId, entry] of requeued) {
        if (now() - entry.at >= STUCK_REQUEUE_REPEAT_AFTER_MS) requeued.delete(runId);
      }
      const skip = [...requeued].map(([runId, entry]) => ({
        lastEventId: entry.lastEventId,
        runId,
      }));
      for (const run of await findStuckRuns(input.pool, undefined, skip)) {
        await input.enqueue(`${input.queuePrefix}${run.workflowName}`, { runId: run.runId });
        // Only a turn after a completed step may just be waiting (an approval, a child); any other
        // run whose requeued job was lost again goes once more next pass (1 October 2026).
        // Remembered at once: a later enqueue of this pass may throw.
        if (
          run.workflowName === TURN_WORKFLOW_NAME &&
          run.lastEvent === "step_completed" &&
          run.lastEventId !== undefined
        )
          requeued.set(run.runId, { at: now(), lastEventId: run.lastEventId });
        console.warn(
          JSON.stringify({
            code: "AGENT_WORKFLOW_STUCK_RUN_REQUEUED",
            lastEvent: run.lastEvent,
            runId: run.runId,
          }),
        );
      }
    } catch (error) {
      console.error(
        JSON.stringify({
          code: "AGENT_WORKFLOW_STUCK_RUN_SCAN_FAILED",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void scan(), input.intervalMs ?? STUCK_RUN_SCAN_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
