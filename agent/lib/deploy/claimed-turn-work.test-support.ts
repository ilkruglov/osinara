/**
 * The deploy controller's list of claimed work that is not a Workflow run yet, for the tests of the
 * three claiming paths (ingress, agent schedules, memory review).
 *
 * Exports:
 * - `pauseBeingSet`: the controller's pause in the middle of its transaction (the lock taken alone,
 *   the pause written, nothing committed), for a claim that has to wait for it.
 * - `isClaimedTurnWork`: whether `claimed_turn_work_rows_sql` of
 *   `scripts/production-deploy/database.sh` lists this item; the SQL is read from the controller's
 *   script, never copied. One item is asked about, not the total: test files run side by side on
 *   one database, and the total counts their rows too.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { database } from "../database.js";
import { TURN_START_LOCK_KEY_SQL } from "./turn-start-pause.js";

const DATABASE_SCRIPT = fileURLToPath(
  new URL("../../../scripts/production-deploy/database.sh", import.meta.url),
);

export async function isClaimedTurnWork(
  kind: "ingress" | "memory_review" | "schedule",
  id: string,
): Promise<boolean> {
  const rows = execFileSync(
    "bash",
    ["-c", 'source "$1" && claimed_turn_work_rows_sql', "bash", DATABASE_SCRIPT],
    { encoding: "utf8" },
  );
  const result = await database().query(
    `SELECT 1 FROM (${rows}) AS claimed WHERE claimed.kind = $1 AND claimed.id = $2`,
    [kind, id],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function pauseBeingSet(): Promise<{ commit(): Promise<void> }> {
  const client = await database().connect();
  await client.query("BEGIN");
  await client.query(`SELECT pg_advisory_xact_lock(${TURN_START_LOCK_KEY_SQL})`);
  await client.query(
    `INSERT INTO deploy_turn_pause (singleton, paused_until) VALUES (true, now() + interval '15 minutes')
     ON CONFLICT (singleton) DO UPDATE SET paused_until = EXCLUDED.paused_until`,
  );
  return {
    async commit() {
      try {
        await client.query("COMMIT");
      } finally {
        client.release();
      }
    },
  };
}

/** Whether a promise is still pending after `milliseconds`. */
export async function stillPendingAfter(promise: Promise<unknown>, milliseconds: number) {
  let settled = false;
  void promise.then(
    () => (settled = true),
    () => (settled = true),
  );
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
  return !settled;
}
