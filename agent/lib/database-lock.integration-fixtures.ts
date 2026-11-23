/**
 * Lock helpers for race tests against PostgreSQL.
 *
 * Exports:
 * - `waitForLockWaiters`: resolves once that many sessions of this database wait on a lock.
 */
import { database } from "./database.js";

export async function waitForLockWaiters(count: number): Promise<void> {
  for (let poll = 0; poll < 500; poll += 1) {
    const waiting = await database().query<{ waiters: number }>(
      `SELECT count(*)::int AS waiters FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock'`,
    );
    if (waiting.rows[0]!.waiters >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${count} sessions never waited on a lock`);
}
