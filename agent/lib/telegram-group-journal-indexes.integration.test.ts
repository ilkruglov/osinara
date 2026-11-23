/**
 * Indexes and delete actions behind every reference to the chat journal.
 *
 * Constructs covered:
 * - Each foreign key that points at `telegram_group_messages` leads an index. The journal keeps
 *   every entry since 22 November 2026; deleting a group cascades its entries, and for each one
 *   PostgreSQL looks up the rows that point at it. Without an index that is a scan of the whole
 *   table per entry: 10 000 entries in a table of 425 000 took 552 s in review, 0.54 s indexed.
 *   The index must be valid and, if partial, cover every non-null reference.
 * - Each such foreign key has a delete action, so the cascade is never stopped by one.
 * - No two indexes of the journal share their key columns: the retention index of migration 033
 *   (`group_id, sequence_id DESC`) lost its reader with the pruning and copied the unique
 *   `(group_id, sequence_id)`, which the planner scans backward anyway (migration 151).
 */
import { afterAll, describe, expect, it } from "vitest";

import { closeDatabase, database } from "./database.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const describeWithDatabase = enabled ? describe : describe.skip;

describeWithDatabase("chat journal reference indexes", () => {
  afterAll(async () => {
    await closeDatabase();
  });

  it("has an index leading with every column that references a journal entry", async () => {
    const unindexed = await database().query<{ reference: string }>(
      `SELECT format('%s.%s', c.conrelid::regclass, a.attname) AS reference
         FROM pg_constraint c
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
        WHERE c.contype = 'f'
          AND c.confrelid = 'telegram_group_messages'::regclass
          AND NOT EXISTS (
            SELECT 1 FROM pg_index i
             WHERE i.indrelid = c.conrelid AND i.indkey[0] = c.conkey[1] AND i.indisvalid
               AND (i.indpred IS NULL
                    OR pg_get_expr(i.indpred, i.indrelid) = format('(%I IS NOT NULL)', a.attname))
          )
        ORDER BY 1`,
    );
    expect(unindexed.rows).toEqual([]);
  });

  it("keeps no two indexes on the same key columns", async () => {
    const duplicates = await database().query<{ indexes: string }>(
      `SELECT string_agg(indexrelid::regclass::text, ', ' ORDER BY indexrelid::regclass::text)
                AS indexes
         FROM pg_index
        WHERE indrelid = 'telegram_group_messages'::regclass AND indpred IS NULL
        GROUP BY indkey::text
       HAVING count(*) > 1`,
    );
    expect(duplicates.rows).toEqual([]);
  });

  // Removing a group deletes its journal by cascade; a reference without a delete action stopped
  // it with a raw foreign-key error while review or a turn held a message (migration 150).
  it("lets every reference go with the journal entry it points at", async () => {
    const blocking = await database().query<{ reference: string }>(
      `SELECT format('%s.%s', conrelid::regclass, conname) AS reference FROM pg_constraint
        WHERE contype = 'f' AND confrelid = 'telegram_group_messages'::regclass
          AND confdeltype IN ('a', 'r')
        ORDER BY 1`,
    );
    expect(blocking.rows).toEqual([]);
  });
});
