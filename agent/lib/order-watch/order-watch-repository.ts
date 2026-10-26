/**
 * PostgreSQL boundary of order watches.
 *
 * Exports:
 * - `orderWatchRepository`: start, stop, claim the due ones, keep what was told, reschedule, release
 *   for a later tick, finish, check the person is still in the family, purge old finished ones.
 * - `ClaimedOrderWatch`, `OrderWatchRepository`, `OrderWatchFinishReason`.
 *
 * Key constructs:
 * - A watch is claimed under a lease; every later write names the lease token, so a tick that lost
 *   its lease (a crash, a slow browser) writes nothing (`AGENT_ORDER_WATCH_LEASE_STALE`).
 * - A watch whose private chat has a message waiting or a turn running is skipped: the turn may be
 *   using the same browser, and the watch must not take its tab away (the person may be typing an
 *   SMS code into it). It is looked at on a later tick.
 * - A person no longer in the family is not followed any more.
 */
import { AppError } from "../app-error.js";
import { database } from "../database.js";
import { ORDER_WATCH_DURATION_MS, ORDER_WATCH_RETENTION_DAYS, type OrderWatchService } from "./order-watch-config.js";
import type { OrderWatchState } from "./order-watch-status.js";

export type OrderWatchFinishReason = "deadline" | "failed" | "order_ended" | "stopped" | "unreachable";

export interface ClaimedOrderWatch {
  createdAt: Date;
  deadlineAt: Date;
  failures: number;
  familyId: string;
  id: string;
  lastState: OrderWatchState | null;
  leaseToken: string;
  orderId: string;
  sandboxSessionId: string;
  service: OrderWatchService;
  telegramChatId: string;
  userId: string;
}

interface ClaimedRow {
  created_at: Date;
  deadline_at: Date;
  failures: number;
  family_id: string;
  id: string;
  last_state: OrderWatchState | null;
  lease_token: string;
  order_id: string;
  sandbox_session_id: string;
  service: OrderWatchService;
  telegram_chat_id: string;
  user_id: string;
}

const staleLease = () => new AppError("AGENT_ORDER_WATCH_LEASE_STALE", "Слежение за заказом уже взял другой проход");

function requireLeased(rowCount: number | null): void {
  if ((rowCount ?? 0) !== 1) throw staleLease();
}

