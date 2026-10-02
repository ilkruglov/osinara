/** PostgreSQL boundary for the removed custom-group-skill feature. */
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, database } from "./database.js";

const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const url = process.env.DATABASE_URL;
if (enabled && (!url || !new URL(url).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const describeWithDatabase = enabled ? describe : describe.skip;

describeWithDatabase("removed Telegram group skill policy", () => {
  beforeEach(async () => {
    await database().query("TRUNCATE telegram_groups, families CASCADE");
  });
  afterAll(closeDatabase);

  it("keeps no per-group skill allowlist at all", async () => {
    // 120 dropped the column 083 had pinned to an empty array: no row can grant a removed package.
    await expect(database().query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'telegram_groups' AND column_name = 'skill_allowlist'`,
    )).resolves.toMatchObject({ rowCount: 0 });
  });
});
