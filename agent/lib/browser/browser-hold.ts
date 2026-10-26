/**
 * Who drives a person's browser: a turn, or a background check holding it for a moment.
 *
 * Export:
 * - `browserHoldRepository`: `enterAsTurn` (every turn command), `tryHold`, `holdsStill` and
 *   `release` (a background check such as an order watch).
 *
 * Key constructs:
 * - One row per sandbox, written by both sides with an upsert on its key, so PostgreSQL serializes
 *   them: a turn command marks the browser as used by a turn for `TURN_MARK_MS` and waits while a
 *   live background hold is there; a background check takes the row only when it is free or expired
 *   and the chat has no message waiting. Reading instead of writing left a window where both started
 *   (Codex review, 26 October 2026).
 * - A turn without a queued message (a button press, a scheduled run) is covered by the same mark.
 * - A crashed check's hold expires; the check itself verifies it still holds the browser before each
 *   command (`holdsStill`), so it never acts after its hold ran out.
 */
import { database } from "../database.js";

/** A turn's browser work keeps background checks away for this long after its last command. */
const TURN_MARK_MS = 2 * 60_000;
const POLL_MS = 500;

export const browserHoldRepository = {
  /** Marks the browser as used by a turn, waiting while a background check holds it. */
  async enterAsTurn(sandboxSessionId: string, signal?: AbortSignal): Promise<void> {
    while (true) {
      signal?.throwIfAborted();
      const entered = await database().query<{ entered: boolean; left_ms: number | null }>(
        `WITH marked AS (
           INSERT INTO sandbox_browser_holds (sandbox_session_id, holder, kind, expires_at)
           VALUES ($1, gen_random_uuid(), 'turn', now() + ($2 * interval '1 millisecond'))
           ON CONFLICT (sandbox_session_id) DO UPDATE
             SET holder = EXCLUDED.holder, kind = 'turn', expires_at = EXCLUDED.expires_at
             WHERE sandbox_browser_holds.kind = 'turn' OR sandbox_browser_holds.expires_at <= now()
           RETURNING 1
         )
         SELECT EXISTS (SELECT 1 FROM marked) AS entered,
                (SELECT ceil(extract(epoch FROM expires_at - now()) * 1000)::float8
                   FROM sandbox_browser_holds WHERE sandbox_session_id = $1) AS left_ms`,
        [sandboxSessionId, TURN_MARK_MS],
      );
      if (entered.rows[0]?.entered) return;
      // The hold may be newer than this statement's snapshot: then its expiry is unknown here.
      const left = entered.rows[0]?.left_ms ?? POLL_MS;
      await new Promise((resolve) => setTimeout(resolve, Math.min(POLL_MS, Math.max(1, left))));
    }
  },

  /** Takes the browser for a background check only when no turn uses it and the chat is idle. */
  async tryHold(input: { holder: string; idleChatId: string; sandboxSessionId: string; ttlMs: number }): Promise<boolean> {
    const result = await database().query(
      `INSERT INTO sandbox_browser_holds (sandbox_session_id, holder, kind, expires_at)
       SELECT $1, $2::uuid, 'background', now() + ($3 * interval '1 millisecond')
        WHERE NOT EXISTS (
          SELECT 1 FROM telegram_ingress_updates item
           WHERE item.status IN ('pending', 'processing')
             AND coalesce(item.payload #>> '{message,chat,id}', item.payload #>> '{callback_query,message,chat,id}') = $4
        )
       ON CONFLICT (sandbox_session_id) DO UPDATE
         SET holder = EXCLUDED.holder, kind = 'background', expires_at = EXCLUDED.expires_at
         WHERE sandbox_browser_holds.expires_at <= now()
       RETURNING holder`,
      [input.sandboxSessionId, input.holder, input.ttlMs, input.idleChatId],
    );
    return (result.rowCount ?? 0) === 1;
  },

  async holdsStill(input: { holder: string; sandboxSessionId: string }): Promise<boolean> {
    const result = await database().query(
      "SELECT 1 FROM sandbox_browser_holds WHERE sandbox_session_id = $1 AND holder = $2::uuid AND kind = 'background' AND expires_at > now()",
      [input.sandboxSessionId, input.holder],
    );
    return (result.rowCount ?? 0) === 1;
  },

  async release(input: { holder: string; sandboxSessionId: string }): Promise<void> {
    await database().query(
      "DELETE FROM sandbox_browser_holds WHERE sandbox_session_id = $1 AND holder = $2::uuid AND kind = 'background'",
      [input.sandboxSessionId, input.holder],
    );
  },
};
