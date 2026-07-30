/**
 * Durable Telegram routes for application-owned sessions.
 *
 * Exports:
 * - `upsertSessionRoute`: transaction-scoped route update used during turn preparation.
 * - `sessionRouteRepository`: resumable lookup, Eve re-key, and out-of-band alias registration.
 */
import type { PoolClient } from "pg";

import { AppError } from "../app-error.js";
import { database } from "../database.js";
import { continuationTokenForGeneration } from "./session-policy.js";

export async function upsertSessionRoute(
  client: PoolClient,
  baseToken: string,
  sessionId: string,
): Promise<void> {
  await client.query(
    `INSERT INTO conversation_session_routes (base_continuation_token, session_id)
     VALUES ($1, $2)
     ON CONFLICT (base_continuation_token) DO UPDATE
       SET session_id = EXCLUDED.session_id, updated_at = now()`,
    [baseToken, sessionId],
  );
}

export const sessionRouteRepository = {
  async hasRoute(baseContinuationToken: string): Promise<boolean> {
    const result = await database().query(
      `SELECT 1
         FROM conversation_session_routes route
         JOIN conversation_sessions session ON session.id = route.session_id
        WHERE route.base_continuation_token = $1
          AND session.retired_at IS NULL
          AND session.eve_session_id IS NOT NULL
        LIMIT 1`,
      [baseContinuationToken],
    );
    return Boolean(result.rowCount);
  },

  async registerRoute(id: string, baseToken: string): Promise<string> {
    const client = await database().connect();
    try {
      await client.query("BEGIN");
      const session = await client.query<{ generation: number; id: string }>(
        "SELECT id, generation FROM conversation_sessions WHERE id = $1 AND retired_at IS NULL FOR UPDATE",
        [id],
      );
      const row = session.rows[0];
      if (!row) throw new AppError("AGENT_SESSION_NOT_ACTIVE", "Текущий контекст уже завершён");
      const token = continuationTokenForGeneration(baseToken, row.generation);
      await client.query(
        "UPDATE conversation_sessions SET continuation_token = $2 WHERE id = $1",
        [id, token],
      );
      await upsertSessionRoute(client, baseToken, id);
      await client.query("COMMIT");
      return token;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },

  async registerRouteAlias(id: string, baseToken: string): Promise<void> {
    // Out-of-band Telegram deliveries can point at an Eve session but cannot re-key Eve itself.
    const result = await database().query(
      `INSERT INTO conversation_session_routes (base_continuation_token, session_id)
       SELECT $2, id FROM conversation_sessions
        WHERE id = $1 AND retired_at IS NULL
       ON CONFLICT (base_continuation_token) DO UPDATE
         SET updated_at = now()
       WHERE conversation_session_routes.session_id = EXCLUDED.session_id`,
      [id, baseToken],
    );
    if (result.rowCount === 1) return;

    // Distinguish a stale session from an alias collision for actionable diagnostics.
    const active = await database().query(
      "SELECT 1 FROM conversation_sessions WHERE id = $1 AND retired_at IS NULL",
      [id],
    );
    if (active.rowCount === 1) {
      throw new AppError(
        "AGENT_SESSION_ROUTE_CONFLICT",
        "Сообщение Telegram уже связано с другим активным контекстом",
      );
    }
    throw new AppError("AGENT_SESSION_NOT_ACTIVE", "Текущий контекст уже завершён");
  },
};
