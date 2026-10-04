/**
 * PostgreSQL connection boundary.
 *
 * Exports:
 * - `database`: lazily initialized connection pool.
 * - `poolConnection`: the connection string and the pgvector session settings every connection starts with.
 * - `closeDatabase`: graceful shutdown helper for scripts and tests.
 */
import { Pool } from "pg";

import { DATABASE_SLOW_QUERY_MS } from "../config.js";
import { traceSlowQueries } from "./pool-trace.js";

let pool: Pool | null = null;

// pgvector's iterative HNSW scan keeps walking the index until a query's LIMIT is met after its
// WHERE filters (an authorized family's chunks among everyone's); without it an index scan stops
// at `hnsw.ef_search` candidates and a filtered query comes back short. The walk itself is
// bounded by `hnsw.max_scan_tuples`: the default of twenty thousand is a few families' worth of
// chunks, so a large installation gets ten times that before the scan gives up (5 October 2026).
const SESSION_SETTINGS = "-c hnsw.iterative_scan=relaxed_order -c hnsw.max_scan_tuples=200000";

/**
 * The pool's connection: node-pg lets an `options` parameter of the URL override the config's
 * `options`, so one in the URL is taken out of it and joined with the session settings.
 */
export function poolConnection(connectionString: string): { connectionString: string; options: string } {
  try {
    const url = new URL(connectionString);
    const fromUrl = url.searchParams.get("options");
    if (fromUrl !== null) {
      url.searchParams.delete("options");
      return { connectionString: url.toString(), options: `${fromUrl} ${SESSION_SETTINGS}` };
    }
  } catch {
    // A libpq-style string without a URL form carries no options to keep.
  }
  return { connectionString, options: SESSION_SETTINGS };
}

export function database(): Pool {
  // Resolve at first use so Eve discovery and image builds do not require runtime secrets.
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "AGENT_DATABASE_CONFIG_MISSING: Не задано подключение к базе данных",
    );
  }
  // Session settings go as a startup option so every pooled connection has them before its
  // first query.
  pool ??= traceSlowQueries(new Pool({ ...poolConnection(connectionString), max: 10 }), {
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