export const orderWatchRepository = {
  /** Starts watching, or keeps the watch already following this order. */
  async start(input: {
    familyId: string;
    initialState: OrderWatchState | null;
    now: Date;
    orderId: string;
    sandboxSessionId: string;
    service: OrderWatchService;
    telegramChatId: string;
    userId: string;
  }): Promise<{ created: boolean; id: string }> {
    const result = await database().query<{ created: boolean; id: string }>(
      `INSERT INTO order_watches
         (family_id, user_id, service, order_id, telegram_chat_id, sandbox_session_id, last_state,
          next_check_at, deadline_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $8::timestamptz + ($9 * interval '1 millisecond'))
       ON CONFLICT (user_id, service, order_id) WHERE status = 'active'
       DO UPDATE SET telegram_chat_id = EXCLUDED.telegram_chat_id,
                     sandbox_session_id = EXCLUDED.sandbox_session_id, updated_at = now()
       RETURNING id, (xmax = 0) AS created`,
      [input.familyId, input.userId, input.service, input.orderId, input.telegramChatId, input.sandboxSessionId,
        input.initialState === null ? null : JSON.stringify(input.initialState), input.now, ORDER_WATCH_DURATION_MS],
    );
    return result.rows[0]!;
  },

  /** Stops the person's watches of a service, or of one order of it. */
  async stop(input: { orderId?: string | undefined; service: OrderWatchService; userId: string }): Promise<number> {
    const result = await database().query(
      `UPDATE order_watches
          SET status = 'finished', finish_reason = 'stopped', finished_at = now(), updated_at = now(),
              lease_token = NULL, lease_expires_at = NULL
        WHERE status = 'active' AND user_id = $1 AND service = $2 AND ($3::text IS NULL OR order_id = $3)`,
      [input.userId, input.service, input.orderId ?? null],
    );
    return result.rowCount ?? 0;
  },

  async active(input: { service: OrderWatchService; userId: string }): Promise<string[]> {
    const result = await database().query<{ order_id: string }>(
      `SELECT order_id FROM order_watches WHERE status = 'active' AND user_id = $1 AND service = $2 ORDER BY created_at`,
      [input.userId, input.service],
    );
    return result.rows.map((row) => row.order_id);
  },

  async claimDue(options: { leaseMilliseconds: number; limit: number; now: Date }): Promise<ClaimedOrderWatch[]> {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE order_watches watch
            SET status = 'finished', finish_reason = 'stopped', finished_at = $1, updated_at = $1,
                lease_token = NULL, lease_expires_at = NULL
          WHERE watch.status = 'active'
            AND NOT EXISTS (SELECT 1 FROM family_memberships member
                             WHERE member.family_id = watch.family_id AND member.user_id = watch.user_id)`,
        [options.now],
      );
      const claimed = await client.query<ClaimedRow>(
        `WITH due AS (
           SELECT watch.id
             FROM order_watches watch
            WHERE watch.status = 'active' AND watch.next_check_at <= $1
              AND (watch.lease_expires_at IS NULL OR watch.lease_expires_at < $1)
              AND NOT EXISTS (
                SELECT 1 FROM telegram_ingress_updates item
                 WHERE item.status IN ('pending', 'processing')
                   AND coalesce(item.payload #>> '{message,chat,id}', item.payload #>> '{callback_query,message,chat,id}') = watch.telegram_chat_id
              )
            ORDER BY watch.next_check_at
            LIMIT $2
            FOR UPDATE SKIP LOCKED
         )
         UPDATE order_watches watch
            SET lease_token = gen_random_uuid(), lease_expires_at = $1::timestamptz + ($3 * interval '1 millisecond'),
                updated_at = $1
           FROM due
          WHERE watch.id = due.id
         RETURNING watch.id, watch.family_id, watch.user_id, watch.service, watch.order_id, watch.telegram_chat_id,
                   watch.sandbox_session_id, watch.last_state, watch.failures, watch.lease_token,
                   watch.created_at, watch.deadline_at`,
        [options.now, options.limit, options.leaseMilliseconds],
      );
      await client.query("COMMIT");
      return claimed.rows.map((row) => ({
        createdAt: row.created_at,
        deadlineAt: row.deadline_at,
        failures: row.failures,
        familyId: row.family_id,
        id: row.id,
        lastState: row.last_state,
        leaseToken: row.lease_token,
        orderId: row.order_id,
        sandboxSessionId: row.sandbox_session_id,
        service: row.service,
        telegramChatId: row.telegram_chat_id,
        userId: row.user_id,
      }));
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  /** Keeps what is about to be told while the lease is held: a crash after sending never repeats it. */
  async saveState(watch: ClaimedOrderWatch, state: OrderWatchState): Promise<void> {
    const result = await database().query(
      `UPDATE order_watches SET last_state = $3::jsonb, updated_at = now()
        WHERE id = $1 AND lease_token = $2 AND status = 'active'`,
      [watch.id, watch.leaseToken, JSON.stringify(state)],
    );
    requireLeased(result.rowCount);
  },

  async reschedule(watch: ClaimedOrderWatch, input: {
    errorCode: string | null;
    nextCheckAt: Date;
    state: OrderWatchState | null;
  }): Promise<void> {
    // A failed check counts towards giving up; a successful one starts the count again. A null state
    // leaves what was kept as it is.
    const result = await database().query(
      `UPDATE order_watches
          SET last_state = coalesce($3::jsonb, last_state), next_check_at = $4,
              failures = CASE WHEN $5::text IS NULL THEN 0 ELSE failures + 1 END,
              last_error_code = $5, lease_token = NULL, lease_expires_at = NULL, updated_at = now()
        WHERE id = $1 AND lease_token = $2 AND status = 'active'`,
      [watch.id, watch.leaseToken, input.state === null ? null : JSON.stringify(input.state), input.nextCheckAt, input.errorCode],
    );
    requireLeased(result.rowCount);
  },

  /** Gives the watch back untouched: the next tick takes it again. */
  async release(watch: ClaimedOrderWatch): Promise<void> {
    const result = await database().query(
      `UPDATE order_watches SET lease_token = NULL, lease_expires_at = NULL, updated_at = now()
        WHERE id = $1 AND lease_token = $2 AND status = 'active'`,
      [watch.id, watch.leaseToken],
    );
    requireLeased(result.rowCount);
  },

  async isMember(watch: Pick<ClaimedOrderWatch, "familyId" | "userId">): Promise<boolean> {
    const result = await database().query(
      "SELECT 1 FROM family_memberships WHERE family_id = $1 AND user_id = $2", [watch.familyId, watch.userId],
    );
    return (result.rowCount ?? 0) > 0;
  },

  async finish(watch: ClaimedOrderWatch, input: {
    errorCode: string | null;
    reason: OrderWatchFinishReason;
    state: OrderWatchState | null;
  }): Promise<void> {
    const result = await database().query(
      `UPDATE order_watches
          SET status = 'finished', finish_reason = $3, finished_at = now(), last_state = coalesce($4::jsonb, last_state),
              last_error_code = $5, lease_token = NULL, lease_expires_at = NULL, updated_at = now()
        WHERE id = $1 AND lease_token = $2 AND status = 'active'`,
      [watch.id, watch.leaseToken, input.reason, input.state === null ? null : JSON.stringify(input.state), input.errorCode],
    );
    requireLeased(result.rowCount);
  },

  async purgeFinished(now: Date): Promise<number> {
    const result = await database().query(
      `DELETE FROM order_watches
        WHERE status = 'finished' AND finished_at < $1::timestamptz - ($2 * interval '1 day')`,
      [now, ORDER_WATCH_RETENTION_DAYS],
    );
    return result.rowCount ?? 0;
  },
};

export type OrderWatchRepository = typeof orderWatchRepository;
