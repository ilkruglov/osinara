/**
 * Release of Workflow queue jobs whose run no longer exists.
 *
 * Exports:
 * - `releaseOrphanWorkflowJobs`: completes orphan Graphile jobs in one bounded page via a client.
 *
 * Key constructs:
 * - Run retention (`workflow-run-retention.ts`) and session deletion
 *   (`workflow-postgres-session-storage.ts`) remove a run with its projections, but a queue message
 *   for it may still wait in Graphile: a delayed session timeout or a delivery that kept failing.
 *   The runtime answers such a message with 500 WorkflowRunNotFoundError and Graphile retries it
 *   up to 49 times over days; an exhausted job stays in the table for good. On 6 October 2026
 *   production held 12 such jobs: 4 still retrying, 8 exhausted with «fetch failed».
 * - One sweep after the deletions covers both paths and any race between them, instead of each
 *   deletion hunting its own messages.
 * - The run id lives only inside the base64 queue body (`payload->>'data'`), so the job is read
 *   from `_private_jobs`: the public `jobs` view carries no payload. Removal goes through the
 *   public `complete_jobs`.
 * - A sweep reads one page of up to 1 000 jobs after a cursor and returns the next cursor, back to
 *   the start after a short page: delayed session timeouts of live runs alone could fill a fixed
 *   first page and hide every orphan behind it.
 * - Kept: jobs younger than the grace period (the run row may not be committed yet), a first
 *   delivery with `runInput` (the consumer creates the run from it), and bodies without a run id.
 */
const ORPHAN_JOB_GRACE_MINUTES = 10;
const ORPHAN_JOB_SCAN_LIMIT = 1000;

interface WorkflowQueryClient {
  query(text: string, values?: readonly unknown[]): Promise<{ rowCount: number | null; rows: Array<Record<string, unknown>> }>;
}

function orphanCandidateRunId(data: unknown): string | undefined {
  if (typeof data !== "string") return undefined;
  try {
    const body: unknown = JSON.parse(Buffer.from(data, "base64").toString("utf8"));
    if (typeof body !== "object" || body === null || "runInput" in body) return undefined;
    const runId = (body as { runId?: unknown }).runId;
    return typeof runId === "string" && runId.length > 0 ? runId : undefined;
  } catch {
    return undefined;
  }
}

export async function releaseOrphanWorkflowJobs(
  client: WorkflowQueryClient,
  options: { afterId?: string; limit?: number } = {},
): Promise<{ released: number; nextAfterId: string }> {
  const limit = options.limit ?? ORPHAN_JOB_SCAN_LIMIT;
  const jobs = await client.query(
    // `ORDER BY j.id`, not the output alias: `id` there is the text column and would sort
    // "1999" after "10000" while the cursor compares numbers (Codex review).
    `SELECT j.id::text AS id, j.payload->>'data' AS data
       FROM graphile_worker._private_jobs AS j
      WHERE j.created_at < now() - make_interval(mins => $1::int)
        AND j.id > $2::bigint
      ORDER BY j.id
      LIMIT $3::int`,
    [ORPHAN_JOB_GRACE_MINUTES, options.afterId ?? "0", limit],
  );
  const lastId = jobs.rows.at(-1)?.id;
  const nextAfterId = jobs.rows.length === limit && typeof lastId === "string" ? lastId : "0";
  const runIdByJob = new Map<string, string>();
  for (const row of jobs.rows) {
    const runId = orphanCandidateRunId(row.data);
    if (typeof row.id === "string" && runId) runIdByJob.set(row.id, runId);
  }
  if (runIdByJob.size === 0) return { released: 0, nextAfterId };

  const runIds = [...new Set(runIdByJob.values())].sort();
  const live = await client.query("SELECT id::text AS id FROM workflow.workflow_runs WHERE id = ANY($1::text[])", [runIds]);
  const liveRunIds = new Set(live.rows.map((row) => row.id));
  const orphanJobIds = [...runIdByJob].filter(([, runId]) => !liveRunIds.has(runId)).map(([jobId]) => jobId);
  if (orphanJobIds.length === 0) return { released: 0, nextAfterId };

  const completed = await client.query("SELECT id FROM graphile_worker.complete_jobs($1::bigint[])", [orphanJobIds]);
  const released = completed.rowCount ?? 0;
  console.info(JSON.stringify({ code: "AGENT_WORKFLOW_ORPHAN_JOBS_RELEASED", released }));
  return { released, nextAfterId };
}
