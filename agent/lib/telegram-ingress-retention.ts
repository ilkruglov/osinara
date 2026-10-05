/**
 * Retention of the durable Telegram ingress queue.
 *
 * Export:
 * - `purgeCompletedTelegramUpdates`: deletes completed updates older than the retention window,
 *   one bounded batch per call.
 *
 * Key construct:
 * - Every update was kept forever with its full raw payload, including messages of people who
 *   are not family members (security review, 5 October 2026: 26 625 rows since 2 September).
 *   Deduplication by `update_id` needs a row only while Telegram may redeliver it (24 hours), so
 *   a completed update older than the window is only data. Failed updates are kept: they are
 *   what the owner's digest and a diagnosis read. Interjection rows go with their update by
 *   cascade.
 */
import { TELEGRAM_INGRESS_PURGE_BATCH_SIZE, TELEGRAM_INGRESS_RETENTION_DAYS } from "../config.js";
import { database } from "./database.js";

export async function purgeCompletedTelegramUpdates(
  now: Date,
  batchSize: number = TELEGRAM_INGRESS_PURGE_BATCH_SIZE,
): Promise<number> {
  const result = await database().query(
    `WITH expired AS (
       SELECT update_id
         FROM telegram_ingress_updates
        WHERE status = 'completed'
          AND completed_at <= $1::timestamptz - ($2::integer * interval '1 day')
        ORDER BY completed_at
        LIMIT $3::integer
        FOR UPDATE SKIP LOCKED
     )
     DELETE FROM telegram_ingress_updates update_row
      USING expired
      WHERE update_row.update_id = expired.update_id`,
    [now, TELEGRAM_INGRESS_RETENTION_DAYS, batchSize],
  );
  const deletedCount = result.rowCount ?? 0;
  if (deletedCount > 0) {
    console.info(JSON.stringify({
      batchLimitReached: deletedCount === batchSize,
      code: "AGENT_TELEGRAM_INGRESS_PURGE_COMPLETED",
      deletedCount,
    }));
  }
  return deletedCount;
}
