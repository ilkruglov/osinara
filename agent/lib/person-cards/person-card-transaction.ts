/**
 * One transaction on its own pool connection, for the person card repositories.
 *
 * Export:
 * - `personCardTransaction`: runs `run` between `begin` and COMMIT, rolls back on any error and
 *   always returns the connection; `setup` statements run first inside the transaction.
 */
import type { PoolClient } from "pg";

import { database } from "../database.js";

export async function personCardTransaction<T>(
  run: (client: PoolClient) => Promise<T>,
  options: { begin?: string; setup?: readonly string[] } = {},
): Promise<T> {
  const client = await database().connect();
  try {
    await client.query(options.begin ?? "BEGIN");
    for (const statement of options.setup ?? []) await client.query(statement);
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
