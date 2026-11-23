/**
 * One retry of a whole transaction PostgreSQL aborted to break a deadlock (40P01) or a
 * serialization failure (40001).
 *
 * Exports:
 * - `retryOnTransactionConflict`: runs `run`, and again when it failed with one of those, up to
 *   `attempts` runs (two by default).
 * - `sqlState`: PostgreSQL's SQLSTATE of an error, or null (node-pg names every database error
 *   just "error").
 *
 * Key constructs:
 * - `run` must open, commit or roll back its own transaction: the retry starts it over from the
 *   locks, so nothing of the aborted attempt is left.
 * - Writers of memory records that lock several of them in different orders (a person deleting a
 *   record and its hidden repeats, a person card publish, the undo of its cleanup) can deadlock;
 *   PostgreSQL then aborts one side, and the side it aborts retries.
 */
export async function retryOnTransactionConflict<T>(
  run: () => Promise<T>,
  attempts = 2,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (attempt >= attempts || !isTransactionConflict(error)) throw error;
    }
  }
}

function isTransactionConflict(error: unknown): boolean {
  const state = sqlState(error);
  return state === "40P01" || state === "40001";
}

export function sqlState(error: unknown): string | null {
  return error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[0-9A-Z]{5}$/u.test(error.code)
    ? error.code
    : null;
}
