/**
 * PostgreSQL connection boundary.
 *
 * Exports:
 * - `database`: lazily initialized connection pool.
 * - `closeDatabase`: graceful shutdown helper for scripts and tests.
 */
import { Pool } from "pg";

import { DATABASE_SLOW_QUERY_MS } from "../config.js";
import { traceSlowQueries } from "./pool-trace.js";

let pool: Pool | null = null;

export function database(): Pool {
  // Resolve at first use so Eve discovery and image builds do not require runtime secrets.
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "AGENT_DATABASE_CONFIG_MISSING: Не задано подключение к базе данных",
    );
  }
  pool ??= traceSlowQueries(new Pool({ connectionString, max: 10 }), {
    code: "AGENT_DATABASE_SLOW_QUERY",
    thresholdMs: DATABASE_SLOW_QUERY_MS,
  });
  return pool;
}

export async function closeDatabase(): Promise<void> {
  if (!pool) return;
  await pool.end();
  pool = null;
}
