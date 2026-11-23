/**
 * The migration runner's log of what a data migration did.
 *
 * Constructs covered:
 * - A migration's `RAISE NOTICE` reaches the log under its name once it committed, and marked
 *   rolled back when the migration failed (review of the fixes, 23 November 2026: a count printed
 *   before a failed commit read as done); the runner's own «already exists, skipping» does not.
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterAll, describe, expect, it } from "vitest";

import { closeDatabase, database } from "./database.js";

const execFileAsync = promisify(execFile);
const SCHEMA = "migration_runner_notices";
const enabled = process.env.RUN_DATABASE_INTEGRATION_TESTS === "true";
const databaseUrl = process.env.DATABASE_URL;
// Before any hook: the test drops its schema afterwards, only ever in a *_test database.
if (enabled && (!databaseUrl || !new URL(databaseUrl).pathname.endsWith("_test"))) {
  throw new Error("AGENT_TEST_DATABASE_UNSAFE: Для integration-тестов нужна отдельная БД *_test");
}
const describeWithDatabase = enabled ? describe : describe.skip;

function notices(stdout: string): unknown[] {
  return stdout
    .split("\n")
    .filter((line) => line.includes('"MIGRATION_NOTICE"'))
    .map((line): unknown => JSON.parse(line));
}

describeWithDatabase("migration runner notices", () => {
  afterAll(async () => {
    await database().query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await closeDatabase();
  });

  it("logs a committed migration's notices and marks those of a failed one", async () => {
    await database().query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await database().query(`CREATE SCHEMA ${SCHEMA}`);
    const url = new URL(databaseUrl!);
    url.searchParams.set("options", `-c search_path=${SCHEMA}`);
    const directory = await mkdtemp(join(tmpdir(), "osinara-migrations-"));
    try {
      await writeFile(
        join(directory, "001_counted.sql"),
        "DO $$ BEGIN RAISE NOTICE 'counted 1'; END $$; CREATE TABLE counted (id integer);",
      );
      await writeFile(
        join(directory, "002_failing.sql"),
        "DO $$ BEGIN RAISE NOTICE 'counted 5'; END $$; SELECT 1 / 0;",
      );
      const run = execFileAsync(
        process.execPath,
        ["--experimental-strip-types", "scripts/migrate.ts"],
        {
          cwd: resolve("."),
          env: { ...process.env, DATABASE_URL: url.toString(), MIGRATIONS_DIRECTORY: directory },
        },
      );
      const failure: unknown = await run.then(
        () => null,
        (error: unknown) => error,
      );
      const stdout =
        failure instanceof Error && "stdout" in failure && typeof failure.stdout === "string"
          ? failure.stdout
          : "";
      expect(notices(stdout)).toEqual([
        { code: "MIGRATION_NOTICE", message: "counted 1", migration: "001_counted.sql" },
        {
          code: "MIGRATION_NOTICE",
          message: "counted 5",
          migration: "002_failing.sql",
          rolledBack: true,
        },
      ]);
      const ledger = await database().query<{ name: string }>(
        `SELECT name FROM ${SCHEMA}.schema_migrations ORDER BY name`,
      );
      expect(ledger.rows).toEqual([{ name: "001_counted.sql" }]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
