/**
 * The deploy's pause of new turns.
 *
 * Exports:
 * - `TURN_START_PAUSED_SQL`: the condition, inside the queries that claim work to start a turn.
 * - `TURN_START_LOCK_SQL`, `TURN_START_LOCK_KEY_SQL`: the lock a claim shares with the others and
 *   the controller takes alone while it sets the pause.
 *
 * Key construct:
 * - The deploy controller (`scripts/production-deploy/backup.sh`) sets the pause before it waits
 *   for the running turns and clears it once the release stopped. Meanwhile the ingress claims no
 *   update (the webhook still stores them) and the minute schedules start no scheduled run or
 *   memory review. The condition sits in the claim itself, read after the claim took the shared
 *   lock; the controller sets the pause under the lock taken alone, so a claim either sees the pause
 *   or committed before it, and the controller's wait counts such work until its run exists
 *   (`claimed_turn_work_sql` in `database.sh`; /code-review of 1.8.57–1.8.58: a claim still in its
 *   transaction was invisible to the wait). A pause the controller left behind ends at its own
 *   deadline.
 */
export const TURN_START_PAUSED_SQL =
  "EXISTS (SELECT 1 FROM deploy_turn_pause WHERE paused_until > now())";

/** The lock's key; `pause_new_turns` in `scripts/production-deploy/database.sh` uses the same. */
export const TURN_START_LOCK_KEY_SQL = "hashtextextended('osinara.turn_start', 0)";

/**
 * Taken first in a claim's transaction, before the statement that reads the pause: the controller
 * sets the pause under the same lock taken alone, so the pause commits only after every claim that
 * could have missed it, and the controller's first poll sees them all.
 */
export const TURN_START_LOCK_SQL = `SELECT pg_advisory_xact_lock_shared(${TURN_START_LOCK_KEY_SQL})`;
